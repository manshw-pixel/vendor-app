import { test, assert, assertDenied, assertInvisible, assertEqual, once } from "./framework.mjs";
import { sql, newClient } from "./fixtures.mjs";
import { seedTwoVendors } from "./seed.mjs";

// NOT seeded at import time: run.mjs imports this file before bootstrap() rebuilds the
// schema, so an import-time seed would be dropped. once() defers it to the first test.
const getWorld = once(seedTwoVendors);

test("a recorder may log a stock request", async () => {
  const world = await getWorld();
  const { error } = await world.a.clients.recorder
    .from("stock_requests")
    .insert({ vendor_id: world.a.vendorId, item_name: "dragon fruit" });
  assert(!error, `recorder insert was refused: ${error?.message}`);
});

test("an admin may log a stock request", async () => {
  const world = await getWorld();
  const { error } = await world.a.clients.admin
    .from("stock_requests")
    .insert({ vendor_id: world.a.vendorId, item_name: "kiwi" });
  assert(!error, `admin insert was refused: ${error?.message}`);
});

test("a biller may not log a stock request", async () => {
  const world = await getWorld();
  const { error } = await world.a.clients.biller
    .from("stock_requests")
    .insert({ vendor_id: world.a.vendorId, item_name: "avocado" });
  assertDenied(error, "a biller was allowed to log a stock request");
});

test("a recorder may not log a request into another vendor", async () => {
  const world = await getWorld();
  const { error } = await world.a.clients.recorder
    .from("stock_requests")
    .insert({ vendor_id: world.b.vendorId, item_name: "papaya" });
  assertDenied(error, "vendor A wrote a stock request into vendor B");
});

test("a blank item name is rejected", async () => {
  const world = await getWorld();
  const { error } = await world.a.clients.recorder
    .from("stock_requests")
    .insert({ vendor_id: world.a.vendorId, item_name: "   " });
  assertDenied(error, "a whitespace-only item name was accepted");
});

test("a new request starts open", async () => {
  const world = await getWorld();
  const { data, error } = await world.a.clients.recorder
    .from("stock_requests")
    .insert({ vendor_id: world.a.vendorId, item_name: "lychee" })
    .select("status");
  assert(!error, `insert failed: ${error?.message}`);
  assertEqual(data[0].status, "open", "a new request should default to open");
});

test("a recorder may mark a request handled", async () => {
  const world = await getWorld();
  const { data: made } = await world.a.clients.recorder
    .from("stock_requests")
    .insert({ vendor_id: world.a.vendorId, item_name: "rambutan" })
    .select("id");

  const { data, error } = await world.a.clients.recorder
    .from("stock_requests")
    .update({ status: "handled" })
    .eq("id", made[0].id)
    .select("status");
  assert(!error, `update was refused: ${error?.message}`);
  assertEqual(data[0].status, "handled", "status did not flip");
});

test("an unknown status is rejected", async () => {
  const world = await getWorld();
  const { data: made } = await world.a.clients.recorder
    .from("stock_requests")
    .insert({ vendor_id: world.a.vendorId, item_name: "durian" })
    .select("id");

  const { error } = await world.a.clients.recorder
    .from("stock_requests")
    .update({ status: "done" })
    .eq("id", made[0].id);
  assertDenied(error, "an unconstrained status value was accepted");
});

// Dropping stock_requests_admin_delete is a deliberate behaviour change: deleting rows
// destroys the demand history that v_stock_request_counts and #10 exist to report.
test("an admin may no longer delete a request", async () => {
  const world = await getWorld();
  const { data: made } = await world.a.clients.recorder
    .from("stock_requests")
    .insert({ vendor_id: world.a.vendorId, item_name: "mangosteen" })
    .select("id");

  await world.a.clients.admin.from("stock_requests").delete().eq("id", made[0].id);

  const { data, error } = await world.a.clients.admin
    .from("stock_requests").select("id").eq("id", made[0].id);
  assert(!error, `unexpected error: ${error?.message}`);
  assertEqual(data.length, 1, "the row was deleted; the delete policy should be gone");
});

test("stock_requests_between counts, orders, and respects its date bounds", async () => {
  const world = await getWorld();
  const vid = world.a.vendorId;
  // Two rows for 'beetroot', one for 'turnip', all inside the window.
  await sql(`insert into stock_requests (vendor_id, item_name, created_at)
             values ($1,'beetroot', now() - interval '2 days'),
                    ($1,'Beetroot', now() - interval '1 day'),
                    ($1,'turnip',   now() - interval '1 day')`, [vid]);
  // One well outside it, which must not be counted.
  await sql(`insert into stock_requests (vendor_id, item_name, created_at)
             values ($1,'beetroot', now() - interval '90 days')`, [vid]);

  const { data, error } = await world.a.clients.admin.rpc("stock_requests_between", {
    p_from: new Date(Date.now() - 7 * 86400000).toISOString(),
    p_to: new Date(Date.now() + 86400000).toISOString(),
  });
  assert(!error, `rpc failed: ${error?.message}`);

  const beet = data.find((r) => r.item_name === "beetroot");
  assert(beet, "beetroot missing from the result");
  // Case is folded, so 'beetroot' and 'Beetroot' are one row -- and the 90-day-old row
  // is outside the window. bigint arrives as a string; coerce before comparing.
  assertEqual(Number(beet.request_count), 2, "beetroot count is wrong");
  assertEqual(data[0].item_name, "beetroot", "results are not ordered by count desc");
});

test("stock_requests_between does not leak across vendors", async () => {
  const world = await getWorld();
  await sql(`insert into stock_requests (vendor_id, item_name) values ($1,'vendor-b-only-fruit')`,
    [world.b.vendorId]);

  const { data, error } = await world.a.clients.admin.rpc("stock_requests_between", {
    p_from: new Date(Date.now() - 7 * 86400000).toISOString(),
    p_to: new Date(Date.now() + 86400000).toISOString(),
  });
  assert(!error, `rpc failed: ${error?.message}`);
  assertEqual(
    data.filter((r) => r.item_name === "vendor-b-only-fruit"),
    [],
    "vendor A saw vendor B's stock requests",
  );
});

test("stock_requests_between still counts a request marked handled", async () => {
  const world = await getWorld();
  const vid = world.a.vendorId;
  // Deliberate per 0013's comment: handling a request does not un-ask it, and #10 is
  // demand history, not a live worklist. A future "helpful" `and status = 'open'` filter
  // on the function would break this silently -- lock the behaviour in.
  const { data: made } = await world.a.clients.recorder
    .from("stock_requests")
    .insert({ vendor_id: vid, item_name: "jabuticaba" })
    .select("id");
  await world.a.clients.recorder
    .from("stock_requests")
    .update({ status: "handled" })
    .eq("id", made[0].id);

  const { data, error } = await world.a.clients.admin.rpc("stock_requests_between", {
    p_from: new Date(Date.now() - 7 * 86400000).toISOString(),
    p_to: new Date(Date.now() + 86400000).toISOString(),
  });
  assert(!error, `rpc failed: ${error?.message}`);
  const row = data.find((r) => r.item_name === "jabuticaba");
  assert(row, "a handled request was excluded from demand history");
  assertEqual(Number(row.request_count), 1, "the handled request was not counted");
});

test("an anonymous client sees no stock requests", async () => {
  const world = await getWorld();
  await sql(`insert into stock_requests (vendor_id, item_name) values ($1,'anon-check')`,
    [world.a.vendorId]);
  // newClient() with no sign-in IS the anon client -- same idiom as rls.test.mjs:157.
  const anon = await newClient();
  const { data } = await anon.from("stock_requests").select("*");
  assertInvisible(data, "an anon client could read stock requests");
});

test("bought_together_between returns all three names per side", async () => {
  const world = await getWorld();
  const vid = world.a.vendorId;
  // A qualifying pair needs its own items (all three names set, unlike the plain 'Onion
  // A1' seedTwoVendors() gives every vendor) and three done bills co-occurring inside the
  // window -- otherwise this can pass on an empty result and never touch the six name
  // columns the i18n fix added. See analytics.test.mjs's windowedVendor() for the pattern.
  const { rows: [ia] } = await sql(
    `insert into items (vendor_id, name_en, name_hi, name_mr, price, stock_kg)
     values ($1,'Guava','Guava-hi','Guava-mr',50,100) returning id`, [vid]);
  const { rows: [ib] } = await sql(
    `insert into items (vendor_id, name_en, name_hi, name_mr, price, stock_kg)
     values ($1,'Fig','Fig-hi','Fig-mr',50,100) returning id`, [vid]);
  for (let n = 0; n < 3; n++) {
    const { rows: [b] } = await sql(
      `insert into bills (vendor_id, customer_id, total, status, completed_at)
       values ($1,$2,100,'done',now()) returning id`, [vid, world.a.customerId]);
    await sql(
      `insert into bill_items (bill_id, vendor_id, item_id, qty_kg, unit_price, line_total)
       values ($1,$2,$3,2,50,100), ($1,$2,$4,2,50,100)`, [b.id, vid, ia.id, ib.id]);
  }

  const { data, error } = await world.a.clients.admin.rpc("bought_together_between", {
    p_from: new Date(Date.now() - 7 * 86400000).toISOString(),
    p_to: new Date(Date.now() + 86400000).toISOString(),
  });
  assert(!error, `rpc failed: ${error?.message}`);

  // a.item_id < b.item_id decides which side each item lands on, so read whichever of
  // the two rows carries this pair and check both sides regardless of order.
  const row = data.find((r) => [r.item_a, r.item_b].sort().join() === [ia.id, ib.id].sort().join());
  assert(row, "the guava/fig pair is missing from the result");
  const names = row.item_a === ia.id
    ? { aEn: row.name_a_en, aHi: row.name_a_hi, aMr: row.name_a_mr,
        bEn: row.name_b_en, bHi: row.name_b_hi, bMr: row.name_b_mr }
    : { aEn: row.name_b_en, aHi: row.name_b_hi, aMr: row.name_b_mr,
        bEn: row.name_a_en, bHi: row.name_a_hi, bMr: row.name_a_mr };
  assertEqual(names.aEn, "Guava", "name_*_en missing for item A");
  assertEqual(names.aHi, "Guava-hi", "name_*_hi missing for item A -- the i18n fix regressed");
  assertEqual(names.aMr, "Guava-mr", "name_*_mr missing for item A -- the i18n fix regressed");
  assertEqual(names.bEn, "Fig", "name_*_en missing for item B");
  assertEqual(names.bHi, "Fig-hi", "name_*_hi missing for item B -- the i18n fix regressed");
  assertEqual(names.bMr, "Fig-mr", "name_*_mr missing for item B -- the i18n fix regressed");
});
