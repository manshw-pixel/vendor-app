import pg from "pg";
import { test, assert, assertDenied, assertEqual, assertInvisible } from "./framework.mjs";
import { sql, DB_URL } from "./fixtures.mjs";
import { seedTwoVendors } from "./seed.mjs";

// Every case builds its OWN world: closing today locks that shop for the rest of the file.

async function billedBill(v, { qty = 5, price = 40, customerId = v.customerId } = {}) {
  const { rows: [b] } = await sql(
    `insert into bills (vendor_id, customer_id, recorder_id, total, status)
     values ($1,$2,$3,0,'recording') returning id`, [v.vendorId, customerId, v.recorderId]);
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
const backdate = (id, days) =>
  sql(`update bills set completed_at = completed_at - ($2 || ' days')::interval where id = $1`, [id, String(days)]);
const kolkataDay = async (offset = 0) => (await sql(
  `select ((now() at time zone 'Asia/Kolkata')::date + $1::int)::text d`, [offset])).rows[0].d;
// node-pg parses a date column into a local-midnight Date. Format with LOCAL getters so
// the calendar date survives whatever zone this machine is in. (PostgREST sends a string.)
const ymdOf = (v) => {
  if (typeof v === "string") return v.slice(0, 10);
  const p = (n) => String(n).padStart(2, "0");
  return `${v.getFullYear()}-${p(v.getMonth() + 1)}-${p(v.getDate())}`;
};
const due = async (customerId) =>
  Number((await sql(`select customer_due($1) d`, [customerId])).rows[0].d);
const repay = (client, customer, amount, mode = "cash", note = null) =>
  client.rpc("record_repayment", { p_customer: customer, p_amount: amount, p_mode: mode, p_note: note });

// A raw connection acting as one signed-in user, inside an open transaction.
async function asUser(userId) {
  const c = new pg.Client({ connectionString: DB_URL });
  await c.connect();
  await c.query("begin");
  await c.query("set local role authenticated");
  await c.query(`select set_config('request.jwt.claims', $1, true)`,
    [JSON.stringify({ sub: userId, role: "authenticated" })]);
  return c;
}

test("a repayment lowers the balance; admin and biller may, a recorder may not", async () => {
  const w = await seedTwoVendors();
  await doneBill(w.a, "credit");                       // owes 200
  assertEqual(await due(w.a.customerId), 200, "credit bill charged");

  const { data, error } = await repay(w.a.clients.biller, w.a.customerId, 50, "upi", "part");
  assert(!error, error?.message);
  assertEqual([data.kind, Number(data.amount), data.mode, data.note, data.created_by],
    ["repayment", 50, "upi", "part", w.a.billerId], "row");
  assertEqual(ymdOf(data.business_date), await kolkataDay(), "dated today");
  const { error: adm } = await repay(w.a.clients.admin, w.a.customerId, 50);
  assert(!adm, adm?.message);
  const { error: rec } = await repay(w.a.clients.recorder, w.a.customerId, 10);
  assertDenied(rec, "recorder recorded a repayment");
  assertEqual(await due(w.a.customerId), 100, "balance after two repayments");
});

test("a repayment is refused over the balance, at zero, with a bad mode or amount, or for another shop's customer", async () => {
  const w = await seedTwoVendors();
  await doneBill(w.a, "credit", { qty: 1 });           // owes 40
  const over = await repay(w.a.clients.biller, w.a.customerId, 40.01);
  assert(over.error && /more than the balance/.test(over.error.message), `over: ${over.error?.message ?? "success"}`);
  for (const [amount, mode] of [[10, "credit"], [10, null], [0, "cash"], [-5, "cash"], [1.005, "cash"]]) {
    const { error } = await repay(w.a.clients.biller, w.a.customerId, amount, mode);
    assert(error, `accepted amount=${amount} mode=${mode}`);
  }
  const { error: other } = await repay(w.a.clients.biller, w.b.customerId, 1);
  assertDenied(other, "repaid another shop's customer");
  await repay(w.a.clients.biller, w.a.customerId, 40);
  const zero = await repay(w.a.clients.biller, w.a.customerId, 1);
  assert(zero.error && /more than the balance/.test(zero.error.message), "repaid a settled customer");
});

test("an opening balance: admin only, note required, adds to what they owe", async () => {
  const w = await seedTwoVendors();
  const ob = (client, amount, note) =>
    client.rpc("record_opening_balance", { p_customer: w.a.customerId, p_amount: amount, p_note: note });
  assertDenied((await ob(w.a.clients.biller, 500, "khata")).error, "biller added an opening balance");
  assert((await ob(w.a.clients.admin, 500, "  ")).error, "blank note accepted");
  assert((await ob(w.a.clients.admin, 0, "khata")).error, "zero accepted");
  const { data, error } = await ob(w.a.clients.admin, 500, "khata, 24 Sep");
  assert(!error, error?.message);
  assertEqual([data.kind, data.mode, data.note], ["opening", null, "khata, 24 Sep"], "row");
  assertEqual(await due(w.a.customerId), 500, "owes the opening");
});

test("reversal: reason required; a biller may reverse a repayment but not an opening; never twice", async () => {
  const w = await seedTwoVendors();
  await doneBill(w.a, "credit");                                   // 200
  const { data: r } = await repay(w.a.clients.biller, w.a.customerId, 80);
  const { data: o } = await w.a.clients.admin.rpc("record_opening_balance",
    { p_customer: w.a.customerId, p_amount: 100, p_note: "khata" });
  assertEqual(await due(w.a.customerId), 220, "before");

  const rev = (client, id, reason) => client.rpc("reverse_dues_entry", { p_entry: id, p_reason: reason });
  assert((await rev(w.a.clients.biller, r.id, " ")).error, "blank reason accepted");
  const { data: done, error } = await rev(w.a.clients.biller, r.id, "wrong customer");
  assert(!error, error?.message);
  assertEqual([done.reversed_by, done.reverse_reason], [w.a.billerId, "wrong customer"], "stamped");
  assertEqual(await due(w.a.customerId), 300, "reversed repayment owed again");
  const again = await rev(w.a.clients.admin, r.id, "x");
  assert(again.error && /already reversed/.test(again.error.message), `again: ${again.error?.message ?? "success"}`);

  assertDenied((await rev(w.a.clients.biller, o.id, "typo")).error, "biller reversed an opening");
  assert(!(await rev(w.a.clients.admin, o.id, "typo")).error, "admin could not reverse an opening");
  assertEqual(await due(w.a.customerId), 200, "opening gone");
  assertDenied((await rev(w.b.clients.admin, r.id, "x")).error, "B reversed A's entry");
});

test("a closed day refuses a repayment, and a reversal of that day's repayment", async () => {
  const w = await seedTwoVendors();
  await doneBill(w.a, "credit");                                   // 200
  const { data: r } = await repay(w.a.clients.biller, w.a.customerId, 50);   // cash, today
  // A note, because expected cash only includes repayments from Task 3 on; this test must
  // pass on both sides of that.
  const { error: c } = await w.a.clients.biller.rpc("close_day",
    { p_date: await kolkataDay(), p_counted_cash: 50, p_note: "dues cash" });
  assert(!c, c?.message);
  const late = await repay(w.a.clients.biller, w.a.customerId, 10);
  assert(late.error && /day is closed/.test(late.error.message), `repay: ${late.error?.message ?? "success"}`);
  const rev = await w.a.clients.admin.rpc("reverse_dues_entry", { p_entry: r.id, p_reason: "x" });
  assert(rev.error && /day is closed/.test(rev.error.message), `reverse: ${rev.error?.message ?? "success"}`);
  // An opening moves no cash, so a closed day does not block it.
  const { error: ob } = await w.a.clients.admin.rpc("record_opening_balance",
    { p_customer: w.a.customerId, p_amount: 10, p_note: "khata" });
  assert(!ob, `opening blocked by a closed day: ${ob?.message}`);
});

test("a credit bill voided after a part-payment leaves the customer overpaid; no further repayment", async () => {
  const w = await seedTwoVendors();
  const bill = await doneBill(w.a, "credit");                      // 200
  await repay(w.a.clients.biller, w.a.customerId, 100);
  const { error } = await w.a.clients.biller.rpc("void_bill", { p_bill_id: bill, p_reason: "wrong bill" });
  assert(!error, error?.message);
  assertEqual(await due(w.a.customerId), -100, "overpaid");
  const more = await repay(w.a.clients.biller, w.a.customerId, 1);
  assert(more.error && /more than the balance/.test(more.error.message), "repaid an overpaid customer");
});

test("dues_entries are invisible across vendors and unwritable directly; customer_due is scoped", async () => {
  const w = await seedTwoVendors();
  await doneBill(w.a, "credit");
  await repay(w.a.clients.biller, w.a.customerId, 10);
  const { data } = await w.b.clients.admin.from("dues_entries").select("*");
  assertInvisible(data, "B saw A's entries");
  const { error } = await w.a.clients.admin.from("dues_entries").insert({
    vendor_id: w.a.vendorId, customer_id: w.a.customerId, kind: "repayment", amount: 5, mode: "cash",
    business_date: await kolkataDay(), created_by: w.a.adminId,
  });
  assertDenied(error, "admin inserted an entry directly");
  await w.a.clients.admin.from("dues_entries").update({ amount: 999 }).eq("vendor_id", w.a.vendorId);
  const { rows } = await sql(`select amount from dues_entries where vendor_id = $1`, [w.a.vendorId]);
  assertEqual(Number(rows[0].amount), 10, "a direct update changed the entry");
  const { data: seen } = await w.b.clients.admin.rpc("customer_due", { p_customer: w.a.customerId });
  // The local harness (tests/client.mjs) unwraps a non-setof function's single row to an
  // object keyed by the return column (real PostgREST returns the bare scalar for a
  // scalar-returning function); pull the value out either way -- same pattern as
  // platform_owner.test.mjs's scalarOf.
  const scalar = seen !== null && typeof seen === "object" ? seen[Object.keys(seen)[0]] : seen;
  assertEqual(Number(scalar), 0, "B read A's customer's balance");
});

test("two tills repaying the last amount at once: exactly one succeeds", async () => {
  const w = await seedTwoVendors();
  await doneBill(w.a, "credit");                                   // 200
  const first = await asUser(w.a.billerId);
  const second = await asUser(w.a.adminId);
  try {
    await first.query(`select record_repayment($1, 200, 'cash')`, [w.a.customerId]);
    const outcome = second.query(`select record_repayment($1, 200, 'cash')`, [w.a.customerId])
      .then(() => null, (e) => e);
    await new Promise((r) => setTimeout(r, 300));
    await first.query("commit");
    const err = await outcome;
    assert(err && /more than the balance/.test(err.message),
      `both took the last payment: ${err?.message ?? "success"}`);
  } finally {
    await first.query("rollback").catch(() => {});
    await second.query("rollback").catch(() => {});
    await first.end();
    await second.end();
  }
  assertEqual(await due(w.a.customerId), 0, "paid once");
});

test("a repayment waiting on a close in progress is refused once the close commits", async () => {
  const w = await seedTwoVendors();
  await doneBill(w.a, "credit");
  const closer = await asUser(w.a.billerId);
  const payer = await asUser(w.a.adminId);
  try {
    await closer.query(`select close_day($1::date, 0, null)`, [await kolkataDay()]);
    const outcome = payer.query(`select record_repayment($1, 50, 'cash')`, [w.a.customerId])
      .then(() => null, (e) => e);
    await new Promise((r) => setTimeout(r, 300));
    await closer.query("commit");
    const err = await outcome;
    assert(err && /day is closed/.test(err.message),
      `the repayment slipped in after the count: ${err?.message ?? "success"}`);
  } finally {
    await closer.query("rollback").catch(() => {});
    await payer.query("rollback").catch(() => {});
    await closer.end();
    await payer.end();
  }
});
