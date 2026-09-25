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
  // tests/client.mjs's rpc shim already unwraps the scalar result, same as real PostgREST.
  assertEqual(Number(seen), 0, "B read A's customer's balance");
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

// A done credit bill with no customer, as 0021 allowed: completed while the rule did not
// exist. Built by completing it with a customer, then removing the customer as a
// superuser.
async function orphanCredit(v, opts = {}) {
  const id = await doneBill(v, "credit", opts);
  await sql(`update bills set customer_id = null where id = $1`, [id]);
  return id;
}

test("credit with no customer is refused and the bill stays billed; cash without one is fine", async () => {
  const w = await seedTwoVendors();
  const id = await billedBill(w.a, { customerId: null });
  const { error } = await w.a.clients.biller.rpc("complete_bill", { p_bill_id: id, p_payment_mode: "credit" });
  assert(error && /credit needs a customer/.test(error.message), `got ${error?.message ?? "success"}`);
  const { rows: [b] } = await sql(`select status from bills where id = $1`, [id]);
  assertEqual(b.status, "billed", "still pending");
  const { error: cash } = await w.a.clients.biller.rpc("complete_bill", { p_bill_id: id, p_payment_mode: "cash" });
  assert(!cash, cash?.message);
});

test("a retry of an already-done credit bill still succeeds", async () => {
  const w = await seedTwoVendors();
  const id = await orphanCredit(w.a);                  // done, credit, and now customer-less
  const { error } = await w.a.clients.biller.rpc("complete_bill", { p_bill_id: id, p_payment_mode: "credit" });
  assert(!error, `retry refused: ${error?.message}`);
});

test("unassigned_credit lists done credit bills with no customer, newest first", async () => {
  const w = await seedTwoVendors();
  const older = await orphanCredit(w.a, { qty: 1 });   // 40
  await backdate(older, 1);
  const newer = await orphanCredit(w.a, { qty: 2 });   // 80
  await doneBill(w.a, "credit");                       // has a customer: not listed
  const cashOrphan = await doneBill(w.a, "cash");
  await sql(`update bills set customer_id = null where id = $1`, [cashOrphan]);   // not credit
  const { data, error } = await w.a.clients.admin.rpc("unassigned_credit");
  assert(!error, error?.message);
  assertEqual(data.map((r) => [r.bill_id, Number(r.amount)]), [[newer, 80], [older, 40]], "listed");
  const { data: b } = await w.b.clients.admin.rpc("unassigned_credit");
  assertEqual(b, [], "B sees none of A's");
});

test("unassigned_credit is for admins: a biller gets an empty list", async () => {
  const w = await seedTwoVendors();
  const id = await orphanCredit(w.a);
  const { data: adm } = await w.a.clients.admin.rpc("unassigned_credit");
  assertEqual(adm.map((r) => r.bill_id), [id], "admin sees it");
  const { data, error } = await w.a.clients.biller.rpc("unassigned_credit");
  assert(!error, error?.message);
  assertEqual(data, [], "biller sees none");
});

test("assign_credit_customer: admin only, onto a customer-less done credit bill, no points after the fact", async () => {
  const w = await seedTwoVendors();
  const id = await orphanCredit(w.a);                  // 200
  const assign = (client, bill, customer) =>
    client.rpc("assign_credit_customer", { p_bill: bill, p_customer: customer });

  assertDenied((await assign(w.a.clients.biller, id, w.a.customerId)).error, "biller assigned");
  assertDenied((await assign(w.a.clients.admin, id, w.b.customerId)).error, "assigned another shop's customer");
  assertDenied((await assign(w.b.clients.admin, id, w.b.customerId)).error, "B assigned A's bill");

  const pointsBefore = (await sql(`select count(*)::int n from points_ledger where bill_id = $1`, [id])).rows[0].n;
  const { error } = await assign(w.a.clients.admin, id, w.a.customerId);
  assert(!error, error?.message);
  assertEqual(await due(w.a.customerId), 200, "now owed by the customer");
  const pointsAfter = (await sql(`select count(*)::int n from points_ledger where bill_id = $1`, [id])).rows[0].n;
  assertEqual(pointsAfter, pointsBefore, "no points awarded retroactively");

  const twice = await assign(w.a.clients.admin, id, w.a.customerId);
  assert(twice.error && /bill cannot be assigned/.test(twice.error.message), "re-assigned a bill that has a customer");
  const cash = await doneBill(w.a, "cash");
  await sql(`update bills set customer_id = null where id = $1`, [cash]);
  const notCredit = await assign(w.a.clients.admin, cash, w.a.customerId);
  assert(notCredit.error && /bill cannot be assigned/.test(notCredit.error.message), "assigned a cash bill");
  const pending = await billedBill(w.a, { customerId: null });
  const notDone = await assign(w.a.clients.admin, pending, w.a.customerId);
  assert(notDone.error && /bill cannot be assigned/.test(notDone.error.message), "assigned a pending bill");
});

async function secondCustomer(v, name = "Zed") {
  const { rows: [c] } = await sql(
    `insert into customers (vendor_id, name, flat_no, mobile) values ($1,$2,'B-2',$3) returning id`,
    [v.vendorId, name, `+91888${Math.floor(Math.random() * 1e7)}`]);
  return c.id;
}

test("dues_list: owing customers by balance, overpaid last, settled left out, this shop only", async () => {
  const w = await seedTwoVendors();
  const zed = await secondCustomer(w.a);
  const settled = await secondCustomer(w.a, "Settled");
  await doneBill(w.a, "credit", { qty: 1 });                       // A's customer owes 40
  await doneBill(w.a, "credit", { customerId: zed });               // Zed owes 200
  await doneBill(w.a, "credit", { qty: 1, customerId: settled });
  await repay(w.a.clients.biller, settled, 40);                     // settled: 0
  const over = await doneBill(w.a, "credit", { qty: 2 });           // A's customer now 120
  await repay(w.a.clients.biller, w.a.customerId, 100);             // 20
  await w.a.clients.biller.rpc("void_bill", { p_bill_id: over, p_reason: "x" });   // -60

  const { data, error } = await w.a.clients.biller.rpc("dues_list");
  assert(!error, error?.message);
  assertEqual(data.map((r) => [r.name, Number(r.balance)]), [["Zed", 200], ["Cust A", -60]], "list");
  assertEqual(data[1].oldest_unpaid, null, "an overpaid customer has no oldest unpaid date");
  const { data: b } = await w.b.clients.admin.rpc("dues_list");
  assertEqual(b, [], "B sees none of A's");
});

test("dues_list: the oldest unpaid date is FIFO over charges", async () => {
  const w = await seedTwoVendors();
  const first = await doneBill(w.a, "credit");                      // 200, three days ago
  await backdate(first, 3);
  const second = await doneBill(w.a, "credit", { qty: 2 });         // 80, yesterday
  await backdate(second, 1);
  await repay(w.a.clients.biller, w.a.customerId, 150);
  const oldest = async () => ymdOf((await w.a.clients.admin.rpc("dues_list")).data[0].oldest_unpaid);
  assertEqual(await oldest(), await kolkataDay(-3), "150 of 200 paid: the first charge is still open");
  await repay(w.a.clients.biller, w.a.customerId, 50);
  assertEqual(await oldest(), await kolkataDay(-1), "the first charge is covered: the second is oldest");
});

test("customer_dues: bills, openings, repayments and reversals, newest first, with names and the closed flag", async () => {
  const w = await seedTwoVendors();
  const bill = await doneBill(w.a, "credit");
  await backdate(bill, 1);
  const voided = await doneBill(w.a, "credit", { qty: 1 });
  await w.a.clients.biller.rpc("void_bill", { p_bill_id: voided, p_reason: "x" });   // not listed
  await w.a.clients.admin.rpc("record_opening_balance", { p_customer: w.a.customerId, p_amount: 30, p_note: "khata" });
  const { data: r } = await repay(w.a.clients.biller, w.a.customerId, 20, "upi");
  await w.a.clients.admin.rpc("reverse_dues_entry", { p_entry: r.id, p_reason: "typo" });
  await repay(w.a.clients.biller, w.a.customerId, 10);
  await w.a.clients.biller.rpc("close_day", { p_date: await kolkataDay(), p_counted_cash: 10, p_note: null });

  const { data, error } = await w.a.clients.biller.rpc("customer_dues", { p_customer: w.a.customerId });
  assert(!error, error?.message);
  assertEqual(data.map((e) => e.kind), ["repayment", "repayment", "opening", "credit_bill"], "order");
  const [latest, reversed, opening, credit] = data;
  assertEqual([Number(latest.amount), latest.mode, latest.by_name, latest.day_closed],
    [10, "cash", "Biller A", true], "latest repayment");
  assertEqual([reversed.reverse_reason, reversed.reversed_by_name], ["typo", "Admin A"], "reversal");
  assertEqual([opening.note, opening.day_closed], ["khata", false], "an opening is never day-locked");
  assertEqual([credit.id, Number(credit.amount), typeof credit.token_no], [bill, 200, "number"], "credit bill");
  const { data: other } = await w.b.clients.admin.rpc("customer_dues", { p_customer: w.a.customerId });
  assertEqual(other, [], "B read A's customer's timeline");
});

test("cash repayments count in expected cash and day_summary; UPI, card, openings and reversals do not", async () => {
  const w = await seedTwoVendors();
  await doneBill(w.a, "cash");                                      // cash sale 200
  await doneBill(w.a, "credit");                                    // owes 200
  await w.a.clients.admin.rpc("record_opening_balance", { p_customer: w.a.customerId, p_amount: 500, p_note: "khata" });
  await repay(w.a.clients.biller, w.a.customerId, 100, "cash");
  await repay(w.a.clients.biller, w.a.customerId, 50, "upi");
  await repay(w.a.clients.biller, w.a.customerId, 25, "card");
  const { data: wrong } = await repay(w.a.clients.biller, w.a.customerId, 30, "cash");
  await w.a.clients.biller.rpc("reverse_dues_entry", { p_entry: wrong.id, p_reason: "typo" });

  const { data, error } = await w.a.clients.biller.rpc("day_summary", {});
  assert(!error, error?.message);
  const s = data[0];
  assertEqual(
    [s.cash, s.dues_cash, s.dues_cash_count, s.dues_upi, s.dues_upi_count, s.dues_card, s.dues_card_count,
     s.expected_cash].map(Number),
    [200, 100, 1, 50, 1, 25, 1, 300], "summary");
  const { data: closed, error: ce } = await w.a.clients.biller.rpc("close_day",
    { p_date: await kolkataDay(), p_counted_cash: 300, p_note: null });
  assert(!ce, ce?.message);
  assertEqual(Number(closed.expected_cash), 300, "close counts cash sales plus cash dues");
});

test("clearing the shop's data removes its dues entries", async () => {
  const w = await seedTwoVendors();
  await doneBill(w.a, "credit");
  await repay(w.a.clients.biller, w.a.customerId, 10);
  await w.a.clients.admin.rpc("record_opening_balance", { p_customer: w.a.customerId, p_amount: 5, p_note: "k" });
  const { error } = await w.a.clients.admin.rpc("clear_vendor_data");
  assert(!error, error?.message);
  const { rows } = await sql(`select count(*)::int n from dues_entries where vendor_id = $1`, [w.a.vendorId]);
  assertEqual(rows[0].n, 0, "left behind");
});

test("unclosed_days lists a past day whose only cash was a repayment, until it is closed", async () => {
  const w = await seedTwoVendors();
  await sql(`update vendors set day_close_from = (now() at time zone 'Asia/Kolkata')::date - 10 where id = $1`,
    [w.a.vendorId]);
  await doneBill(w.a, "credit");                                       // today: owes 200, never listed
  const move = (id, days) => sql(
    `update dues_entries set business_date = (now() at time zone 'Asia/Kolkata')::date - $2::int,
                             created_at = created_at - ($2 || ' days')::interval where id = $1`,
    [id, days]);
  const { data: r } = await repay(w.a.clients.biller, w.a.customerId, 50);
  await move(r.id, 2);                                                 // listed
  const { data: gone } = await repay(w.a.clients.biller, w.a.customerId, 20);
  const { error: rv } = await w.a.clients.admin.rpc("reverse_dues_entry", { p_entry: gone.id, p_reason: "x" });
  assert(!rv, rv?.message);
  await move(gone.id, 3);                                              // reversed: not listed
  const { data: ob } = await w.a.clients.admin.rpc("record_opening_balance",
    { p_customer: w.a.customerId, p_amount: 10, p_note: "khata" });
  await move(ob.id, 4);                                                // an opening moves no cash
  const { data: early } = await repay(w.a.clients.biller, w.a.customerId, 5);
  await move(early.id, 12);                                            // before day_close_from
  const twoAgo = await kolkataDay(-2);

  const { data, error } = await w.a.clients.biller.rpc("unclosed_days");
  assert(!error, error?.message);
  assertEqual(data.map((d) => ymdOf(d.business_date)), [twoAgo], "the repayment-only day");
  const { data: other } = await w.b.clients.admin.rpc("unclosed_days");
  assertEqual(other, [], "B sees none of A's days");

  const { error: c } = await w.a.clients.biller.rpc("close_day",
    { p_date: twoAgo, p_counted_cash: 50, p_note: null });
  assert(!c, c?.message);
  const { data: after } = await w.a.clients.biller.rpc("unclosed_days");
  assertEqual(after, [], "closed day no longer listed");
});
