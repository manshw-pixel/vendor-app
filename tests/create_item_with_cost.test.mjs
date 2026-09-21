import { test, assert, assertEqual, once } from "./framework.mjs";
import { sql } from "./fixtures.mjs";
import { seedTwoVendors } from "./seed.mjs";

const getWorld = once(seedTwoVendors);

const NAMES = { name_en: "Beet", name_hi: "चुकंदर", name_mr: "बीट" };

const createAs = (client, opts = {}) =>
  client.rpc("create_item_with_cost", {
    p_names: opts.names ?? NAMES,
    p_price: opts.price ?? 40,
    p_stock: opts.stock ?? 10,
    p_unit: opts.unit ?? "kg",
    p_low_stock_at: opts.lowAt ?? 5,
    p_cost: opts.cost === undefined ? 25 : opts.cost,
  });

const itemRow = async (id) => (await sql(
  `select name_en, price, stock_kg, unit, low_stock_at, last_cost, is_active
     from items where id=$1`, [id])).rows[0];
const movements = async (itemId) => (await sql(
  `select kind, qty_kg, unit_cost from stock_movements where item_id=$1`, [itemId])).rows;

test("an admin creates an item with opening stock: one purchase movement, no double count", async () => {
  const w = await getWorld();
  const { data, error } = await createAs(w.a.clients.admin, { stock: 10, cost: 25 });
  assert(!error, `create refused: ${error?.message}`);
  const it = await itemRow(data.id);
  assertEqual(Number(it.stock_kg), 10, "stock must equal the opening stock, not double it");
  assertEqual(Number(it.last_cost), 25, "last_cost not set");
  assertEqual(Number(it.price), 40, "price not set");
  const m = await movements(data.id);
  assertEqual(m.length, 1, "exactly one movement should be logged");
  assertEqual(m[0].kind, "purchase", "kind");
  assertEqual(Number(m[0].qty_kg), 10, "movement quantity");
  assertEqual(Number(m[0].unit_cost), 25, "movement cost");
});

test("zero opening stock logs no movement but still records the cost", async () => {
  const w = await getWorld();
  const { data, error } = await createAs(w.a.clients.admin, { stock: 0, cost: 18 });
  assert(!error, error?.message);
  assertEqual((await movements(data.id)).length, 0, "there is no purchase to record");
  const it = await itemRow(data.id);
  assertEqual(Number(it.stock_kg), 0, "stock");
  assertEqual(Number(it.last_cost), 18, "the cost is still on file");
});

test("a null cost is refused", async () => {
  const w = await getWorld();
  const { error } = await createAs(w.a.clients.admin, { cost: null });
  assert(error, "a null cost should be refused");
});

test("a negative cost is refused", async () => {
  const w = await getWorld();
  const { error } = await createAs(w.a.clients.admin, { cost: -1 });
  assert(error, "a negative cost should be refused");
});

test("a fractional opening stock for a piece item is refused, leaving no item behind", async () => {
  const w = await getWorld();
  const before = (await sql(`select count(*)::int c from items where vendor_id=$1`, [w.a.vendorId])).rows[0].c;
  const { error } = await createAs(w.a.clients.admin,
    { unit: "piece", stock: 1.5, names: { ...NAMES, name_en: "Half Cabbage" } });
  assert(error, "a fractional piece stock should be refused");
  const after = (await sql(`select count(*)::int c from items where vendor_id=$1`, [w.a.vendorId])).rows[0].c;
  assertEqual(after, before, "the item row must roll back with the movement");
});

test("a recorder may not create an item", async () => {
  const w = await getWorld();
  const { error } = await createAs(w.a.clients.recorder);
  assert(error, "a recorder created an item");
});

test("a biller may not create an item", async () => {
  const w = await getWorld();
  const { error } = await createAs(w.a.clients.biller);
  assert(error, "a biller created an item");
});

test("the item lands in the caller's own shop", async () => {
  const w = await getWorld();
  const { data } = await createAs(w.a.clients.admin);
  const { rows } = await sql(`select vendor_id from items where id=$1`, [data.id]);
  assertEqual(rows[0].vendor_id, w.a.vendorId, "vendor_id is taken from the session, never the caller");
});

test("changing an existing item's cost writes no movement row", async () => {
  const w = await getWorld();
  const { data } = await createAs(w.a.clients.admin, { stock: 0 });
  const { error } = await w.a.clients.admin
    .from("items").update({ last_cost: 31 }).eq("id", data.id);
  assert(!error, error?.message);
  assertEqual((await movements(data.id)).length, 0, "an edit must not invent a delivery");
});
