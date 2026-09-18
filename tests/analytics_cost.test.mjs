import { test, assert, assertEqual, assertInvisible, once } from "./framework.mjs";
import { sql } from "./fixtures.mjs";
import { seedTwoVendors } from "./seed.mjs";

// Explicit timestamps, never now()-relative: a clock-relative test fails at midnight.
const SEP = ["2026-09-01T00:00:00Z", "2026-10-01T00:00:00Z"];

// Builds the costed bills inside world A, so an RLS-scoped admin client sees exactly
// these rows and nothing from any other test file's vendors.
async function costedWorld() {
  const w = await seedTwoVendors();
  const v = w.a.vendorId;
  const item = async (n) => (await sql(
    `insert into items (vendor_id, name_en, name_hi, name_mr, price, stock_kg)
     values ($1,$2,$3,$4,50,100) returning id`, [v, n, `${n}-hi`, `${n}-mr`])).rows[0].id;
  const onion = await item("Onion");
  const garlic = await item("Garlic");
  const bill = async (lines, when, total) => {
    const { rows: [b] } = await sql(
      `insert into bills (vendor_id, customer_id, total, status, completed_at)
       values ($1,$2,$3,'done',$4::timestamptz) returning id`, [v, w.a.customerId, total, when]);
    for (const [id, qty, lt, uc] of lines) {
      await sql(`insert into bill_items (bill_id, vendor_id, item_id, qty_kg, unit_price, line_total, unit_cost)
                 values ($1,$2,$3,$4,50,$5,$6)`, [b.id, v, id, qty, lt, uc]);
    }
  };
  // Onion 2 kg sold for 100 at cost 30/kg -> cost 60. Garlic 1 kg for 50, never costed.
  await bill([[onion, 2, 100, 30], [garlic, 1, 50, null]], "2026-09-09T04:00:00Z", 150);
  // Onion 4 kg sold for 200 at cost 35/kg -> cost 140.
  await bill([[onion, 4, 200, 35]], "2026-09-10T04:00:00Z", 200);
  // August: outside the window.
  await bill([[onion, 10, 500, 1]], "2026-08-10T04:00:00Z", 500);
  return { ...w, onion, garlic };
}
const getC = once(costedWorld);
const rpc = (w, fn) => w.a.clients.admin.rpc(fn, { p_from: SEP[0], p_to: SEP[1] });

test("collected_between reports cost, profit and uncosted lines", async () => {
  const w = await getC();
  const { data, error } = await rpc(w, "collected_between");
  assert(!error, error?.message);
  const r = data[0];
  assertEqual(Number(r.total), 350, "total");
  assertEqual(Number(r.bill_count), 2, "bill_count");
  assertEqual(Number(r.cost), 200, "cost = 60 + 140; garlic excluded");
  assertEqual(Number(r.profit), 150, "profit = 350 - 200");
  assertEqual(Number(r.uncosted_lines), 1, "the garlic line");
});

test("collected_between over an empty range returns zeros, not nulls", async () => {
  const w = await getC();
  const { data } = await w.a.clients.admin.rpc("collected_between", {
    p_from: "2020-01-01T00:00:00Z", p_to: "2020-01-02T00:00:00Z" });
  const r = data[0];
  assertEqual(Number(r.total), 0, "total");
  assertEqual(Number(r.cost), 0, "cost");
  assertEqual(Number(r.profit), 0, "profit");
  assertEqual(Number(r.uncosted_lines), 0, "uncosted");
});

test("top_items_between reports per-item cost and margin", async () => {
  const w = await getC();
  const { data, error } = await rpc(w, "top_items_between");
  assert(!error, error?.message);
  const onion = data.find((r) => r.item_id === w.onion);
  assertEqual(Number(onion.total_qty_kg), 6, "qty");
  assertEqual(Number(onion.total_revenue), 300, "revenue");
  assertEqual(Number(onion.total_cost), 200, "cost");
  assertEqual(Number(onion.margin), 100, "margin");
  assertEqual(Number(onion.uncosted_lines), 0, "onion fully costed");
});

test("an item with no costed lines has null cost and null margin", async () => {
  const w = await getC();
  const { data } = await rpc(w, "top_items_between");
  const garlic = data.find((r) => r.item_id === w.garlic);
  assertEqual(garlic.total_cost, null, "cost must be null, not zero");
  assertEqual(garlic.margin, null, "margin must be null, not revenue");
  assertEqual(Number(garlic.uncosted_lines), 1, "one uncosted line");
});

test("top_items_between keeps its ordering by quantity", async () => {
  const w = await getC();
  const { data } = await rpc(w, "top_items_between");
  const ours = data.filter((r) => r.item_id === w.onion || r.item_id === w.garlic);
  assertEqual(ours[0].item_id, w.onion, "6 kg of onion outranks 1 kg of garlic");
});

test("stock_movements_between lists movements in range with names and author", async () => {
  const w = await getC();
  const { error: e1 } = await w.a.clients.recorder.rpc("log_stock_movement", {
    p_item_id: w.onion, p_kind: "purchase", p_qty_kg: 5, p_unit_cost: 28, p_note: "vashi" });
  assert(!e1, e1?.message);
  const now = new Date();
  const { data, error } = await w.a.clients.admin.rpc("stock_movements_between", {
    p_from: new Date(now.getTime() - 3600e3).toISOString(),
    p_to: new Date(now.getTime() + 3600e3).toISOString() });
  assert(!error, error?.message);
  const row = data.find((r) => r.item_id === w.onion);
  assert(row, "the purchase is missing");
  assertEqual(row.name_mr, "Onion-mr", "all three names returned");
  assertEqual(row.note, "vashi", "note");
  assertEqual(row.created_by_name, "Recorder A", "author's name");
  assertEqual(Number(row.unit_cost), 28, "cost");
});

test("stock_movements_between excludes movements outside the range", async () => {
  const w = await getC();
  const { data } = await w.a.clients.admin.rpc("stock_movements_between", {
    p_from: "2020-01-01T00:00:00Z", p_to: "2020-01-02T00:00:00Z" });
  assertEqual(data.length, 0, "nothing was logged in 2020");
});

test("stock_movements_between does not leak across vendors", async () => {
  const w = await getC();
  await w.b.clients.recorder.rpc("log_stock_movement", {
    p_item_id: w.b.itemId, p_kind: "purchase", p_qty_kg: 1, p_unit_cost: 1 });
  const now = new Date();
  const { data } = await w.a.clients.admin.rpc("stock_movements_between", {
    p_from: new Date(now.getTime() - 3600e3).toISOString(),
    p_to: new Date(now.getTime() + 3600e3).toISOString() });
  assertInvisible(data.filter((r) => r.item_id === w.b.itemId), "A saw B's movement");
});
