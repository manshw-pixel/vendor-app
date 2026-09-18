import { test, assert, assertEqual, once } from "./framework.mjs";
import { sql } from "./fixtures.mjs";
import { seedTwoVendors } from "./seed.mjs";

const getWorld = once(seedTwoVendors);

// A billed bill for a fresh item in vendor A. lastCost null means the item has never
// been purchased. Set directly in SQL: this file tests complete_bill, not the intake.
async function billedLine(w, { lastCost, qty = 2 }) {
  const { rows: [i] } = await sql(
    `insert into items (vendor_id, name_en, price, stock_kg, last_cost)
     values ($1,'Carrot',50,100,$2) returning id`, [w.a.vendorId, lastCost]);
  const { rows: [b] } = await sql(
    `insert into bills (vendor_id, customer_id, total, status)
     values ($1,$2,0,'recording') returning id`, [w.a.vendorId, w.a.customerId]);
  await sql(`insert into bill_items (bill_id, vendor_id, item_id, qty_kg, unit_price, line_total)
             values ($1,$2,$3,$4,50,$5)`, [b.id, w.a.vendorId, i.id, qty, qty * 50]);
  await sql(`select issue_token($1)`, [b.id]);
  return { itemId: i.id, billId: b.id };
}
const lineCost = async (billId) =>
  (await sql(`select unit_cost from bill_items where bill_id = $1`, [billId])).rows[0].unit_cost;

test("complete_bill stamps each line with the item's last_cost", async () => {
  const w = await getWorld();
  const x = await billedLine(w, { lastCost: 31.25 });
  await sql(`select complete_bill($1)`, [x.billId]);
  assertEqual(Number(await lineCost(x.billId)), 31.25, "unit_cost was not stamped");
});

test("a never-purchased item leaves unit_cost null, not zero", async () => {
  const w = await getWorld();
  const x = await billedLine(w, { lastCost: null });
  await sql(`select complete_bill($1)`, [x.billId]);
  assertEqual(await lineCost(x.billId), null, "an unknown cost must stay null");
});

test("a purchase logged after completion does not change the stamped cost", async () => {
  const w = await getWorld();
  const x = await billedLine(w, { lastCost: 20 });
  await sql(`select complete_bill($1)`, [x.billId]);
  const { error } = await w.a.clients.recorder.rpc("log_stock_movement", {
    p_item_id: x.itemId, p_kind: "purchase", p_qty_kg: 5, p_unit_cost: 45,
  });
  assert(!error, `purchase refused: ${error?.message}`);
  assertEqual(Number(await lineCost(x.billId)), 20, "history moved with today's price");
});

test("a retried complete_bill does not restamp", async () => {
  const w = await getWorld();
  const x = await billedLine(w, { lastCost: 20 });
  await sql(`select complete_bill($1)`, [x.billId]);
  await sql(`update items set last_cost = 99 where id = $1`, [x.itemId]);
  await sql(`select complete_bill($1)`, [x.billId]);
  assertEqual(Number(await lineCost(x.billId)), 20, "the retry restamped a done bill");
});

test("stamping cost does not disturb stock or the stored total", async () => {
  const w = await getWorld();
  const x = await billedLine(w, { lastCost: 10, qty: 3 });
  await sql(`select complete_bill($1)`, [x.billId]);
  const { rows: [i] } = await sql(`select stock_kg from items where id = $1`, [x.itemId]);
  const { rows: [b] } = await sql(`select total from bills where id = $1`, [x.billId]);
  assertEqual(Number(i.stock_kg), 97, "stock decrement changed");
  assertEqual(Number(b.total), 150, "total changed");
});

test("clear_vendor_data removes the vendor's movements and keeps the other vendor's", async () => {
  const w = await seedTwoVendors();   // its own world: clearing would wreck the shared one
  const log = (c, itemId) => c.rpc("log_stock_movement", {
    p_item_id: itemId, p_kind: "purchase", p_qty_kg: 1, p_unit_cost: 5,
  });
  await log(w.a.clients.recorder, w.a.itemId);
  await log(w.b.clients.recorder, w.b.itemId);
  const { error } = await w.a.clients.admin.rpc("clear_vendor_data");
  assert(!error, `clear refused: ${error?.message}`);
  const count = async (v) =>
    Number((await sql(`select count(*)::int n from stock_movements where vendor_id = $1`, [v])).rows[0].n);
  assertEqual(await count(w.a.vendorId), 0, "A's movements survived clearing");
  assertEqual(await count(w.b.vendorId), 1, "clearing A touched B");
});
