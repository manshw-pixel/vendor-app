import { test, assert, assertEqual, once } from "./framework.mjs";
import { sql, newClient } from "./fixtures.mjs";
import { seedTwoVendors } from "./seed.mjs";

// NOT seeded at import time: run.mjs imports this file before bootstrap() rebuilds the
// schema, so an import-time seed would be dropped.
const getWorld = once(seedTwoVendors);

/**
 * Gives a vendor one of everything clear_vendor_data() is supposed to remove, so a test
 * asserting "gone" is asserting against rows that actually existed first. Returns the
 * bill id, since two of the tables hang off it.
 *
 * Creates its OWN customer rather than reusing the seeded one, and takes token numbers
 * from a counter rather than a literal. Both are because the seeded world is shared across
 * this file's tests and the thing under test DELETES from it: the first passing clear
 * removes w.customerId, so a later populate reusing it fails the bills FK, and the two
 * refusal tests leave their bills in place, so a fixed token_no collides with
 * unique (vendor_id, token_no).
 */
let seq = 0;

async function populate(w) {
  const n = ++seq;
  const { rows: [c] } = await sql(
    `insert into customers (vendor_id, name, flat_no, mobile) values ($1,$2,$3,$4) returning id`,
    [w.vendorId, `Clear ${n}`, `C-${n}`, `+9188888${String(n).padStart(5, "0")}`]);
  const customerId = c.id;
  const { rows: [b] } = await sql(
    `insert into bills (vendor_id, customer_id, total, status, token_no)
     values ($1,$2,500,'done',$3) returning id`, [w.vendorId, customerId, n]);
  await sql(`insert into bill_items (bill_id, vendor_id, item_id, qty_kg, unit_price, line_total)
             values ($1,$2,$3,2,40,80)`, [b.id, w.vendorId, w.itemId]);
  await sql(`insert into points_ledger (vendor_id, customer_id, bill_id, points, expires_at)
             values ($1,$2,$3,50, now() + interval '30 days')`, [w.vendorId, customerId, b.id]);
  await sql(`insert into stock_requests (vendor_id, customer_id, item_name)
             values ($1,$2,'dragonfruit')`, [w.vendorId, customerId]);
  await sql(`insert into outbound_messages (vendor_id, customer_id, template_key)
             values ($1,$2,'token_issued')`, [w.vendorId, customerId]);
  return b.id;
}

const countFor = async (table, vendorId) => {
  const { rows: [r] } = await sql(`select count(*)::int as n from ${table} where vendor_id = $1`,
    [vendorId]);
  return r.n;
};

test("clear_vendor_data removes every transactional row for the caller's vendor", async () => {
  const world = await getWorld();
  await populate(world.a);

  const { error } = await world.a.clients.admin.rpc("clear_vendor_data");
  assert(!error, `rpc failed: ${error && error.message}`);

  for (const t of ["bills", "bill_items", "points_ledger", "stock_requests",
                   "outbound_messages", "customers"]) {
    assertEqual(await countFor(t, world.a.vendorId), 0, `${t} should be empty`);
  }
});

test("clear_vendor_data touches NOTHING belonging to another vendor", async () => {
  // The catastrophic, silent failure this function could have: a missing vendor_id
  // predicate on any one of six deletes wipes another shop's entire history with no
  // error. Everything else in this file is secondary to this.
  const world = await getWorld();
  await populate(world.b);
  const before = {};
  for (const t of ["bills", "bill_items", "points_ledger", "stock_requests",
                   "outbound_messages", "customers"]) {
    before[t] = await countFor(t, world.b.vendorId);
    assert(before[t] > 0, `precondition: vendor B should have ${t} rows to lose`);
  }

  await world.a.clients.admin.rpc("clear_vendor_data");

  for (const t of Object.keys(before)) {
    assertEqual(await countFor(t, world.b.vendorId), before[t],
      `vendor B's ${t} rows were destroyed by vendor A's clear`);
  }
});

test("clear_vendor_data keeps items and staff", async () => {
  // The catalogue and the roster are real work to enter and are not transactional data.
  // Deleting staff would also lock the vendor out: users_admin_write needs an admin.
  const world = await getWorld();
  await populate(world.a);
  const items = await countFor("items", world.a.vendorId);
  const staff = await countFor("app_users", world.a.vendorId);
  assert(items > 0 && staff > 0, "precondition: vendor A has items and staff");

  await world.a.clients.admin.rpc("clear_vendor_data");

  assertEqual(await countFor("items", world.a.vendorId), items, "items were deleted");
  assertEqual(await countFor("app_users", world.a.vendorId), staff, "staff were deleted");
});

test("clear_vendor_data resets the token counter so numbering restarts at 1", async () => {
  // unique (vendor_id, token_no) is what makes this safe: with the bills gone there is
  // nothing left for a reissued token 1 to collide with. Leaving the counter at 57 would
  // make a "cleared" shop start its next day at token 58.
  const world = await getWorld();
  await populate(world.a);
  await sql(`update vendor_counters set last_token = 57 where vendor_id = $1`, [world.a.vendorId]);

  await world.a.clients.admin.rpc("clear_vendor_data");

  const { rows: [c] } = await sql(
    `select last_token from vendor_counters where vendor_id = $1`, [world.a.vendorId]);
  assertEqual(c.last_token, 0, "the counter should be back to zero");
});

test("clear_vendor_data refuses a recorder", async () => {
  const world = await getWorld();
  await populate(world.a);

  const { error } = await world.a.clients.recorder.rpc("clear_vendor_data");
  assert(error, "a recorder must not be able to wipe the shop");

  assert(await countFor("bills", world.a.vendorId) > 0, "the bills should still be there");
});

test("clear_vendor_data refuses a biller", async () => {
  const world = await getWorld();
  await populate(world.a);

  const { error } = await world.a.clients.biller.rpc("clear_vendor_data");
  assert(error, "a biller must not be able to wipe the shop");

  assert(await countFor("bills", world.a.vendorId) > 0, "the bills should still be there");
});

test("clear_vendor_data refuses a caller with no session", async () => {
  // Unlike issue_token/complete_bill, a null current_vendor_id() is NOT waved through
  // here: those act on a bill that names its own tenant, so a service-role caller is
  // unambiguous. This one scopes every delete by the CALLER's vendor, and a null there
  // would either delete nothing or -- with a predicate bug -- everything.
  const world = await getWorld();
  await populate(world.a);

  // A FRESH anon client rather than signing the shared admin one out: these tests share
  // one seeded world, and a sign-out would leave every later test in this file calling as
  // anon -- which reads as a permission failure in whichever test happens to run next.
  const anon = await newClient();
  const { error } = await anon.rpc("clear_vendor_data");
  assert(error, "an anonymous caller must not be able to wipe anything");

  assert(await countFor("bills", world.a.vendorId) > 0, "the bills should still be there");
});

test("clear_vendor_data empties a bill that redeemed points, ledger and all", async () => {
  // Redemption (0010) writes points_ledger rows this file's populate() never produces:
  // an award (positive) row from completing the bill, plus one or more negative rows for
  // what was spent, and it sets bills.redeemed_points. The reviewer confirmed by reading
  // that clear_vendor_data's six deletes still reach all of that -- this pins it so a
  // future change to either function can't quietly stop being true.
  const world = await getWorld();
  const n = ++seq;
  const { rows: [c] } = await sql(
    `insert into customers (vendor_id, name, flat_no, mobile) values ($1,$2,$3,$4) returning id`,
    [world.a.vendorId, `Redeem ${n}`, `R-${n}`, `+9187777${String(n).padStart(5, "0")}`]);
  const { rows: [b] } = await sql(
    `insert into bills (vendor_id, customer_id, total, status)
     values ($1,$2,500,'recording') returning id`, [world.a.vendorId, c.id]);
  await sql(`insert into bill_items (bill_id, vendor_id, item_id, qty_kg, unit_price, line_total)
             values ($1,$2,$3,5,40,500)`, [b.id, world.a.vendorId, world.a.itemId]);
  await sql(`select issue_token($1)`, [b.id]);
  await sql(`insert into points_ledger (vendor_id, customer_id, points, expires_at)
             values ($1,$2,100, now() + interval '30 days')`, [world.a.vendorId, c.id]);

  await sql(`select complete_bill($1, null, $2)`, [b.id, 40]);
  const { rows: [row] } = await sql(`select redeemed_points from bills where id = $1`, [b.id]);
  assertEqual(row.redeemed_points, 40, "precondition: the bill actually redeemed points");
  const { rows: [ledgerBefore] } = await sql(
    `select count(*)::int as n from points_ledger where customer_id = $1`, [c.id]);
  assert(ledgerBefore.n >= 2, "precondition: the award and the redemption both landed");

  const { error } = await world.a.clients.admin.rpc("clear_vendor_data");
  assert(!error, `rpc failed: ${error && error.message}`);

  for (const t of ["bills", "bill_items", "points_ledger", "stock_requests",
                   "outbound_messages", "customers"]) {
    assertEqual(await countFor(t, world.a.vendorId), 0, `${t} should be empty`);
  }
});

test("clear_vendor_data reports what it actually deleted", async () => {
  // The UI shows these back to the admin. For an action with no undo, "deleted 4 bills and
  // 4 customers" is the difference between confirming the scope was what they meant and
  // hoping it was. Compared against a snapshot rather than a literal: the three refusal
  // tests above deliberately leave their rows in place, so vendor A's counts here are
  // whatever those left behind -- and a report that only matches a hardcoded number would
  // be testing the fixture, not the function.
  const world = await getWorld();
  await populate(world.a);
  const before = {
    bills: await countFor("bills", world.a.vendorId),
    customers: await countFor("customers", world.a.vendorId),
    points_rows: await countFor("points_ledger", world.a.vendorId),
  };
  assert(before.bills > 0, "precondition: there is something to delete");

  const { data, error } = await world.a.clients.admin.rpc("clear_vendor_data");
  assert(!error, `rpc failed: ${error && error.message}`);

  const row = Array.isArray(data) ? data[0] : data;
  assertEqual(row.bills, before.bills, "reported bill count does not match what was there");
  assertEqual(row.customers, before.customers, "reported customer count does not match");
  assertEqual(row.points_rows, before.points_rows, "reported ledger count does not match");
});
