import { test, assert, assertEqual, assertDenied, once } from "./framework.mjs";
import { sql } from "./fixtures.mjs";
import { seedTwoVendors } from "./seed.mjs";

const getWorld = once(seedTwoVendors);

/** A fresh vendor with its own item, customer and one recording bill. Isolated per test
 *  so a replace in one cannot be seen by another. */
async function freshBill() {
  const { rows: [v] } = await sql(`insert into vendors (name) values ('Replace Co') returning id`);
  const { rows: [i1] } = await sql(
    `insert into items (vendor_id, name_en, price, stock_kg) values ($1,'Tomato',40,100) returning id`,
    [v.id]);
  const { rows: [i2] } = await sql(
    `insert into items (vendor_id, name_en, price, stock_kg) values ($1,'Onion',32,100) returning id`,
    [v.id]);
  const { rows: [c] } = await sql(
    `insert into customers (vendor_id, name, flat_no, mobile)
     values ($1,'Rep','D-1','+919777800001') returning id`, [v.id]);
  const { rows: [b] } = await sql(
    `insert into bills (vendor_id, customer_id, total, status)
     values ($1,$2,0,'recording') returning id`, [v.id, c.id]);
  return { vendorId: v.id, itemA: i1.id, itemB: i2.id, customerId: c.id, billId: b.id };
}

const basket = (w) => JSON.stringify([
  { item_id: w.itemA, qty_kg: 2.5, unit_price: 40 },
  { item_id: w.itemB, qty_kg: 1, unit_price: 32 },
]);

const linesOf = async (billId) =>
  (await sql(`select item_id, qty_kg, unit_price, line_total from bill_items
               where bill_id = $1 order by line_total desc`, [billId])).rows;

test("replace_bill_lines called twice with the same basket leaves one copy", async () => {
  // THE test this slice exists for. A lost reply after a committed write makes the client
  // send the same basket again; an append would leave four rows and a doubled total, and
  // nothing downstream could tell -- the doubled total IS the total.
  const w = await freshBill();
  await sql(`select replace_bill_lines($1, $2::jsonb)`, [w.billId, basket(w)]);
  await sql(`select replace_bill_lines($1, $2::jsonb)`, [w.billId, basket(w)]);
  const rows = await linesOf(w.billId);
  assertEqual(rows.length, 2, "a repeated call must not append a second copy");
  assertEqual(Number(rows[0].line_total), 100, "tomato line");
  assertEqual(Number(rows[1].line_total), 32, "onion line");
});

test("replace_bill_lines replaces rather than accumulates when the basket changes", async () => {
  // A recorder who removes an item and presses Done again must not leave the removed
  // item on the bill.
  const w = await freshBill();
  await sql(`select replace_bill_lines($1, $2::jsonb)`, [w.billId, basket(w)]);
  await sql(`select replace_bill_lines($1, $2::jsonb)`,
    [w.billId, JSON.stringify([{ item_id: w.itemA, qty_kg: 1, unit_price: 40 }])]);
  const rows = await linesOf(w.billId);
  assertEqual(rows.length, 1, "the old lines should be gone");
  assertEqual(rows[0].item_id, w.itemA, "wrong line survived");
  assertEqual(Number(rows[0].line_total), 40, "line_total not recomputed for the new basket");
});

test("replace_bill_lines computes line_total and ignores any the caller sends", async () => {
  // The forged-total hole: issue_token sums stored line_totals, so a crafted request
  // could otherwise set a bill's total to anything.
  const w = await freshBill();
  await sql(`select replace_bill_lines($1, $2::jsonb)`, [w.billId, JSON.stringify([
    { item_id: w.itemA, qty_kg: 5, unit_price: 40, line_total: 1 },
  ])]);
  const rows = await linesOf(w.billId);
  assertEqual(Number(rows[0].line_total), 200, "line_total must be qty x price, not the sent 1");
});

test("replace_bill_lines rounds the way billing.ts does", async () => {
  // runningTotal() is what the recorder reads off the screen; issue_token sums the stored
  // rows. If these two round differently the token screen and the printed receipt differ
  // from the basket by a paisa. Expected values are what Math.round(p*q*100)/100 gives.
  const w = await freshBill();
  await sql(`select replace_bill_lines($1, $2::jsonb)`, [w.billId, JSON.stringify([
    { item_id: w.itemA, qty_kg: 0.05, unit_price: 2.5 },   // 0.125  -> 0.13
    { item_id: w.itemB, qty_kg: 3,    unit_price: 33.33 }, // 99.99  -> 99.99
  ])]);
  const { rows } = await sql(
    `select line_total from bill_items where bill_id = $1 order by line_total`, [w.billId]);
  assertEqual(Number(rows[0].line_total), 0.13, "half-way value rounded differently from JS");
  assertEqual(Number(rows[1].line_total), 99.99, "exact value drifted");
});

test("replace_bill_lines refuses a bill that is no longer recording", async () => {
  // A billed bill has had its token and total told to the customer, and the WhatsApp
  // message quoting that total is queued. Rewriting its lines would make both a lie.
  const w = await freshBill();
  await sql(`select replace_bill_lines($1, $2::jsonb)`, [w.billId, basket(w)]);
  await sql(`select issue_token($1)`, [w.billId]);
  let raised = null;
  try {
    await sql(`select replace_bill_lines($1, $2::jsonb)`, [w.billId, basket(w)]);
  } catch (e) { raised = e; }
  assert(raised !== null, "expected the replace to be refused on a billed bill");
  assert(/expected recording/.test(raised.message), `wrong error: ${raised.message}`);
  assertEqual((await linesOf(w.billId)).length, 2, "the billed bill's lines must be untouched");
});

test("replace_bill_lines refuses an empty basket", async () => {
  // Accepting it would let a retry turn a real bill into a zero-rupee one.
  const w = await freshBill();
  await sql(`select replace_bill_lines($1, $2::jsonb)`, [w.billId, basket(w)]);
  let raised = null;
  try {
    await sql(`select replace_bill_lines($1, '[]'::jsonb)`, [w.billId]);
  } catch (e) { raised = e; }
  assert(raised !== null, "expected an empty basket to be refused");
  assertEqual((await linesOf(w.billId)).length, 2, "the existing lines must survive a refusal");
});

test("a recorder cannot replace another vendor's bill lines", async () => {
  // Through a signed-in client, so current_vendor_id() is non-null and the tenant guard
  // actually fires. Called as superuser it would pass through by design.
  const w = await getWorld();
  const { rows: [b] } = await sql(
    `insert into bills (vendor_id, customer_id, total, status)
     values ($1,$2,0,'recording') returning id`, [w.b.vendorId, w.b.customerId]);
  const { error } = await w.a.clients.recorder.rpc("replace_bill_lines", {
    p_bill_id: b.id,
    p_lines: [{ item_id: w.b.itemId, qty_kg: 1, unit_price: 10 }],
  });
  assertDenied(error, "a recorder reached across the tenant boundary");
});

test("a biller may not replace bill lines", async () => {
  const w = await getWorld();
  const { rows: [b] } = await sql(
    `insert into bills (vendor_id, customer_id, total, status)
     values ($1,$2,0,'recording') returning id`, [w.a.vendorId, w.a.customerId]);
  const { error } = await w.a.clients.biller.rpc("replace_bill_lines", {
    p_bill_id: b.id,
    p_lines: [{ item_id: w.a.itemId, qty_kg: 1, unit_price: 10 }],
  });
  assertDenied(error, "a biller was allowed to rewrite a basket");
});
