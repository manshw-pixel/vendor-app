import { test, assert, assertEqual, once } from "./framework.mjs";
import { sql } from "./fixtures.mjs";
import { seedTwoVendors } from "./seed.mjs";

// Own world: this file voids bills and counts what is left, so nothing may share it.
async function world() {
  const w = await seedTwoVendors();
  const v = w.a;
  const item = async (n) => (await sql(
    `insert into items (vendor_id, name_en, name_hi, name_mr, price, stock_kg, last_cost)
     values ($1,$2,$3,$4,50,100,20) returning id`, [v.vendorId, n, n, n])).rows[0].id;
  const onion = await item("V-Onion");
  const tomato = await item("V-Tomato");
  // A done bill with two lines, completed now, through the real functions.
  const doneBill = async () => {
    const { rows: [b] } = await sql(
      `insert into bills (vendor_id, customer_id, total, status) values ($1,$2,0,'recording') returning id`,
      [v.vendorId, v.customerId]);
    for (const id of [onion, tomato]) {
      await sql(`insert into bill_items (bill_id, vendor_id, item_id, qty_kg, unit_price, line_total)
                 values ($1,$2,$3,2,50,100)`, [b.id, v.vendorId, id]);
    }
    await sql(`select issue_token($1)`, [b.id]);
    await sql(`select complete_bill($1, p_payment_mode => 'cash')`, [b.id]);
    return b.id;
  };
  const kept = [await doneBill(), await doneBill(), await doneBill()];
  const gone = await doneBill();
  const { error } = await v.clients.biller.rpc("void_bill", { p_bill_id: gone, p_reason: "test" });
  if (error) throw new Error(error.message);
  return { ...w, onion, tomato, kept, gone };
}
const getW = once(world);
const range = () => {
  const now = Date.now();
  return { p_from: new Date(now - 3600e3).toISOString(), p_to: new Date(now + 3600e3).toISOString() };
};

test("collected_between ignores the voided bill", async () => {
  const w = await getW();
  const { data } = await w.a.clients.admin.rpc("collected_between", range());
  assertEqual(Number(data[0].bill_count), 3, "bill_count counts the voided bill");
  assertEqual(Number(data[0].total), 600, "total includes the voided bill");
});

test("top_items_between ignores the voided bill", async () => {
  const w = await getW();
  const { data } = await w.a.clients.admin.rpc("top_items_between", range());
  const onion = data.find((r) => r.item_id === w.onion);
  assertEqual(Number(onion.total_qty_kg), 6, "voided kg counted");
});

test("bought_together_between still meets the threshold from the three kept bills only", async () => {
  const w = await getW();
  const { data } = await w.a.clients.admin.rpc("bought_together_between", range());
  const pair = data.find((r) => [r.item_a, r.item_b].includes(w.onion) && [r.item_a, r.item_b].includes(w.tomato));
  assert(pair, "pair missing");
  assertEqual(Number(pair.bill_count), 3, "voided bill counted in the pair");
});

test("the views exclude the voided bill", async () => {
  const w = await getW();
  const { data: pay } = await w.a.clients.admin.from("v_payments_daily").select("bill_count, total_collected");
  const count = pay.reduce((n, r) => n + Number(r.bill_count), 0);
  assertEqual(count, 3, "v_payments_daily counts the voided bill");
  const { data: top } = await w.a.clients.admin.from("v_top_items").select("total_qty_kg").eq("item_id", w.onion);
  assertEqual(Number(top[0].total_qty_kg), 6, "v_top_items counts the voided bill");
});

test("the completed list query pattern excludes it and the receipt read still finds it", async () => {
  const w = await getW();
  const { data: done } = await w.a.clients.biller.from("bills").select("id").eq("status", "done").in("id", [...w.kept, w.gone]);
  assertEqual(done.length, 3, "done filter");
  const { data: any } = await w.a.clients.biller.from("bills").select("id, status").eq("id", w.gone).in("status", ["done", "voided"]).maybeSingle();
  assertEqual(any.status, "voided", "receipt-style read");
});

test("voided_between counts and sums voided bills in range", async () => {
  const w = await getW();
  const { data, error } = await w.a.clients.admin.rpc("voided_between", range());
  assert(!error, error?.message);
  assertEqual(Number(data[0].void_count), 1, "count");
  assertEqual(Number(data[0].voided_total), 200, "total");
});

test("voided_between is zero out of range and does not leak across vendors", async () => {
  const w = await getW();
  const { data: old } = await w.a.clients.admin.rpc("voided_between", { p_from: "2020-01-01T00:00:00Z", p_to: "2020-01-02T00:00:00Z" });
  assertEqual(Number(old[0].void_count), 0, "out of range");
  assertEqual(Number(old[0].voided_total), 0, "out of range total must be 0 not null");
  const { data: b } = await w.b.clients.admin.rpc("voided_between", range());
  assertEqual(Number(b[0].void_count), 0, "B sees A's void");
});

test("maybeSingle errors, rather than silently picking one, when more than one row matches", async () => {
  const w = await getW();
  const { data, error } = await w.a.clients.biller
    .from("bills").select("id").eq("vendor_id", w.a.vendorId).maybeSingle();
  assert(error, "expected an error for multiple matching rows");
  assertEqual(error.code, "PGRST116", "error code");
  assertEqual(data, null, "data must be null alongside the error");
});
