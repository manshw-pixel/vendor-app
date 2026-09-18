import { test, assert, assertDenied, assertInvisible, assertEqual, once } from "./framework.mjs";
import { sql, newClient } from "./fixtures.mjs";
import { seedTwoVendors } from "./seed.mjs";

// Not seeded at import time: run.mjs imports every file before bootstrap() rebuilds the
// schema. once() defers the seed to the first test that needs it.
const getWorld = once(seedTwoVendors);

// A fresh item per case, so stock arithmetic never sees another case's movements.
async function freshItem(vendorId, stockKg = 20) {
  const { rows: [i] } = await sql(
    `insert into items (vendor_id, name_en, name_hi, name_mr, price, stock_kg)
     values ($1,'Tomato','टमाटर','टोमॅटो',40,$2) returning id`, [vendorId, stockKg]);
  return i.id;
}
const itemRow = async (id) =>
  (await sql(`select stock_kg, last_cost from items where id = $1`, [id])).rows[0];
const movementCount = async (itemId) =>
  Number((await sql(`select count(*)::int as n from stock_movements where item_id = $1`, [itemId])).rows[0].n);

const log = (client, args) => client.rpc("log_stock_movement", {
  p_item_id: args.itemId, p_kind: args.kind, p_qty_kg: args.qty,
  ...(args.cost !== undefined ? { p_unit_cost: args.cost } : {}),
  ...(args.note !== undefined ? { p_note: args.note } : {}),
});

test("a recorder's purchase adds stock and sets last_cost", async () => {
  const w = await getWorld();
  const id = await freshItem(w.a.vendorId, 20);
  const { data, error } = await log(w.a.clients.recorder, { itemId: id, kind: "purchase", qty: 15, cost: 22.5, note: "mandi" });
  assert(!error, `purchase refused: ${error?.message}`);
  assertEqual(data.kind, "purchase", "returned row kind");
  assertEqual(data.created_by, w.a.recorderId, "created_by must be the caller");
  const it = await itemRow(id);
  assertEqual(Number(it.stock_kg), 35, "stock did not rise by 15");
  assertEqual(Number(it.last_cost), 22.5, "last_cost not set");
});

test("an admin may log a purchase", async () => {
  const w = await getWorld();
  const id = await freshItem(w.a.vendorId);
  const { error } = await log(w.a.clients.admin, { itemId: id, kind: "purchase", qty: 1, cost: 10 });
  assert(!error, `admin refused: ${error?.message}`);
});

test("a second purchase overwrites last_cost with the latest price", async () => {
  const w = await getWorld();
  const id = await freshItem(w.a.vendorId);
  await log(w.a.clients.recorder, { itemId: id, kind: "purchase", qty: 5, cost: 20 });
  await log(w.a.clients.recorder, { itemId: id, kind: "purchase", qty: 5, cost: 26 });
  assertEqual(Number((await itemRow(id)).last_cost), 26, "latest price must win");
});

test("wastage subtracts stock and leaves last_cost alone", async () => {
  const w = await getWorld();
  const id = await freshItem(w.a.vendorId, 20);
  await log(w.a.clients.recorder, { itemId: id, kind: "purchase", qty: 5, cost: 30 });
  const { data, error } = await log(w.a.clients.recorder, { itemId: id, kind: "wastage", qty: 4, note: "rotten" });
  assert(!error, `wastage refused: ${error?.message}`);
  assertEqual(data.unit_cost, null, "wastage carries no cost");
  const it = await itemRow(id);
  assertEqual(Number(it.stock_kg), 21, "20 + 5 - 4");
  assertEqual(Number(it.last_cost), 30, "wastage must not touch last_cost");
});

test("wastage larger than stock is refused and changes nothing", async () => {
  const w = await getWorld();
  const id = await freshItem(w.a.vendorId, 3);
  const { error } = await log(w.a.clients.recorder, { itemId: id, kind: "wastage", qty: 3.5 });
  assertDenied(error, "wastage over stock was accepted");
  assert(/wastage exceeds stock/.test(error.message), `unexpected message: ${error.message}`);
  assertEqual(Number((await itemRow(id)).stock_kg), 3, "stock moved on a refused wastage");
  assertEqual(await movementCount(id), 0, "a refused wastage left a row");
});

test("wastage equal to stock is allowed and empties it", async () => {
  const w = await getWorld();
  const id = await freshItem(w.a.vendorId, 3);
  const { error } = await log(w.a.clients.recorder, { itemId: id, kind: "wastage", qty: 3 });
  assert(!error, `exact wastage refused: ${error?.message}`);
  assertEqual(Number((await itemRow(id)).stock_kg), 0, "stock should be zero");
});

test("a biller may not log a movement", async () => {
  const w = await getWorld();
  const id = await freshItem(w.a.vendorId);
  const { error } = await log(w.a.clients.biller, { itemId: id, kind: "purchase", qty: 1, cost: 10 });
  assertDenied(error, "a biller logged a purchase");
  assertEqual(await movementCount(id), 0, "biller's refused call left a row");
});

test("a recorder may not log against another vendor's item", async () => {
  const w = await getWorld();
  const bItem = await freshItem(w.b.vendorId, 20);
  const { error } = await log(w.a.clients.recorder, { itemId: bItem, kind: "purchase", qty: 1, cost: 10 });
  assertDenied(error, "vendor A moved vendor B's stock");
  assertEqual(Number((await itemRow(bItem)).stock_kg), 20, "B's stock changed");
});

test("a purchase without a cost is refused", async () => {
  const w = await getWorld();
  const id = await freshItem(w.a.vendorId);
  const { error } = await log(w.a.clients.recorder, { itemId: id, kind: "purchase", qty: 1 });
  assertDenied(error, "a purchase with no cost was accepted");
});

test("a wastage with a cost is refused", async () => {
  const w = await getWorld();
  const id = await freshItem(w.a.vendorId);
  const { error } = await log(w.a.clients.recorder, { itemId: id, kind: "wastage", qty: 1, cost: 5 });
  assertDenied(error, "a wastage with a cost was accepted");
});

test("zero or negative quantity is refused", async () => {
  const w = await getWorld();
  const id = await freshItem(w.a.vendorId);
  for (const qty of [0, -2]) {
    const { error } = await log(w.a.clients.recorder, { itemId: id, kind: "purchase", qty, cost: 5 });
    assertDenied(error, `qty ${qty} was accepted`);
  }
});

test("an unknown kind is refused", async () => {
  const w = await getWorld();
  const id = await freshItem(w.a.vendorId);
  const { error } = await log(w.a.clients.recorder, { itemId: id, kind: "gift", qty: 1 });
  assertDenied(error, "an unknown kind was accepted");
});

test("no role may insert, update or delete stock_movements directly", async () => {
  const w = await getWorld();
  const id = await freshItem(w.a.vendorId);
  await log(w.a.clients.recorder, { itemId: id, kind: "purchase", qty: 2, cost: 9 });
  for (const role of ["admin", "recorder", "biller"]) {
    const c = w.a.clients[role];
    const ins = await c.from("stock_movements").insert({
      vendor_id: w.a.vendorId, item_id: id, kind: "purchase", qty_kg: 1, unit_cost: 1,
      created_by: w.a.adminId,
    });
    assertDenied(ins.error, `${role} inserted a movement directly`);
    const up = await c.from("stock_movements").update({ qty_kg: 99 }).eq("item_id", id).select("id");
    assert(!up.error && up.data.length === 0 || up.error, `${role} updated a movement`);
    const del = await c.from("stock_movements").delete().eq("item_id", id).select("id");
    assert(!del.error && del.data.length === 0 || del.error, `${role} deleted a movement`);
  }
  assertEqual(await movementCount(id), 1, "the one logged row must survive untouched");
  const { rows: [r] } = await sql(`select qty_kg from stock_movements where item_id = $1`, [id]);
  assertEqual(Number(r.qty_kg), 2, "the row's quantity changed");
});

test("staff see their own vendor's movements and none of another's", async () => {
  const w = await getWorld();
  const bItem = await freshItem(w.b.vendorId);
  await log(w.b.clients.recorder, { itemId: bItem, kind: "purchase", qty: 1, cost: 1 });
  const { data } = await w.a.clients.admin.from("stock_movements").select("id").eq("item_id", bItem);
  assertInvisible(data, "vendor A read vendor B's movement");
  const own = await w.b.clients.biller.from("stock_movements").select("id").eq("item_id", bItem);
  assertEqual(own.data.length, 1, "a biller should still read their own vendor's movements");
});

test("an anonymous client sees no movements", async () => {
  const anon = await newClient();
  const { data } = await anon.from("stock_movements").select("id");
  assertInvisible(data, "anon read stock_movements");
});
