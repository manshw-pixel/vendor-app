import { test, assert, assertDenied, assertInvisible, assertEqual, once } from "./framework.mjs";
import { sql } from "./fixtures.mjs";
import { seedTwoVendors } from "./seed.mjs";

// NOT seeded at import time: run.mjs imports this file before bootstrap() rebuilds the
// schema, so an import-time seed would be dropped. once() defers it to the first test.
const getWorld = once(seedTwoVendors);

const TENANT_TABLES = [
  "vendors", "app_users", "items", "customers",
  "bills", "bill_items", "points_ledger", "stock_requests", "outbound_messages",
];

test("RLS is enabled on every table", async () => {
  await getWorld();
  const { rows } = await sql(
    `select relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind = 'r' and c.relrowsecurity = false`
  );
  assertEqual(rows.map(r => r.relname), [], "these tables have RLS disabled");
});

test("vendor A sees none of vendor B's rows, on any table", async () => {
  const world = await getWorld();
  // Give both worlds a bill, a line, a ledger row and a queued message to see.
  for (const w of [world.a, world.b]) {
    const { rows: [b] } = await sql(
      `insert into bills (vendor_id, customer_id, total, status)
       values ($1,$2,500,'done') returning id`, [w.vendorId, w.customerId]);
    await sql(`insert into bill_items (bill_id, vendor_id, item_id, qty_kg, unit_price, line_total)
               values ($1,$2,$3,2,40,80)`, [b.id, w.vendorId, w.itemId]);
    await sql(`insert into points_ledger (vendor_id, customer_id, bill_id, points, expires_at)
               values ($1,$2,$3,50, now() + interval '30 days')`, [w.vendorId, w.customerId, b.id]);
    await sql(`insert into stock_requests (vendor_id, customer_id, item_name)
               values ($1,$2,'dragonfruit')`, [w.vendorId, w.customerId]);
    await sql(`insert into outbound_messages (vendor_id, customer_id, template_key)
               values ($1,$2,'token_issued')`, [w.vendorId, w.customerId]);
  }

  for (const table of TENANT_TABLES) {
    const col = table === "vendors" ? "id" : "vendor_id";
    const { data, error } = await world.a.clients.admin
      .from(table).select("*").eq(col, world.b.vendorId);
    assert(!error, `${table}: unexpected error ${error?.message}`);
    assertInvisible(data, `${table}: vendor A could see vendor B's rows`);
  }
});

test("vendor A sees its own rows", async () => {
  const world = await getWorld();
  const { data, error } = await world.a.clients.admin.from("items").select("id");
  assert(!error, `unexpected error: ${error?.message}`);
  assert(data.length > 0, "vendor A cannot see its own items");
});

test("vendor A cannot insert a row carrying vendor B's id", async () => {
  const world = await getWorld();
  const { error } = await world.a.clients.admin.from("items").insert({
    vendor_id: world.b.vendorId, name_en: "Smuggled", price: 10, stock_kg: 5,
  });
  assertDenied(error, "vendor A inserted an item into vendor B");
});

test("vendor A cannot update vendor B's item", async () => {
  const world = await getWorld();
  const { data, error } = await world.a.clients.admin
    .from("items").update({ price: 1 }).eq("id", world.b.itemId).select();
  const { rows } = await sql(`select price from items where id = $1`, [world.b.itemId]);
  assertEqual(Number(rows[0].price), 40, "vendor B's price was changed by vendor A");
  assertInvisible(data, "vendor A updated a vendor B row");
});

test("recorder cannot change item prices", async () => {
  const world = await getWorld();
  const { data } = await world.a.clients.recorder
    .from("items").update({ price: 999 }).eq("id", world.a.itemId).select();
  const { rows } = await sql(`select price from items where id = $1`, [world.a.itemId]);
  assertEqual(Number(rows[0].price), 40, "a recorder changed a price");
  assertInvisible(data, "recorder update returned rows");
});

test("biller cannot change item prices", async () => {
  const world = await getWorld();
  const { data } = await world.a.clients.biller
    .from("items").update({ price: 888 }).eq("id", world.a.itemId).select();
  const { rows } = await sql(`select price from items where id = $1`, [world.a.itemId]);
  assertEqual(Number(rows[0].price), 40, "a biller changed a price");
  assertInvisible(data, "biller update returned rows");
});

test("admin can change item prices", async () => {
  const world = await getWorld();
  const { error } = await world.a.clients.admin
    .from("items").update({ price: 45 }).eq("id", world.a.itemId);
  assert(!error, `admin was denied a price update: ${error?.message}`);
  const { rows } = await sql(`select price from items where id = $1`, [world.a.itemId]);
  assertEqual(Number(rows[0].price), 45, "admin price update did not land");
  await sql(`update items set price = 40 where id = $1`, [world.a.itemId]);  // restore
});

test("recorder can create a customer", async () => {
  const world = await getWorld();
  const { error } = await world.a.clients.recorder.from("customers").insert({
    vendor_id: world.a.vendorId, name: "New Cust", flat_no: "B-2", mobile: "+919888800001",
  });
  assert(!error, `recorder could not create a customer: ${error?.message}`);
});

test("no role can write the points ledger directly", async () => {
  const world = await getWorld();
  for (const role of ["admin", "recorder", "biller"]) {
    const { error } = await world.a.clients[role].from("points_ledger").insert({
      vendor_id: world.a.vendorId, customer_id: world.a.customerId,
      points: 10000, expires_at: new Date(Date.now() + 8.64e7).toISOString(),
    });
    assertDenied(error, `${role} forged a points_ledger row`);
  }
});

test("no role can update or delete a points ledger row", async () => {
  const world = await getWorld();
  const { rows: [led] } = await sql(
    `select id from points_ledger where vendor_id = $1 limit 1`, [world.a.vendorId]);
  const { data: updated } = await world.a.clients.admin
    .from("points_ledger").update({ points: 5000 }).eq("id", led.id).select();
  assertInvisible(updated, "a ledger row was updated");
  const { data: deleted } = await world.a.clients.admin
    .from("points_ledger").delete().eq("id", led.id).select();
  assertInvisible(deleted, "a ledger row was deleted");
});

test("no role can write vendor_counters directly", async () => {
  const world = await getWorld();
  for (const role of ["admin", "recorder", "biller"]) {
    const { data } = await world.a.clients[role]
      .from("vendor_counters").update({ last_token: 9999 })
      .eq("vendor_id", world.a.vendorId).select();
    assertInvisible(data, `${role} rewrote the token counter`);
  }
});

test("recorder cannot append a bill_items row once the bill is billed", async () => {
  const world = await getWorld();
  const { rows: [b] } = await sql(
    `insert into bills (vendor_id, customer_id, total, status)
     values ($1,$2,100,'billed') returning id`, [world.a.vendorId, world.a.customerId]);
  const { error } = await world.a.clients.recorder.from("bill_items").insert({
    bill_id: b.id, vendor_id: world.a.vendorId, item_id: world.a.itemId,
    qty_kg: 1, unit_price: 40, line_total: 40,
  });
  assertDenied(error, "a recorder added a line to an already-billed bill");
});

test("an anonymous client sees nothing", async () => {
  const world = await getWorld();
  const { newClient } = await import("./fixtures.mjs");
  const anon = await newClient();
  for (const table of TENANT_TABLES) {
    const { data } = await anon.from(table).select("*");
    assertInvisible(data, `${table}: anonymous read returned rows`);
  }
});
