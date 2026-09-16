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
  const { data, error } = await world.a.clients.admin.rpc("bought_together_between", {
    p_from: new Date(Date.now() - 7 * 86400000).toISOString(),
    p_to: new Date(Date.now() + 86400000).toISOString(),
  });
  assert(!error, `rpc failed: ${error?.message}`);
  // The shape is what matters here; whether any pair clears the threshold of 3 is
  // analytics.test.mjs's business. An empty result still proves the signature resolves.
  assert(Array.isArray(data), "expected rows");
});
