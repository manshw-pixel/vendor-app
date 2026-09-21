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

const amendAs = (client, billId, lines) =>
  client.rpc("amend_pending_bill", { p_bill_id: billId, p_lines: lines });

const linesOf = async (billId) =>
  (await sql(`select item_id, qty_kg, unit_price, line_total from bill_items
               where bill_id = $1 order by line_total desc`, [billId])).rows;
const billRow = async (id) => (await sql(
  `select status, token_no, total, amended_at, amended_by from bills where id=$1`, [id])).rows[0];
const queued = async (billId) => (await sql(
  `select template_key, status, payload from outbound_messages
    where bill_id=$1 order by created_at`, [billId])).rows;

test("an admin may amend a pending bill: lines replaced, total recomputed, token kept", async () => {
  const w = await getWorld();
  const x = await billedBill(w.a, { qty: 2, price: 40 });   // total 80
  const before = await billRow(x.billId);
  const { error } = await amendAs(w.a.clients.admin, x.billId,
    [{ item_id: x.itemId, qty_kg: 5, unit_price: 40 }]);
  assert(!error, `amend refused: ${error?.message}`);
  const after = await billRow(x.billId);
  assertEqual(Number(after.total), 200, "total not recomputed from the new lines");
  assertEqual(after.token_no, before.token_no, "the token must survive an amendment");
  assertEqual(after.status, "billed", "status must stay billed");
  const rows = await linesOf(x.billId);
  assertEqual(rows.length, 1, "old lines should be gone");
  assertEqual(Number(rows[0].qty_kg), 5, "new quantity");
});

test("a recorder may amend, and the stamps record who", async () => {
  const w = await getWorld();
  const x = await billedBill(w.a);
  const { error } = await amendAs(w.a.clients.recorder, x.billId,
    [{ item_id: x.itemId, qty_kg: 1, unit_price: 40 }]);
  assert(!error, error?.message);
  const b = await billRow(x.billId);
  assert(b.amended_at !== null, "amended_at not stamped");
  assertEqual(b.amended_by, w.a.recorderId, "amended_by is the caller");
});

test("the pending message is superseded and quotes the new total", async () => {
  const w = await getWorld();
  const x = await billedBill(w.a, { qty: 2, price: 40 });
  await amendAs(w.a.clients.admin, x.billId, [{ item_id: x.itemId, qty_kg: 3, unit_price: 40 }]);
  const rows = await queued(x.billId);
  assertEqual(rows.length, 1, "the stale pending row should have been deleted");
  assertEqual(rows[0].template_key, "token_amended", "a corrected message should be queued");
  assertEqual(Number(rows[0].payload.total), 120, "the corrected message must quote the new total");
});

test("an already-sent message is history and is left in place", async () => {
  const w = await getWorld();
  const x = await billedBill(w.a, { qty: 2, price: 40 });
  await sql(`update outbound_messages set status='sent', sent_at=now() where bill_id=$1`, [x.billId]);
  await amendAs(w.a.clients.admin, x.billId, [{ item_id: x.itemId, qty_kg: 3, unit_price: 40 }]);
  const rows = await queued(x.billId);
  assertEqual(rows.length, 2, "the sent row must survive, with the correction after it");
  assertEqual(rows[0].status, "sent", "the original, still sent");
  assertEqual(rows[1].template_key, "token_amended", "the correction follows it");
});

test("a biller may not amend a bill", async () => {
  const w = await getWorld();
  const x = await billedBill(w.a);
  const { error } = await amendAs(w.a.clients.biller, x.billId,
    [{ item_id: x.itemId, qty_kg: 9, unit_price: 40 }]);
  assert(error, "a biller amended a basket");
  assertEqual(Number((await linesOf(x.billId))[0].qty_kg), 2, "lines changed on refusal");
});

test("an admin may not amend another vendor's bill", async () => {
  const w = await getWorld();
  const x = await billedBill(w.b);
  const { error } = await amendAs(w.a.clients.admin, x.billId,
    [{ item_id: x.itemId, qty_kg: 9, unit_price: 40 }]);
  assert(error, "cross-vendor amend");
});

test("a recording bill is refused: that path is replace_bill_lines", async () => {
  const w = await getWorld();
  const { rows: [b] } = await sql(
    `insert into bills (vendor_id, total, status) values ($1,0,'recording') returning id`,
    [w.a.vendorId]);
  const { error } = await amendAs(w.a.clients.admin, b.id,
    [{ item_id: w.a.itemId, qty_kg: 1, unit_price: 40 }]);
  assert(error, "a recording bill should be refused here");
});

test("a done bill is refused: that path is void and rebuild", async () => {
  const w = await getWorld();
  const x = await billedBill(w.a);
  await sql(`select complete_bill($1, null, 0)`, [x.billId]);
  const { error } = await amendAs(w.a.clients.admin, x.billId,
    [{ item_id: x.itemId, qty_kg: 9, unit_price: 40 }]);
  assert(error, "a done bill should be refused");
  assertEqual(Number((await linesOf(x.billId))[0].qty_kg), 2, "lines changed on refusal");
});

test("an empty basket is refused and the existing lines survive", async () => {
  const w = await getWorld();
  const x = await billedBill(w.a);
  const { error } = await amendAs(w.a.clients.admin, x.billId, []);
  assert(error, "an empty basket should be refused, not treated as 'clear the bill'");
  assertEqual((await linesOf(x.billId)).length, 1, "lines lost on a refused amendment");
});

test("a fractional quantity for a piece item is refused and the lines survive", async () => {
  const w = await getWorld();
  const x = await billedBill(w.a);
  const { rows: [p] } = await sql(
    `insert into items (vendor_id, name_en, price, stock_kg, unit)
     values ($1,'Amend Cabbage',30,50,'piece') returning id`, [w.a.vendorId]);
  const { error } = await amendAs(w.a.clients.admin, x.billId,
    [{ item_id: p.id, qty_kg: 1.5, unit_price: 30 }]);
  assert(error, "a fractional piece quantity should be refused");
  assertEqual((await linesOf(x.billId))[0].item_id, x.itemId, "the original line must survive");
});

test("line_total is computed, never taken from the caller", async () => {
  const w = await getWorld();
  const x = await billedBill(w.a);
  await amendAs(w.a.clients.admin, x.billId,
    [{ item_id: x.itemId, qty_kg: 5, unit_price: 40, line_total: 1 }]);
  assertEqual(Number((await linesOf(x.billId))[0].line_total), 200, "the sent line_total was trusted");
});

test("amending twice with the same basket leaves one copy", async () => {
  const w = await getWorld();
  const x = await billedBill(w.a);
  const basket = [{ item_id: x.itemId, qty_kg: 3, unit_price: 40 }];
  await amendAs(w.a.clients.admin, x.billId, basket);
  await amendAs(w.a.clients.admin, x.billId, basket);
  assertEqual((await linesOf(x.billId)).length, 1, "a repeated call appended a second copy");
  assertEqual(Number((await billRow(x.billId)).total), 120, "total doubled on a retry");
});
