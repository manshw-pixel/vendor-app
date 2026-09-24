import { test, assert, assertDenied, assertEqual, once } from "./framework.mjs";
import { sql } from "./fixtures.mjs";
import { seedTwoVendors } from "./seed.mjs";

const getWorld = once(seedTwoVendors);

// A done bill in vendor `v` for a fresh item, completed now (or at `completedAt`).
// Built through the real functions so the ledger rows are exactly what production writes.
async function doneBill(v, { qty = 5, price = 40, stockKg = 100, redeem = 0, completedAt = null } = {}) {
  const { rows: [i] } = await sql(
    `insert into items (vendor_id, name_en, price, stock_kg, last_cost)
     values ($1,'Void Onion',$2,$3,20) returning id`, [v.vendorId, price, stockKg]);
  const { rows: [b] } = await sql(
    `insert into bills (vendor_id, customer_id, recorder_id, total, status)
     values ($1,$2,$3,0,'recording') returning id`, [v.vendorId, v.customerId, v.recorderId]);
  await sql(`insert into bill_items (bill_id, vendor_id, item_id, qty_kg, unit_price, line_total)
             values ($1,$2,$3,$4,$5,$6)`, [b.id, v.vendorId, i.id, qty, price, qty * price]);
  await sql(`select issue_token($1)`, [b.id]);
  await sql(`select complete_bill($1, null, $2, 'cash')`, [b.id, redeem]);
  if (completedAt) await sql(`update bills set completed_at = $2 where id = $1`, [b.id, completedAt]);
  return { itemId: i.id, billId: b.id };
}
const stock = async (itemId) => Number((await sql(`select stock_kg from items where id=$1`, [itemId])).rows[0].stock_kg);
const bill = async (id) => (await sql(`select status, voided_at, voided_by, void_reason from bills where id=$1`, [id])).rows[0];
const ledger = async (billId) => (await sql(
  `select points, expires_at from points_ledger where bill_id=$1 order by earned_at, points`, [billId])).rows;
const balance = async (customerId) => Number((await sql(
  `select coalesce(sum(points),0)::int b from points_ledger where customer_id=$1`, [customerId])).rows[0].b);
const messages = async (billId) => (await sql(
  `select payload from outbound_messages where template_key='bill_voided' and payload->>'bill_id'=$1`, [billId])).rows;
const voidAs = (client, billId, reason = "wrong customer") =>
  client.rpc("void_bill", { p_bill_id: billId, p_reason: reason });

test("a biller may void today's done bill: status, stamps and reason", async () => {
  const w = await getWorld();
  const x = await doneBill(w.a);
  const { error } = await voidAs(w.a.clients.biller, x.billId, "  typed twice ");
  assert(!error, `void refused: ${error?.message}`);
  const b = await bill(x.billId);
  assertEqual(b.status, "voided", "status");
  assert(b.voided_at !== null, "voided_at stamped");
  assertEqual(b.voided_by, w.a.billerId, "voided_by is the caller");
  assertEqual(b.void_reason, "typed twice", "reason trimmed");
});

test("an admin may void", async () => {
  const w = await getWorld();
  const x = await doneBill(w.a);
  const { error } = await voidAs(w.a.clients.admin, x.billId);
  assert(!error, error?.message);
});

test("a recorder may not void", async () => {
  const w = await getWorld();
  const x = await doneBill(w.a);
  const { error } = await voidAs(w.a.clients.recorder, x.billId);
  assertDenied(error, "recorder voided a bill");
  assertEqual((await bill(x.billId)).status, "done", "status changed on refusal");
});

test("a biller may not void another vendor's bill", async () => {
  const w = await getWorld();
  const x = await doneBill(w.b);
  const { error } = await voidAs(w.a.clients.biller, x.billId);
  assertDenied(error, "cross-vendor void");
  assertEqual((await bill(x.billId)).status, "done", "B's bill changed");
});

test("stock comes back by exactly the billed quantity", async () => {
  const w = await getWorld();
  const x = await doneBill(w.a, { qty: 7, stockKg: 50 });
  assertEqual(await stock(x.itemId), 43, "fixture: 50 - 7");
  await voidAs(w.a.clients.biller, x.billId);
  assertEqual(await stock(x.itemId), 50, "stock not restored");
});

test("the points award is reversed with the same expiry, and a spent balance goes negative", async () => {
  const w = await getWorld();
  // 20 kg x 40 = 800 -> 50 points by the default threshold.
  const x = await doneBill(w.a, { qty: 20 });
  const before = await ledger(x.billId);
  assertEqual(before.length, 1, "fixture: one award row");
  assertEqual(Number(before[0].points), 50, "fixture: 50 points");
  // Customer spends 30 of them elsewhere before the void.
  await sql(`insert into points_ledger (vendor_id, customer_id, points, expires_at)
             values ($1,$2,-30,$3)`, [w.a.vendorId, w.a.customerId, before[0].expires_at]);
  const balBefore = await balance(w.a.customerId);
  await voidAs(w.a.clients.biller, x.billId);
  const after = await ledger(x.billId);
  assertEqual(after.length, 2, "exactly one reversal row added");
  const rev = after.find((r) => Number(r.points) === -50);
  assert(rev, "no -50 row");
  assertEqual(new Date(rev.expires_at).getTime(), new Date(before[0].expires_at).getTime(), "expiry must match the award");
  assertEqual(await balance(w.a.customerId), balBefore - 50, "balance did not drop by the full award");
});

test("redeemed points are refunded with matching expiry", async () => {
  const w = await getWorld();
  // Give the customer plenty of points to spend (well above what any earlier case in this
  // shared world could have left as a negative residue), then a bill that redeems 25 of them.
  const { rows: [g] } = await sql(
    `insert into points_ledger (vendor_id, customer_id, points, expires_at)
     values ($1,$2,200, now() + interval '30 days') returning expires_at`, [w.a.vendorId, w.a.customerId]);
  const x = await doneBill(w.a, { qty: 2, redeem: 25 });
  const before = await ledger(x.billId);
  const red = before.find((r) => Number(r.points) < 0);
  assert(red && Number(red.points) === -25, "fixture: -25 redemption row");
  const balBefore = await balance(w.a.customerId);
  await voidAs(w.a.clients.biller, x.billId);
  const after = await ledger(x.billId);
  const refund = after.find((r) => Number(r.points) === 25);
  assert(refund, "no +25 refund row");
  assertEqual(new Date(refund.expires_at).getTime(), new Date(g.expires_at).getTime(), "refund expiry");
  assertEqual(await balance(w.a.customerId), balBefore + 25, "balance not refunded");
});

test("voiding twice is a no-op", async () => {
  const w = await getWorld();
  const x = await doneBill(w.a, { qty: 20, stockKg: 100 });
  await voidAs(w.a.clients.biller, x.billId, "first");
  const { error } = await voidAs(w.a.clients.admin, x.billId, "second");
  assert(!error, `second void errored: ${error?.message}`);
  assertEqual(await stock(x.itemId), 100, "stock restored twice");
  assertEqual((await ledger(x.billId)).length, 2, "ledger rows added twice");
  assertEqual((await bill(x.billId)).void_reason, "first", "second call overwrote the stamps");
  assertEqual((await messages(x.billId)).length, 1, "message queued twice");
});

test("a bill completed yesterday (IST) cannot be voided", async () => {
  const w = await getWorld();
  const { rows: [y] } = await sql(
    `select ((now() at time zone 'Asia/Kolkata')::date - 1)::timestamp at time zone 'Asia/Kolkata' + interval '12 hours' as t`);
  const x = await doneBill(w.a, { completedAt: y.t });
  const { error } = await voidAs(w.a.clients.biller, x.billId);
  assertDenied(error, "yesterday's bill was voided");
  assert(/void window closed/.test(error.message), error.message);
  assertEqual((await bill(x.billId)).status, "done", "status changed");
});

test("a bill completed at 00:30 IST today is still voidable at any time today", async () => {
  const w = await getWorld();
  const { rows: [t] } = await sql(
    `select ((now() at time zone 'Asia/Kolkata')::date)::timestamp at time zone 'Asia/Kolkata' + interval '30 minutes' as t`);
  const x = await doneBill(w.a, { completedAt: t.t });
  const { error } = await voidAs(w.a.clients.biller, x.billId);
  assert(!error, `today's early bill refused: ${error?.message}`);
});

test("a billed (not done) bill cannot be voided", async () => {
  const w = await getWorld();
  const { rows: [b] } = await sql(
    `insert into bills (vendor_id, customer_id, total, status) values ($1,$2,0,'recording') returning id`,
    [w.a.vendorId, w.a.customerId]);
  await sql(`insert into bill_items (bill_id, vendor_id, item_id, qty_kg, unit_price, line_total)
             values ($1,$2,$3,1,40,40)`, [b.id, w.a.vendorId, w.a.itemId]);
  await sql(`select issue_token($1)`, [b.id]);
  const { error } = await voidAs(w.a.clients.biller, b.id);
  assertDenied(error, "a billed bill was voided");
  assert(/bill is not done/.test(error.message), error.message);
});

test("a blank reason is refused", async () => {
  const w = await getWorld();
  const x = await doneBill(w.a);
  const { error } = await voidAs(w.a.clients.biller, x.billId, "   ");
  assertDenied(error, "blank reason accepted");
});

test("a bill_voided message is queued with token, total and points", async () => {
  const w = await getWorld();
  const x = await doneBill(w.a, { qty: 20 });   // 800 -> 50 points
  await voidAs(w.a.clients.biller, x.billId);
  const m = await messages(x.billId);
  assertEqual(m.length, 1, "one message");
  const p = m[0].payload;
  assert(Number(p.token_no) > 0, "token_no");
  assertEqual(Number(p.total), 800, "total");
  assertEqual(Number(p.points_reversed), 50, "points_reversed");
  assertEqual(Number(p.points_refunded), 0, "points_refunded");
});

test("no client may set status voided directly", async () => {
  const w = await getWorld();
  const x = await doneBill(w.a);
  for (const role of ["admin", "recorder", "biller"]) {
    const { data, error } = await w.a.clients[role].from("bills")
      .update({ status: "voided" }).eq("id", x.billId).select("id");
    assert(error || (data && data.length === 0), `${role} flipped status directly`);
  }
  assertEqual((await bill(x.billId)).status, "done", "status changed");
});

test("the constraint refuses voided without stamps and stamps without voided", async () => {
  const w = await getWorld();
  const x = await doneBill(w.a);
  let failed = false;
  try { await sql(`update bills set status='voided' where id=$1`, [x.billId]); } catch { failed = true; }
  assert(failed, "voided with no stamps was accepted");
  failed = false;
  try { await sql(`update bills set voided_at=now() where id=$1`, [x.billId]); } catch { failed = true; }
  assert(failed, "voided_at on a done bill was accepted");
});
