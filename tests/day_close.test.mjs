import pg from "pg";
import { test, assert, assertDenied, assertEqual, assertInvisible } from "./framework.mjs";
import { sql, DB_URL } from "./fixtures.mjs";
import { seedTwoVendors } from "./seed.mjs";

// Every case builds its OWN world: closing today locks that shop for the rest of the file.

async function billedBill(v, { qty = 5, price = 40 } = {}) {
  const { rows: [b] } = await sql(
    `insert into bills (vendor_id, customer_id, recorder_id, total, status)
     values ($1,$2,$3,0,'recording') returning id`, [v.vendorId, v.customerId, v.recorderId]);
  await sql(`insert into bill_items (bill_id, vendor_id, item_id, qty_kg, unit_price, line_total)
             values ($1,$2,$3,$4,$5,$6)`, [b.id, v.vendorId, v.itemId, qty, price, qty * price]);
  await sql(`select issue_token($1)`, [b.id]);
  return b.id;
}
async function doneBill(v, mode, opts = {}) {
  const id = await billedBill(v, opts);
  await sql(`select complete_bill($1, p_payment_mode => $2)`, [id, mode]);
  return id;
}
// Moves a done bill N whole days back. Whole days keep the time of day, so its Kolkata
// date moves by exactly N.
const backdate = (id, days) =>
  sql(`update bills set completed_at = completed_at - ($2 || ' days')::interval where id = $1`, [id, String(days)]);
const kolkataDay = async (offset = 0) => (await sql(
  `select ((now() at time zone 'Asia/Kolkata')::date + $1::int)::text d`, [offset])).rows[0].d;
const closeAs = (client, date, counted, note = null) =>
  client.rpc("close_day", { p_date: date, p_counted_cash: counted, p_note: note });

test("a biller closes today: expected cash is cash payments only", async () => {
  const w = await seedTwoVendors();
  await doneBill(w.a, "cash", { qty: 5 });     // 200
  await doneBill(w.a, "upi", { qty: 2 });      // 80
  await doneBill(w.a, "card", { qty: 1 });     // 40
  await doneBill(w.a, "credit", { qty: 1 });   // 40
  const voided = await doneBill(w.a, "cash", { qty: 3 });
  await w.a.clients.biller.rpc("void_bill", { p_bill_id: voided, p_reason: "test" });
  const old = await doneBill(w.a, "cash", { qty: 1 });
  await sql(`delete from bill_payments where bill_id = $1`, [old]);   // a pre-0021 bill

  const { data, error } = await closeAs(w.a.clients.biller, await kolkataDay(), 200);
  assert(!error, `refused: ${error?.message}`);
  assertEqual(Number(data.expected_cash), 200, "expected");
  assertEqual(Number(data.counted_cash), 200, "counted");
  assertEqual(Number(data.difference), 0, "difference");
  assertEqual(data.closed_by, w.a.billerId, "closed_by");
});

test("an admin may close; a recorder may not", async () => {
  const w = await seedTwoVendors();
  const { error: rec } = await closeAs(w.a.clients.recorder, await kolkataDay(), 0);
  assertDenied(rec, "recorder closed the day");
  const { error: adm } = await closeAs(w.a.clients.admin, await kolkataDay(), 0);
  assert(!adm, adm?.message);
});

test("a non-zero difference needs a note", async () => {
  const w = await seedTwoVendors();
  await doneBill(w.a, "cash");                  // 200
  const today = await kolkataDay();
  const { error } = await closeAs(w.a.clients.biller, today, 190);
  assert(error && /note is required/.test(error.message), `expected note refusal, got ${error?.message ?? "success"}`);
  const { error: blank } = await closeAs(w.a.clients.biller, today, 190, "   ");
  assert(blank, "a blank note must not count");
  const { data, error: ok } = await closeAs(w.a.clients.biller, today, 190, "gave 10 change twice");
  assert(!ok, ok?.message);
  assertEqual(Number(data.difference), -10, "difference");
  assertEqual(data.note, "gave 10 change twice", "note");
});

test("closing twice, a future date, and bad amounts are refused", async () => {
  const w = await seedTwoVendors();
  const today = await kolkataDay();
  const { error: neg } = await closeAs(w.a.clients.biller, today, -1);
  assert(neg, "negative counted cash accepted");
  const { error: fine } = await closeAs(w.a.clients.biller, today, 10.555, "x");
  assert(fine, "sub-paisa counted cash accepted");
  const { error: future } = await closeAs(w.a.clients.biller, await kolkataDay(1), 0);
  assert(future, "future date accepted");
  const { error: first } = await closeAs(w.a.clients.biller, today, 0);
  assert(!first, first?.message);
  const { error: again } = await closeAs(w.a.clients.admin, today, 0);
  assert(again && /day already closed/.test(again.message), `expected already closed, got ${again?.message ?? "success"}`);
});

test("while today is closed: complete and void refuse, a retry of a done bill and issue_token do not", async () => {
  const w = await seedTwoVendors();
  const done = await doneBill(w.a, "cash");
  const pending = await billedBill(w.a);
  const { error: c } = await closeAs(w.a.clients.biller, await kolkataDay(), 200);
  assert(!c, c?.message);

  const { error: comp } = await w.a.clients.biller.rpc("complete_bill", { p_bill_id: pending, p_payment_mode: "cash" });
  assert(comp && /day is closed/.test(comp.message), `complete: ${comp?.message ?? "success"}`);
  const { error: v } = await w.a.clients.biller.rpc("void_bill", { p_bill_id: done, p_reason: "late" });
  assert(v && /day is closed/.test(v.message), `void: ${v?.message ?? "success"}`);

  // A retry whose first attempt already committed is still success: the idempotency guard
  // returns before the lock is checked.
  const { error: retry } = await w.a.clients.biller.rpc("complete_bill", { p_bill_id: done, p_payment_mode: "cash" });
  assert(!retry, `retry of a done bill refused: ${retry?.message}`);

  const later = await billedBill(w.a);   // issue_token inside
  const { rows: [b] } = await sql(`select status from bills where id = $1`, [later]);
  assertEqual(b.status, "billed", "a token can still be issued; it carries over");
});

test("reopen: admin only, reason required, history kept, re-close recomputes", async () => {
  const w = await seedTwoVendors();
  const today = await kolkataDay();
  await doneBill(w.a, "cash");                  // 200
  await closeAs(w.a.clients.biller, today, 200);

  const { error: bil } = await w.a.clients.biller.rpc("reopen_day", { p_date: today, p_reason: "late sale" });
  assertDenied(bil, "biller reopened");
  const { error: blank } = await w.a.clients.admin.rpc("reopen_day", { p_date: today, p_reason: "  " });
  assert(blank, "blank reason accepted");
  const { data: re, error } = await w.a.clients.admin.rpc("reopen_day", { p_date: today, p_reason: "late sale" });
  assert(!error, error?.message);
  assertEqual(re.reopen_reason, "late sale", "reason stored");
  assertEqual(re.reopened_by, w.a.adminId, "reopened_by");

  await doneBill(w.a, "cash", { qty: 1 });      // 40, allowed again
  const { data: second, error: e2 } = await closeAs(w.a.clients.biller, today, 240);
  assert(!e2, e2?.message);
  assertEqual(Number(second.expected_cash), 240, "recomputed");
  const { rows } = await sql(
    `select count(*)::int n, count(*) filter (where reopened_at is not null)::int reopened
       from day_closes where vendor_id = $1 and business_date = $2::date`, [w.a.vendorId, today]);
  assertEqual(rows[0], { n: 2, reopened: 1 }, "both closes kept");
});

test("reopening a day that is not closed is refused", async () => {
  const w = await seedTwoVendors();
  const { error } = await w.a.clients.admin.rpc("reopen_day", { p_date: await kolkataDay(), p_reason: "x" });
  assert(error && /day is not closed/.test(error.message), `got ${error?.message ?? "success"}`);
});

test("a past day's close locks voids of that day's bills only", async () => {
  const w = await seedTwoVendors();
  const past = await doneBill(w.a, "cash");
  await backdate(past, 2);
  const { error } = await closeAs(w.a.clients.biller, await kolkataDay(-2), 200);
  assert(!error, error?.message);
  // Today is untouched by closing two days ago.
  const todays = await billedBill(w.a);
  const { error: comp } = await w.a.clients.biller.rpc("complete_bill", { p_bill_id: todays, p_payment_mode: "upi" });
  assert(!comp, `today was locked by a past close: ${comp?.message}`);
});

test("day_closes are invisible across vendors and unwritable directly", async () => {
  const w = await seedTwoVendors();
  const today = await kolkataDay();
  await closeAs(w.a.clients.biller, today, 0);
  const { data } = await w.b.clients.admin.from("day_closes").select("*").eq("vendor_id", w.a.vendorId);
  assertInvisible(data, "B saw A's close");
  const { error } = await w.a.clients.admin.from("day_closes").insert({
    vendor_id: w.a.vendorId, business_date: await kolkataDay(-1), expected_cash: 0, counted_cash: 0,
    difference: 0, closed_by: w.a.adminId,
  });
  assertDenied(error, "admin inserted a close directly");
  await w.a.clients.admin.from("day_closes").update({ counted_cash: 999 }).eq("vendor_id", w.a.vendorId);
  const { rows } = await sql(`select counted_cash from day_closes where vendor_id = $1`, [w.a.vendorId]);
  assertEqual(Number(rows[0].counted_cash), 0, "a direct update changed the close");
});

test("a completion waiting on a close in progress is refused once the close commits", async () => {
  const w = await seedTwoVendors();
  const id = await billedBill(w.a);
  const today = await kolkataDay();
  const closer = new pg.Client({ connectionString: DB_URL });
  const completer = new pg.Client({ connectionString: DB_URL });
  await closer.connect();
  await completer.connect();
  try {
    await closer.query("begin");
    await closer.query("set local role authenticated");
    await closer.query(`select set_config('request.jwt.claims', $1, true)`,
      [JSON.stringify({ sub: w.a.billerId, role: "authenticated" })]);
    await closer.query(`select close_day($1::date, 0, null)`, [today]);
    // The close holds the vendor row until commit, so this completion must wait on it.
    const outcome = completer.query(`select complete_bill($1, p_payment_mode => 'cash')`, [id])
      .then(() => null, (e) => e);
    await new Promise((r) => setTimeout(r, 300));
    await closer.query("commit");
    const err = await outcome;
    assert(err && /day is closed/.test(err.message),
      `the completion slipped in after the count: ${err?.message ?? "success"}`);
  } finally {
    await closer.end();
    await completer.end();
  }
});
