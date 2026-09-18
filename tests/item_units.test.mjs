import { test, assert, assertEqual, once } from "./framework.mjs";
import { sql } from "./fixtures.mjs";
import { seedTwoVendors } from "./seed.mjs";

const getWorld = once(seedTwoVendors);

const newItem = async (vendorId, { unit = "kg", stock = 10, lowAt = null } = {}) => {
  const { rows: [i] } = await sql(
    `insert into items (vendor_id, name_en, price, stock_kg, unit${lowAt !== null ? ", low_stock_at" : ""})
     values ($1,'U-'||$2,20,$3,$2${lowAt !== null ? ",$4" : ""}) returning id, unit, low_stock_at`,
    lowAt !== null ? [vendorId, unit, stock, lowAt] : [vendorId, unit, stock]);
  return i;
};
const expectFail = async (fn, re, msg) => {
  let err = null;
  try { await fn(); } catch (e) { err = e; }
  assert(err, msg);
  assert(re.test(err.message), `${msg}: unexpected message ${err.message}`);
};

test("existing and new items default to kg with a low-stock threshold of 10", async () => {
  const w = await getWorld();
  const { rows: [seeded] } = await sql(`select unit, low_stock_at from items where id=$1`, [w.a.itemId]);
  assertEqual(seeded.unit, "kg", "seeded unit");
  assertEqual(Number(seeded.low_stock_at), 10, "seeded threshold");
  const i = await newItem(w.a.vendorId);
  assertEqual(i.unit, "kg", "default unit");
  assertEqual(Number(i.low_stock_at), 10, "default threshold");
});

test("only the four units are accepted", async () => {
  const w = await getWorld();
  for (const u of ["piece", "bunch", "dozen"]) assertEqual((await newItem(w.a.vendorId, { unit: u })).unit, u, u);
  await expectFail(() => newItem(w.a.vendorId, { unit: "gram" }), /items_unit_check|check constraint/i, "gram accepted");
});

test("a piece item refuses fractional stock and accepts whole stock", async () => {
  const w = await getWorld();
  await expectFail(() => newItem(w.a.vendorId, { unit: "piece", stock: 2.5 }), /whole number/i, "2.5 pieces accepted");
  const i = await newItem(w.a.vendorId, { unit: "piece", stock: 3 });
  await expectFail(() => sql(`update items set stock_kg = 3.25 where id=$1`, [i.id]), /whole number/i, "update to 3.25 accepted");
  await sql(`update items set stock_kg = 7 where id=$1`, [i.id]);
});

test("a kg item still accepts fractional stock", async () => {
  const w = await getWorld();
  const i = await newItem(w.a.vendorId, { unit: "kg", stock: 2.5 });
  await sql(`update items set stock_kg = 3.75 where id=$1`, [i.id]);
});

test("unit can change before a sale and is locked after one", async () => {
  const w = await getWorld();
  const i = await newItem(w.a.vendorId, { unit: "piece", stock: 5 });
  await sql(`update items set unit='bunch' where id=$1`, [i.id]);
  const { rows: [b] } = await sql(
    `insert into bills (vendor_id, customer_id, total, status) values ($1,$2,0,'recording') returning id`,
    [w.a.vendorId, w.a.customerId]);
  await sql(`insert into bill_items (bill_id, vendor_id, item_id, qty_kg, unit_price, line_total) values ($1,$2,$3,1,20,20)`,
    [b.id, w.a.vendorId, i.id]);
  await expectFail(() => sql(`update items set unit='dozen' where id=$1`, [i.id]), /unit is locked once the item has been sold/, "unit changed after a sale");
  // Other columns still editable after a sale.
  await sql(`update items set price = 25 where id=$1`, [i.id]);
});

test("v_low_stock honours the per-item threshold", async () => {
  const w = await getWorld();
  const tight = await newItem(w.a.vendorId, { unit: "dozen", stock: 8, lowAt: 3 });   // not low
  const loose = await newItem(w.a.vendorId, { unit: "kg", stock: 40, lowAt: 50 });    // low
  const { data } = await w.a.clients.admin.from("v_low_stock").select("id, unit, low_stock_at");
  const ids = data.map((r) => r.id);
  assert(!ids.includes(tight.id), "8 dozen with threshold 3 flagged low");
  assert(ids.includes(loose.id), "40 kg with threshold 50 not flagged");
  const row = data.find((r) => r.id === loose.id);
  assertEqual(row.unit, "kg", "view returns unit");
  assertEqual(Number(row.low_stock_at), 50, "view returns threshold");
});

test("v_in_stock returns the unit", async () => {
  const w = await getWorld();
  const i = await newItem(w.a.vendorId, { unit: "bunch", stock: 2 });
  const { data } = await w.a.clients.recorder.from("v_in_stock").select("id, unit").eq("id", i.id);
  assertEqual(data[0].unit, "bunch", "unit missing from v_in_stock");
});

test("the low-stock threshold cannot be negative", async () => {
  const w = await getWorld();
  await expectFail(() => newItem(w.a.vendorId, { lowAt: -1 }), /check constraint|low_stock_at/i, "negative threshold accepted");
});
