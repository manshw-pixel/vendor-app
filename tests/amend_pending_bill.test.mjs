import { test, assert, assertEqual, once } from "./framework.mjs";
import { sql } from "./fixtures.mjs";
import { seedTwoVendors } from "./seed.mjs";

const getWorld = once(seedTwoVendors);

/** A `billed` bill in vendor `v`, built through the real functions so the outbound row
 *  and the token are exactly what production writes. */
async function billedBill(v, { qty = 2, price = 40, stockKg = 100 } = {}) {
  const { rows: [i] } = await sql(
    `insert into items (vendor_id, name_en, price, stock_kg) values ($1,'Amend Onion',$2,$3) returning id`,
    [v.vendorId, price, stockKg]);
  const { rows: [b] } = await sql(
    `insert into bills (vendor_id, customer_id, recorder_id, total, status)
     values ($1,$2,$3,0,'recording') returning id`, [v.vendorId, v.customerId, v.recorderId]);
  await sql(`insert into bill_items (bill_id, vendor_id, item_id, qty_kg, unit_price, line_total)
             values ($1,$2,$3,$4,$5,$6)`, [b.id, v.vendorId, i.id, qty, price, qty * price]);
  const { rows: [tok] } = await sql(`select issue_token($1) as token`, [b.id]);
  return { itemId: i.id, billId: b.id, token: tok.token };
}

test("issue_token stamps bill_id on the message it queues", async () => {
  const w = await getWorld();
  const x = await billedBill(w.a);
  const { rows } = await sql(
    `select bill_id, template_key from outbound_messages where bill_id = $1`, [x.billId]);
  assertEqual(rows.length, 1, "exactly one queued message for this bill");
  assertEqual(rows[0].template_key, "token_issued", "template");
});

test("bills carry nullable amendment stamps", async () => {
  const w = await getWorld();
  const x = await billedBill(w.a);
  const { rows } = await sql(
    `select amended_at, amended_by from bills where id = $1`, [x.billId]);
  assertEqual(rows[0].amended_at, null, "a fresh bill is not amended");
  assertEqual(rows[0].amended_by, null, "a fresh bill has no amender");
});
