import { test, assert, assertEqual } from "./framework.mjs";
import { sql } from "./fixtures.mjs";
import { seedTwoVendors } from "./seed.mjs";

test("_complete_bill_core is not callable by a signed-in user", async () => {
  const { rows } = await sql(`select count(*)::int n from pg_proc where proname = '_complete_bill_core'`);
  assertEqual(rows[0].n, 1, "core exists");

  const w = await seedTwoVendors();
  const { error } = await w.a.clients.admin.rpc("_complete_bill_core", {
    p_bill_id: "00000000-0000-0000-0000-000000000000", p_biller_id: null, p_redeem_points: 0,
    p_payment_mode: "cash", p_collect_due: 0, p_at: new Date().toISOString(), p_notify: false,
  });
  assert(error, "must be refused");
  assert(/permission denied|not find|does not exist/i.test(error.message), error.message);
});

const payload = (v, over = {}) => ({
  lines: [{ item_id: v.itemId, qty_kg: 2, unit_price: 40 }],
  customer_id: v.customerId, payment_mode: "cash", redeem_points: 0, collect_due: 0,
  occurred_at: new Date().toISOString(), device_label: "Offline #1", ...over,
});
const rec = (client, id, p) => client.rpc("record_offline_bill", { p_client_id: id, p_bill: p });
const uuid = () => crypto.randomUUID();
const issuesOf = async (billId) => (await sql(
  `select kind, amount::float amount from sync_issues where bill_id = $1 order by kind`, [billId])).rows;

test("record_offline_bill: a recorder records a done, paid, tokened bill with no message", async () => {
  const w = await seedTwoVendors();
  const id = uuid();
  const { data, error } = await rec(w.a.clients.recorder, id, payload(w.a));
  assert(!error, error?.message);
  assert(data.token_no > 0, "real token");
  assertEqual(data.issues, [], "no issues");
  const { rows: [b] } = await sql(`select status, total::float total, client_id, device_label from bills where id = $1`, [data.bill_id]);
  assertEqual([b.status, b.total, b.client_id, b.device_label], ["done", 80, id, "Offline #1"], "bill");
  const { rows: [p] } = await sql(`select mode, amount::float amount from bill_payments where bill_id = $1`, [data.bill_id]);
  assertEqual([p.mode, p.amount], ["cash", 80], "payment");
  const { rows: [s] } = await sql(`select stock_kg::float s from items where id = $1`, [w.a.itemId]);
  assertEqual(s.s, 98, "stock moved");
  const { rows: [m] } = await sql(`select count(*)::int n from outbound_messages where customer_id = $1`, [w.a.customerId]);
  assertEqual(m.n, 0, "no customer notification");
});

test("record_offline_bill: resending the same client_id returns the first bill and writes nothing", async () => {
  const w = await seedTwoVendors();
  const id = uuid();
  const first = (await rec(w.a.clients.biller, id, payload(w.a))).data;
  const second = await rec(w.a.clients.biller, id, payload(w.a, { lines: [{ item_id: w.a.itemId, qty_kg: 9, unit_price: 1 }] }));
  assert(!second.error, second.error?.message);
  assertEqual(second.data, first, "same result");
  const { rows } = await sql(`select count(*)::int n from bills where client_id = $1`, [id]);
  assertEqual(rows[0].n, 1, "one bill");
  const { rows: [s] } = await sql(`select stock_kg::float s from items where id = $1`, [w.a.itemId]);
  assertEqual(s.s, 98, "stock moved once");
});

test("record_offline_bill: another shop's client_id is refused, not returned", async () => {
  const w = await seedTwoVendors();
  const id = uuid();
  await rec(w.a.clients.admin, id, payload(w.a));
  const { error } = await rec(w.b.clients.admin, id, payload(w.b));
  assert(error, "refused");
});

test("record_offline_bill: redemption beyond the balance is capped and flagged", async () => {
  const w = await seedTwoVendors();
  await sql(`insert into points_ledger (vendor_id, customer_id, points, expires_at)
             values ($1,$2,30, now() + interval '30 days')`, [w.a.vendorId, w.a.customerId]);
  const { data, error } = await rec(w.a.clients.admin, uuid(), payload(w.a, { redeem_points: 50 }));
  assert(!error, error?.message);
  assertEqual(data.issues, [{ kind: "redeem_shortfall", amount: 20 }], "shortfall of 20");
  const { rows: [b] } = await sql(`select redeemed_points, total::float total from bills where id = $1`, [data.bill_id]);
  assertEqual([b.redeemed_points, b.total], [30, 50], "redeemed what existed");
});

test("record_offline_bill: collecting more due than owed is capped and flagged", async () => {
  const w = await seedTwoVendors();
  await w.a.clients.admin.rpc("record_opening_balance", { p_customer: w.a.customerId, p_amount: 25, p_note: "khata" });
  const { data, error } = await rec(w.a.clients.biller, uuid(), payload(w.a, { collect_due: 100 }));
  assert(!error, error?.message);
  assertEqual(data.issues, [{ kind: "due_overcollected", amount: 75 }], "75 over");
  const { rows: [d] } = await sql(`select amount::float a from dues_entries where bill_id = $1`, [data.bill_id]);
  assertEqual(d.a, 25, "collected what was owed");
});

test("record_offline_bill: an open earlier day keeps its time; a closed one is rebooked to now", async () => {
  const w = await seedTwoVendors();
  const twoDaysAgo = new Date(Date.now() - 2 * 86400e3).toISOString();
  const open = (await rec(w.a.clients.admin, uuid(), payload(w.a, { occurred_at: twoDaysAgo }))).data;
  const { rows: [o] } = await sql(`select abs(extract(epoch from completed_at - $2::timestamptz)) < 1 same from bills where id = $1`, [open.bill_id, twoDaysAgo]);
  assert(o.same, "completed_at is the offline time");
  assertEqual(open.issues, [], "no issue");

  const yesterday = (await sql(`select ((now() at time zone 'Asia/Kolkata')::date - 1)::text d`)).rows[0].d;
  await w.a.clients.admin.rpc("close_day", { p_date: yesterday, p_counted_cash: 0, p_note: "x" });
  const at = new Date(Date.now() - 86400e3).toISOString();
  const moved = (await rec(w.a.clients.admin, uuid(), payload(w.a, { occurred_at: at }))).data;
  assertEqual(moved.issues.map((i) => i.kind), ["rebooked_closed_day"], "flagged");
  const { rows: [m] } = await sql(`select (completed_at at time zone 'Asia/Kolkata')::date::text d, occurred_at is not null kept from bills where id = $1`, [moved.bill_id]);
  assert(m.d !== yesterday && m.kept, "booked to today, original time kept");
});

test("record_offline_bill: when today is closed too, the call is refused and nothing is written", async () => {
  const w = await seedTwoVendors();
  const today = (await sql(`select (now() at time zone 'Asia/Kolkata')::date::text d`)).rows[0].d;
  const { error: c } = await w.a.clients.admin.rpc("close_day", { p_date: today, p_counted_cash: 0, p_note: "x" });
  assert(!c, c?.message);
  const id = uuid();
  const { error } = await rec(w.a.clients.admin, id, payload(w.a));
  assert(error && /day is closed/.test(error.message), error?.message);
  const { rows } = await sql(`select count(*)::int n from bills where client_id = $1`, [id]);
  assertEqual(rows[0].n, 0, "nothing written");
});

test("record_offline_bill: a future or too-old time is clamped and flagged", async () => {
  const w = await seedTwoVendors();
  const future = (await rec(w.a.clients.admin, uuid(), payload(w.a, { occurred_at: new Date(Date.now() + 3600e3).toISOString() }))).data;
  assertEqual(future.issues.map((i) => i.kind), ["time_clamped"], "future clamped");
  const old = (await rec(w.a.clients.admin, uuid(), payload(w.a, { occurred_at: new Date(Date.now() - 30 * 86400e3).toISOString() }))).data;
  assertEqual(old.issues.map((i) => i.kind), ["time_clamped"], "old clamped");
  const { rows: [b] } = await sql(`select now() - completed_at < interval '7 days 1 minute' ok from bills where id = $1`, [old.bill_id]);
  assert(b.ok, "within 7 days");
});

test("record_offline_bill: a deleted item rejects the whole bill", async () => {
  const w = await seedTwoVendors();
  const { error } = await rec(w.a.clients.admin, uuid(), payload(w.a, {
    lines: [{ item_id: crypto.randomUUID(), qty_kg: 1, unit_price: 10 }] }));
  assert(error && /no longer exists/.test(error.message), error?.message);
});

test("record_offline_bill: credit is recorded as udhaar", async () => {
  const w = await seedTwoVendors();
  const { data } = await rec(w.a.clients.recorder, uuid(), payload(w.a, { payment_mode: "credit" }));
  const { rows: [d] } = await sql(`select customer_due($1)::float d`, [w.a.customerId]);
  assertEqual(d.d, 80, "owes 80");
  assert(data.token_no > 0);
});

test("sync_issues: admin reads, recorder and other shop do not", async () => {
  const w = await seedTwoVendors();
  await rec(w.a.clients.admin, uuid(), payload(w.a, { occurred_at: new Date(Date.now() + 3600e3).toISOString() }));
  const a = await w.a.clients.admin.from("sync_issues").select("kind");
  assertEqual(a.data.length, 1, "admin sees it");
  const r = await w.a.clients.recorder.from("sync_issues").select("kind");
  assertEqual(r.data, [], "recorder does not");
  const b = await w.b.clients.admin.from("sync_issues").select("kind");
  assertEqual(b.data, [], "other shop does not");
});

async function shortfall(w) {
  const { data } = await rec(w.a.clients.admin, uuid(), payload(w.a, { redeem_points: 15 }));
  return (await sql(`select id from sync_issues where bill_id = $1`, [data.bill_id])).rows[0].id;
}

test("resolve_sync_issue: add_as_due writes an opening due and closes the issue; twice is refused", async () => {
  const w = await seedTwoVendors();
  const id = await shortfall(w);
  const { error } = await w.a.clients.admin.rpc("resolve_sync_issue", { p_id: id, p_action: "add_as_due" });
  assert(!error, error?.message);
  const { rows: [d] } = await sql(`select customer_due($1)::float d`, [w.a.customerId]);
  assertEqual(d.d, 15, "customer owes the shortfall");
  const again = await w.a.clients.admin.rpc("resolve_sync_issue", { p_id: id, p_action: "dismiss" });
  assert(again.error && /already resolved/.test(again.error.message), again.error?.message);
});

test("resolve_sync_issue: add_as_due is refused for other kinds; dismiss works; non-admin refused", async () => {
  const w = await seedTwoVendors();
  const { data } = await rec(w.a.clients.admin, uuid(), payload(w.a, { occurred_at: new Date(Date.now() + 3600e3).toISOString() }));
  const id = (await sql(`select id from sync_issues where bill_id = $1`, [data.bill_id])).rows[0].id;
  const bad = await w.a.clients.admin.rpc("resolve_sync_issue", { p_id: id, p_action: "add_as_due" });
  assert(bad.error, "time_clamped cannot become a due");
  const biller = await w.a.clients.biller.rpc("resolve_sync_issue", { p_id: id, p_action: "dismiss" });
  assert(biller.error, "biller refused");
  const ok = await w.a.clients.admin.rpc("resolve_sync_issue", { p_id: id, p_action: "dismiss" });
  assert(!ok.error, ok.error?.message);
  const { data: open } = await w.a.clients.admin.rpc("open_sync_issues");
  assertEqual(open, [], "none open");
});

test("open_sync_issues lists the shop's open issues with token and customer", async () => {
  const w = await seedTwoVendors();
  await shortfall(w);
  const { data, error } = await w.a.clients.admin.rpc("open_sync_issues");
  assert(!error, error?.message);
  assertEqual(data.length, 1);
  assertEqual([data[0].kind, Number(data[0].amount), data[0].customer_name], ["redeem_shortfall", 15, "Cust A"]);
  assert(data[0].token_no > 0);
  const r = await w.a.clients.recorder.rpc("open_sync_issues");
  assert(r.error, "recorder refused");
});

test("offline_balances: points and due per customer, own shop only", async () => {
  const w = await seedTwoVendors();
  await sql(`insert into points_ledger (vendor_id, customer_id, points, expires_at)
             values ($1,$2,12, now() + interval '5 days'), ($1,$2,99, now() - interval '1 day')`,
            [w.a.vendorId, w.a.customerId]);
  await w.a.clients.admin.rpc("record_opening_balance", { p_customer: w.a.customerId, p_amount: 30, p_note: "k" });
  const { data, error } = await w.a.clients.recorder.rpc("offline_balances");
  assert(!error, error?.message);
  assertEqual(data.map((r) => [r.customer_id, r.points, Number(r.due)]), [[w.a.customerId, 12, 30]]);
});
