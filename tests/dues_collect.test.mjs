import { test, assert, assertEqual } from "./framework.mjs";
import { sql } from "./fixtures.mjs";
import { seedTwoVendors } from "./seed.mjs";

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
const repay = (client, customer, amount, mode = "cash") =>
  client.rpc("record_repayment", { p_customer: customer, p_amount: amount, p_mode: mode, p_note: null });
// credit_open() as superuser sees every vendor; filter to one.
const openOf = async (billId) =>
  Number((await sql(`select open from credit_open() where bill_id = $1`, [billId])).rows[0]?.open ?? NaN);

test("credit_open is FIFO: the opening is cleared first, then the oldest bill", async () => {
  const w = await seedTwoVendors();
  const a = await doneBill(w.a, "credit");                 // 200, two days ago
  await backdate(a, 2);
  const b = await doneBill(w.a, "credit", { qty: 2 });     // 80, yesterday
  await backdate(b, 1);
  await w.a.clients.admin.rpc("record_opening_balance",
    { p_customer: w.a.customerId, p_amount: 100, p_note: "khata" });   // entered today, still first
  await repay(w.a.clients.biller, w.a.customerId, 150);
  assertEqual([await openOf(a), await openOf(b)], [150, 80], "opening 100 cleared, then 50 off the oldest bill");
  await repay(w.a.clients.biller, w.a.customerId, 200);
  assertEqual([await openOf(a), await openOf(b)], [0, 30], "oldest bill cleared, then 50 off the next");
});

test("credit_open: overpaid customer is all zero; unassigned bill is fully open; voided bill is gone", async () => {
  const w = await seedTwoVendors();
  const kept = await doneBill(w.a, "credit", { qty: 1 });  // 40
  const voided = await doneBill(w.a, "credit");            // 200
  await repay(w.a.clients.biller, w.a.customerId, 150);
  await w.a.clients.biller.rpc("void_bill", { p_bill_id: voided, p_reason: "x" });   // paid 150 > owed 40
  assertEqual(await openOf(kept), 0, "overpaid");
  const { rows } = await sql(`select count(*)::int n from credit_open() where bill_id = $1`, [voided]);
  assertEqual(rows[0].n, 0, "a voided bill is not listed");
  const orphan = await doneBill(w.a, "credit", { qty: 2 }); // 80
  await sql(`update bills set customer_id = null where id = $1`, [orphan]);
  assertEqual(await openOf(orphan), 80, "an unassigned bill cannot be repaid, so it is fully open");
  const { data } = await w.b.clients.admin.rpc("credit_open");
  assertEqual(data, [], "B sees none of A's");
});

test("day_summary: credit_open falls as dues are paid, even after the day is closed; the close is untouched", async () => {
  const w = await seedTwoVendors();
  const bill = await doneBill(w.a, "credit");              // 200, yesterday
  await backdate(bill, 1);
  const yesterday = await kolkataDay(-1);
  const summary = async () => (await w.a.clients.biller.rpc("day_summary", { p_date: yesterday })).data[0];

  let s = await summary();
  assertEqual([Number(s.credit), Number(s.credit_count), Number(s.credit_open), Number(s.credit_open_count)],
    [200, 1, 200, 1], "before any payment");
  const { error: c } = await w.a.clients.biller.rpc("close_day", { p_date: yesterday, p_counted_cash: 0, p_note: null });
  assert(!c, c?.message);

  await repay(w.a.clients.biller, w.a.customerId, 50, "upi");
  s = await summary();
  assertEqual([Number(s.credit), Number(s.credit_open), Number(s.credit_open_count)], [200, 150, 1], "part paid");
  await repay(w.a.clients.biller, w.a.customerId, 150, "cash");
  s = await summary();
  assertEqual([Number(s.credit_open), Number(s.credit_open_count)], [0, 0], "fully paid");

  const { rows } = await sql(`select expected_cash, counted_cash from day_closes
                               where vendor_id = $1 and business_date = $2::date`, [w.a.vendorId, yesterday]);
  assertEqual([Number(rows[0].expected_cash), Number(rows[0].counted_cash)], [0, 0], "the closed count never moves");
});

test("payment_split_between adds dues by mode and uncollected credit", async () => {
  const w = await seedTwoVendors();
  await doneBill(w.a, "cash");                              // 200 cash sale
  await doneBill(w.a, "credit");                            // 200 credit
  await repay(w.a.clients.biller, w.a.customerId, 30, "upi");
  await repay(w.a.clients.biller, w.a.customerId, 20, "cash");
  const { data, error } = await w.a.clients.admin.rpc("payment_split_between",
    { p_from: new Date(Date.now() - 86400000).toISOString(), p_to: new Date(Date.now() + 86400000).toISOString() });
  assert(!error, error?.message);
  const by = Object.fromEntries(data.map((r) => [r.mode, [Number(r.total), Number(r.bill_count)]]));
  assertEqual(by.cash, [200, 1], "sales unchanged");
  assertEqual(by.credit, [200, 1], "credit given unchanged");
  assertEqual(by.dues_upi, [30, 1], "dues by upi");
  assertEqual(by.dues_cash, [20, 1], "dues by cash");
  assertEqual(by.credit_open, [150, 1], "uncollected credit");
});

const due = async (customerId) =>
  Number((await sql(`select customer_due($1) d`, [customerId])).rows[0].d);
const complete = (client, bill, mode, collect) =>
  client.rpc("complete_bill", collect === undefined
    ? { p_bill_id: bill, p_payment_mode: mode }
    : { p_bill_id: bill, p_payment_mode: mode, p_collect_due: collect });

test("collecting a due with a bill: one repayment linked to the bill, counted in the day's cash", async () => {
  const w = await seedTwoVendors();
  await doneBill(w.a, "credit");                            // owes 200
  const bill = await billedBill(w.a);                       // new 200 bill
  const { error } = await complete(w.a.clients.biller, bill, "cash", 150);
  assert(!error, error?.message);
  const { rows } = await sql(`select kind, mode, amount, bill_id, created_by from dues_entries where vendor_id = $1`, [w.a.vendorId]);
  assertEqual(rows.map((r) => [r.kind, r.mode, Number(r.amount), r.bill_id, r.created_by]),
    [["repayment", "cash", 150, bill, w.a.billerId]], "one linked repayment");
  assertEqual(await due(w.a.customerId), 50, "balance after");
  const { data } = await w.a.clients.biller.rpc("day_summary", {});
  assertEqual([Number(data[0].cash), Number(data[0].dues_cash), Number(data[0].expected_cash)], [200, 150, 350],
    "the sale stays a sale; the due is a repayment; both are cash in the drawer");
});

test("a retry of a completed bill that collected a due records nothing more", async () => {
  const w = await seedTwoVendors();
  await doneBill(w.a, "credit");
  const bill = await billedBill(w.a);
  await complete(w.a.clients.biller, bill, "upi", 100);
  const { error } = await complete(w.a.clients.biller, bill, "upi", 100);
  assert(!error, `retry refused: ${error?.message}`);
  const { rows } = await sql(`select count(*)::int n from dues_entries where bill_id = $1`, [bill]);
  assertEqual(rows[0].n, 1, "recorded once");
});

test("a refused collect writes nothing: the bill stays pending", async () => {
  const w = await seedTwoVendors();
  await doneBill(w.a, "credit", { qty: 1 });                // owes 40
  const bill = await billedBill(w.a);
  const cases = [
    [40.01, "cash", /more than the balance/],
    [10, "credit", /can only be collected in cash, upi or card/],
    [1.005, "cash", /zero or more, to the paisa/],
    [-1, "cash", /zero or more, to the paisa/],
  ];
  for (const [amount, mode, re] of cases) {
    const { error } = await complete(w.a.clients.biller, bill, mode, amount);
    assert(error && re.test(error.message), `amount=${amount} mode=${mode}: ${error?.message ?? "success"}`);
  }
  const { rows: [b] } = await sql(`select status from bills where id = $1`, [bill]);
  assertEqual(b.status, "billed", "still pending");
  const { rows } = await sql(
    `select (select count(*) from dues_entries where vendor_id = $1 and kind = 'repayment')::int d,
            (select count(*) from bill_payments where bill_id = $2)::int p`, [w.a.vendorId, bill]);
  assertEqual(rows[0], { d: 0, p: 0 }, "nothing written");
});

test("a collect on a bill with no customer is refused", async () => {
  const w = await seedTwoVendors();
  const bill = await billedBill(w.a, { customerId: null });
  const { error } = await complete(w.a.clients.biller, bill, "cash", 10);
  assert(error && /credit needs a customer/.test(error.message), `got ${error?.message ?? "success"}`);
});

test("without p_collect_due (an old tab) or with 0, completion is unchanged and records no due", async () => {
  const w = await seedTwoVendors();
  await doneBill(w.a, "credit");
  const old = await billedBill(w.a);
  const { error: e1 } = await complete(w.a.clients.biller, old, "cash");
  assert(!e1, e1?.message);
  const zero = await billedBill(w.a);
  const { error: e2 } = await complete(w.a.clients.biller, zero, "card", 0);
  assert(!e2, e2?.message);
  const { rows } = await sql(`select count(*)::int n from dues_entries where vendor_id = $1`, [w.a.vendorId]);
  assertEqual(rows[0].n, 0, "no due recorded");
  assertEqual(await due(w.a.customerId), 200, "still owed");
});
