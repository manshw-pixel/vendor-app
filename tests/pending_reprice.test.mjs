import { test, assert, assertEqual, once } from "./framework.mjs";
import { sql } from "./fixtures.mjs";
import { seedTwoVendors } from "./seed.mjs";

const getWorld = once(seedTwoVendors);

async function newItem(v, price = 40) {
  const { rows: [i] } = await sql(
    `insert into items (vendor_id, name_en, price, stock_kg, last_cost)
     values ($1,'Reprice Tomato',$2,100,20) returning id`, [v.vendorId, price]);
  return i.id;
}
// A bill with one line of `itemId`; issued (billed) unless status='recording'; completed if 'done'.
async function billWith(v, itemId, { qty = 2, price = 40, status = "billed" } = {}) {
  const { rows: [b] } = await sql(
    `insert into bills (vendor_id, customer_id, recorder_id, total, status)
     values ($1,$2,$3,0,'recording') returning id`, [v.vendorId, v.customerId, v.recorderId]);
  await sql(`insert into bill_items (bill_id, vendor_id, item_id, qty_kg, unit_price, line_total)
             values ($1,$2,$3,$4,$5,$6)`, [b.id, v.vendorId, itemId, qty, price, qty * price]);
  if (status !== "recording") await sql(`select issue_token($1)`, [b.id]);
  if (status === "done") await sql(`select complete_bill($1, null, 0, 'cash')`, [b.id]);
  return b.id;
}
const line = async (billId) => (await sql(
  `select unit_price::float8 p, line_total::float8 t from bill_items where bill_id=$1`, [billId])).rows[0];
const total = async (billId) => Number((await sql(`select total from bills where id=$1`, [billId])).rows[0].total);
const setPrice = (itemId, p) => sql(`update items set price=$2 where id=$1`, [itemId, p]);

test("a price change reprices billed lines and the bill total", async () => {
  const w = await getWorld();
  const item = await newItem(w.a);
  const b = await billWith(w.a, item, { qty: 2.5, price: 40 });
  await setPrice(item, 50);
  assertEqual((await line(b)).p, 50, "unit_price");
  assertEqual((await line(b)).t, 125, "line_total");
  assertEqual(await total(b), 125, "bill total");
});

test("a price change reprices a recording bill's lines", async () => {
  const w = await getWorld();
  const item = await newItem(w.a);
  const b = await billWith(w.a, item, { status: "recording" });
  await setPrice(item, 45);
  assertEqual((await line(b)).p, 45, "unit_price");
  assertEqual((await line(b)).t, 90, "line_total");
});

test("hand-edited prices are overwritten too", async () => {
  const w = await getWorld();
  const item = await newItem(w.a);
  const b = await billWith(w.a, item, { price: 33 });
  await setPrice(item, 60);
  assertEqual((await line(b)).p, 60, "unit_price");
});

test("done and voided bills are untouched", async () => {
  const w = await getWorld();
  const item = await newItem(w.a);
  const done = await billWith(w.a, item, { status: "done" });
  const voided = await billWith(w.a, item, { status: "done" });
  await sql(`update bills set status='voided', voided_at=now(), void_reason='x' where id=$1`, [voided]);
  await setPrice(item, 99);
  assertEqual((await line(done)).p, 40, "done line");
  assertEqual(await total(done), 80, "done total");
  assertEqual((await line(voided)).p, 40, "voided line");
});

test("another item's lines and an unchanged price are left alone", async () => {
  const w = await getWorld();
  const item = await newItem(w.a);
  const other = await newItem(w.a);
  const b = await billWith(w.a, other, { price: 40 });
  await setPrice(item, 70);
  await setPrice(other, 40);
  assertEqual((await line(b)).p, 40, "other item line");
});

test("an admin's price edit through RLS reprices too", async () => {
  const w = await getWorld();
  const item = await newItem(w.a);
  const b = await billWith(w.a, item);
  const { error } = await w.a.clients.admin.from("items").update({ price: 55 }).eq("id", item);
  assert(!error, error?.message);
  assertEqual(await total(b), 110, "bill total");
});

test("a still-pending token message gets the new total", async () => {
  const w = await getWorld();
  const item = await newItem(w.a);
  const b = await billWith(w.a, item);
  await setPrice(item, 50);
  const { rows } = await sql(
    `select (payload->>'total')::float8 t from outbound_messages where bill_id=$1 and status='pending'`, [b]);
  assertEqual(rows[0].t, 100, "message total");
});
