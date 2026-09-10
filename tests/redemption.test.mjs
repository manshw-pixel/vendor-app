import { test, assert, assertEqual, once } from "./framework.mjs";
import { sql } from "./fixtures.mjs";
import { seedTwoVendors } from "./seed.mjs";

const getWorld = once(seedTwoVendors);

/**
 * A vendor with one item, one customer and one `billed` bill of the given total.
 * Mirrors complete_bill.test.mjs's billedBill(): its own vendor per case, so stock and
 * ledger assertions are never polluted by a neighbour.
 */
async function billedBill({ total, stockKg = 100, qtyKg = 5, vendorOverrides = {} }) {
  const { rows: [v] } = await sql(`insert into vendors (name) values ('Redeem Co') returning id`);
  for (const [col, val] of Object.entries(vendorOverrides)) {
    await sql(`update vendors set ${col} = $1 where id = $2`, [val, v.id]);
  }
  const { rows: [c] } = await sql(
    `insert into customers (vendor_id, name, flat_no, mobile)
     values ($1,'RC','E-1', '+91955550' || floor(random()*10000)::text) returning id`, [v.id]);
  const { rows: [i] } = await sql(
    `insert into items (vendor_id, name_en, price, stock_kg) values ($1,'Onion',40,$2) returning id`,
    [v.id, stockKg]);
  const { rows: [b] } = await sql(
    `insert into bills (vendor_id, customer_id, total, status)
     values ($1,$2,$3,'recording') returning id`, [v.id, c.id, total]);
  await sql(`insert into bill_items (bill_id, vendor_id, item_id, qty_kg, unit_price, line_total)
             values ($1,$2,$3,$4,40,$5)`, [b.id, v.id, i.id, qtyKg, total]);
  await sql(`select issue_token($1)`, [b.id]);
  return { vendorId: v.id, customerId: c.id, billId: b.id };
}

/** Gives a customer a batch of points expiring in `inDays`. */
const grant = (w, points, inDays) => sql(
  `insert into points_ledger (vendor_id, customer_id, points, expires_at)
   values ($1,$2,$3, now() + ($4 || ' days')::interval)`,
  [w.vendorId, w.customerId, points, String(inDays)]);

/** The balance exactly as the app computes it. */
const balance = async (customerId) => {
  const { rows: [r] } = await sql(`select * from customer_points_balance($1)`, [customerId]);
  return r.balance;
};

const billRow = async (billId) => {
  const { rows: [r] } = await sql(`select total, redeemed_points, status from bills where id = $1`,
    [billId]);
  return r;
};

test("redeeming subtracts from the bill and from the balance", async () => {
  const w = await billedBill({ total: 500 });
  await grant(w, 100, 30);

  await sql(`select complete_bill($1, null, $2)`, [w.billId, 40]);

  const b = await billRow(w.billId);
  assertEqual(Number(b.total), 460, "the bill should record the net actually collected");
  assertEqual(b.redeemed_points, 40, "the bill should record what was applied");
  assertEqual(await balance(w.customerId), 60, "the balance should drop by what was spent");
});

test("a redemption row expires WITH the points it consumed, not later", async () => {
  // THE test for this feature. A redemption row given its own future expiry drops out of
  // the balance sum when it passes and silently REFUNDS the spent points. The existing
  // redemption case in points_balance.test.mjs cannot catch this: it never advances time.
  //
  // Granted at 10 days, not 30: vendors.redeem_days defaults to 30, so a redemption row
  // mistakenly written as `now() + redeem_days` (the pattern the award insert two dozen
  // lines below actually uses) would land on the same expiry as a 30-day batch and pass
  // this test on the very bug it exists to catch. 10 days can't coincide with that default.
  // The direct equality assertion below is the real guard either way -- it can't be fooled
  // by any arithmetic coincidence -- but the grant is chosen to not rely on that alone.
  const w = await billedBill({ total: 500 });
  await grant(w, 100, 10);

  await sql(`select complete_bill($1, null, $2)`, [w.billId, 40]);
  assertEqual(await balance(w.customerId), 60, "precondition: 60 left before expiry");

  const { rows: [batch] } = await sql(
    `select expires_at from points_ledger where customer_id = $1 and points > 0`,
    [w.customerId]);
  const { rows: [redemption] } = await sql(
    `select expires_at from points_ledger where customer_id = $1 and points < 0`,
    [w.customerId]);
  assertEqual(redemption.expires_at.getTime(), batch.expires_at.getTime(),
    "the redemption row must inherit the batch's own expiry, not a fresh one");

  // Move every one of this customer's ledger rows into the past by 11 days, which is what
  // the passage of time does to them. The earned batch and its redemption must leave the
  // sum together.
  await sql(`update points_ledger set expires_at = expires_at - interval '11 days'
              where customer_id = $1`, [w.customerId]);

  assertEqual(await balance(w.customerId), 0,
    "after the batch expired the balance must be 0 -- not 40 (refunded) and not -40");
});

test("a redemption never drives the balance negative once the batch expires", async () => {
  // The opposite failure to the one above: a redemption row with no expiry (or a far one)
  // outlives the batch it was spent from, and the customer ends up owing points.
  const w = await billedBill({ total: 500 });
  await grant(w, 100, 30);
  await sql(`select complete_bill($1, null, $2)`, [w.billId, 100]);
  assertEqual(await balance(w.customerId), 0, "precondition: fully spent");

  await sql(`update points_ledger set expires_at = expires_at - interval '31 days'
              where customer_id = $1`, [w.customerId]);

  assertEqual(await balance(w.customerId), 0, "the balance must not go negative");
});

test("redemption consumes the soonest-expiring points first, across batches", async () => {
  const w = await billedBill({ total: 500 });
  await grant(w, 100, 10);   // expires first
  await grant(w, 50, 60);

  await sql(`select complete_bill($1, null, $2)`, [w.billId, 120]);

  assertEqual(await balance(w.customerId), 30, "150 granted minus 120 spent");

  // Two negative rows, one per bucket consumed, each carrying that bucket's expiry.
  // Tiebreak by earned_at, id: if a wrong implementation left both rows sharing one
  // timestamp, ordering by expires_at alone would make rows[0] arbitrary and this
  // assertion nondeterministic instead of reliably failing.
  const { rows } = await sql(
    `select points, expires_at from points_ledger
      where customer_id = $1 and points < 0 order by expires_at, earned_at, id`, [w.customerId]);
  assertEqual(rows.length, 2, "should write one negative row per bucket consumed");
  assertEqual(rows[0].points, -100, "the soonest bucket should be drained first");
  assertEqual(rows[1].points, -20, "the remainder comes from the later bucket");
});

test("the sooner batch expiring leaves exactly the later batch's remainder", async () => {
  // Proves the pairing holds per bucket, not just in aggregate: after the 10-day batch and
  // its -100 both lapse, what is left is 50 - 20 from the 60-day batch.
  const w = await billedBill({ total: 500 });
  await grant(w, 100, 10);
  await grant(w, 50, 60);
  await sql(`select complete_bill($1, null, $2)`, [w.billId, 120]);

  await sql(`update points_ledger set expires_at = expires_at - interval '11 days'
              where customer_id = $1`, [w.customerId]);

  assertEqual(await balance(w.customerId), 30, "only the later bucket's remainder survives");
});

test("redeeming more than the balance applies only what the customer has", async () => {
  // Clamped, not refused: a customer misremembering their balance must not fail the sale.
  const w = await billedBill({ total: 500 });
  await grant(w, 30, 30);

  await sql(`select complete_bill($1, null, $2)`, [w.billId, 200]);

  const b = await billRow(w.billId);
  assertEqual(b.redeemed_points, 30, "only the 30 they had");
  assertEqual(Number(b.total), 470, "and the bill reflects exactly that");
  assertEqual(await balance(w.customerId), 0, "spent down to nothing, never below");
});

test("redeeming more than the bill applies only what the bill can absorb", async () => {
  const w = await billedBill({ total: 100 });
  await grant(w, 500, 30);

  await sql(`select complete_bill($1, null, $2)`, [w.billId, 500]);

  const b = await billRow(w.billId);
  assertEqual(b.redeemed_points, 100, "capped at the bill");
  assertEqual(Number(b.total), 0, "a bill can be paid entirely in points");
  assertEqual(await balance(w.customerId), 400, "the rest stays with the customer");
});

test("a part-rupee bill absorbs only whole points", async () => {
  // total >= 0 is a check constraint on bills; floor() is what keeps the cap from
  // violating it, so the two must not drift apart.
  const w = await billedBill({ total: 99.5 });
  await grant(w, 500, 30);

  await sql(`select complete_bill($1, null, $2)`, [w.billId, 500]);

  const b = await billRow(w.billId);
  assertEqual(b.redeemed_points, 99, "99 whole points, not 99.5");
  assertEqual(Number(b.total), 0.5, "half a rupee still to pay");
});

test("points are earned on what was paid, not on the bill before redemption", async () => {
  // Thresholds 600/50 and 1000/100 are the vendor defaults. A 620 bill with 40 redeemed
  // pays 580, which is under the first threshold: it must earn nothing. Awarding on the
  // gross would let a customer redeem to stay above a threshold and earn repeatedly on
  // money they never paid.
  const w = await billedBill({ total: 620 });
  await grant(w, 40, 30);

  await sql(`select complete_bill($1, null, $2)`, [w.billId, 40]);

  const { rows: [r] } = await sql(
    `select coalesce(sum(points),0)::int as p from points_ledger
      where bill_id = $1 and points > 0`, [w.billId]);
  assertEqual(r.p, 0, "580 paid is under the 600 threshold, so nothing is earned");
});

test("a bill that still clears the threshold after redeeming does earn", async () => {
  // The other half of the rule, so the test above is not passing for the trivial reason
  // that redemption suppresses points entirely.
  const w = await billedBill({ total: 700 });
  await grant(w, 40, 30);

  await sql(`select complete_bill($1, null, $2)`, [w.billId, 40]);

  const { rows: [r] } = await sql(
    `select coalesce(sum(points),0)::int as p from points_ledger
      where bill_id = $1 and points > 0`, [w.billId]);
  assertEqual(r.p, 50, "660 paid still clears 600, so the first tier is earned");
});

test("completing an already-done bill again does not redeem twice", async () => {
  // complete_bill is idempotent by guard, and that guard is what makes a retried request
  // (double tap, network retry) safe now that money is involved.
  const w = await billedBill({ total: 500 });
  await grant(w, 100, 30);

  await sql(`select complete_bill($1, null, $2)`, [w.billId, 40]);
  const after = await balance(w.customerId);

  await sql(`select complete_bill($1, null, $2)`, [w.billId, 40]);

  assertEqual(await balance(w.customerId), after, "the second call must change nothing");
  assertEqual((await billRow(w.billId)).redeemed_points, 40, "and must not double the record");
});

test("redeeming zero leaves the ledger untouched", async () => {
  const w = await billedBill({ total: 500 });
  await grant(w, 100, 30);

  await sql(`select complete_bill($1)`, [w.billId]);

  assertEqual(await balance(w.customerId), 100, "nothing spent");
  const { rows } = await sql(
    `select count(*)::int as n from points_ledger where customer_id = $1 and points < 0`,
    [w.customerId]);
  assertEqual(rows[0].n, 0, "no negative row should be written for a zero redemption");
});

test("a bill with no customer cannot redeem", async () => {
  // bills.customer_id is nullable -- a walk-in has no loyalty account to spend from.
  const { rows: [v] } = await sql(`insert into vendors (name) values ('Walkin Co') returning id`);
  const { rows: [i] } = await sql(
    `insert into items (vendor_id, name_en, price, stock_kg) values ($1,'Onion',40,100) returning id`,
    [v.id]);
  const { rows: [b] } = await sql(
    `insert into bills (vendor_id, total, status) values ($1,500,'recording') returning id`, [v.id]);
  await sql(`insert into bill_items (bill_id, vendor_id, item_id, qty_kg, unit_price, line_total)
             values ($1,$2,$3,5,40,500)`, [b.id, v.id, i.id]);
  await sql(`select issue_token($1)`, [b.id]);

  await sql(`select complete_bill($1, null, $2)`, [b.id, 40]);

  const { rows: [r] } = await sql(`select total, redeemed_points from bills where id = $1`, [b.id]);
  assertEqual(Number(r.total), 500, "nothing to redeem against, so the full total stands");
  assertEqual(r.redeemed_points, 0, "and nothing is recorded as redeemed");
});

test("a recorder still cannot complete a bill, redemption or not", async () => {
  // The role guard predates this feature and must survive it: complete_bill is admin or
  // biller only.
  const world = await getWorld();
  const w = await billedBill({ total: 500 });
  await grant(w, 100, 30);
  await sql(`update app_users set vendor_id = $1 where id = $2`,
    [w.vendorId, world.a.recorderId]);

  const { error } = await world.a.clients.recorder
    .rpc("complete_bill", { p_bill_id: w.billId, p_redeem_points: 40 });
  assert(error, "a recorder must not be able to complete a sale");
  // Match the specific role-refusal message, not just any error: an overload ambiguity or
  // a stale PostgREST schema cache also surfaces as an error (e.g. "function not found")
  // and would satisfy a bare assert(error) identically to a genuine role refusal -- exactly
  // the failure mode the migration's `drop function` comment exists to prevent.
  assert(/may not complete bills/i.test(error.message),
    `expected a role-refusal error, got: ${error.message}`);

  assertEqual(await balance(w.customerId), 100, "and must not have spent anything");
});
