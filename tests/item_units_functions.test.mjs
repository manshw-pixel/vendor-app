import { test, assert, assertDenied, assertEqual, once } from "./framework.mjs";
import { sql } from "./fixtures.mjs";
import { seedTwoVendors } from "./seed.mjs";

async function world() {
  const w = await seedTwoVendors();
  const item = async (unit, price) => (await sql(
    `insert into items (vendor_id, name_en, name_hi, name_mr, price, stock_kg, unit, last_cost)
     values ($1,$2,$2,$2,$3,100,$4,5) returning id`, [w.a.vendorId, `F-${unit}`, price, unit])).rows[0].id;
  return { ...w, coconut: await item("piece", 30), onion: await item("kg", 40) };
}
const getW = once(world);
const recordingBill = async (w) => (await sql(
  `insert into bills (vendor_id, customer_id, recorder_id, total, status) values ($1,$2,$3,0,'recording') returning id`,
  [w.a.vendorId, w.a.customerId, w.a.recorderId])).rows[0].id;
const lines = (w, billId, arr) => w.a.clients.recorder.rpc("replace_bill_lines", { p_bill_id: billId, p_lines: arr });

test("replace_bill_lines refuses a fractional quantity of a piece item", async () => {
  const w = await getW();
  const b = await recordingBill(w);
  const { error } = await lines(w, b, [{ item_id: w.coconut, qty_kg: 1.5, unit_price: 30 }]);
  assertDenied(error, "1.5 coconuts accepted");
  assert(/whole number/i.test(error.message), error.message);
  const { rows } = await sql(`select count(*)::int n from bill_items where bill_id=$1`, [b]);
  assertEqual(rows[0].n, 0, "lines written despite refusal");
});

test("replace_bill_lines accepts whole pieces and fractional kg in one basket", async () => {
  const w = await getW();
  const b = await recordingBill(w);
  const { error } = await lines(w, b, [
    { item_id: w.coconut, qty_kg: 2, unit_price: 30 },
    { item_id: w.onion, qty_kg: 1.25, unit_price: 40 },
  ]);
  assert(!error, error?.message);
  const { rows } = await sql(`select sum(line_total) t from bill_items where bill_id=$1`, [b]);
  assertEqual(Number(rows[0].t), 110, "60 + 50");
});

test("log_stock_movement refuses fractional pieces and accepts fractional kg", async () => {
  const w = await getW();
  const bad = await w.a.clients.recorder.rpc("log_stock_movement", { p_item_id: w.coconut, p_kind: "purchase", p_qty_kg: 2.5, p_unit_cost: 20 });
  assertDenied(bad.error, "2.5 coconuts purchased");
  assert(/whole number/i.test(bad.error.message), bad.error.message);
  const okPiece = await w.a.clients.recorder.rpc("log_stock_movement", { p_item_id: w.coconut, p_kind: "purchase", p_qty_kg: 3, p_unit_cost: 20 });
  assert(!okPiece.error, okPiece.error?.message);
  const okKg = await w.a.clients.recorder.rpc("log_stock_movement", { p_item_id: w.onion, p_kind: "wastage", p_qty_kg: 0.5 });
  assert(!okKg.error, okKg.error?.message);
  const { rows: [c] } = await sql(`select stock_kg from items where id=$1`, [w.coconut]);
  assertEqual(Number(c.stock_kg), 103, "stock after the 3-piece purchase");
});

test("log_stock_movement still refuses over-stock wastage after the guard", async () => {
  const w = await getW();
  const { error } = await w.a.clients.recorder.rpc("log_stock_movement", { p_item_id: w.coconut, p_kind: "wastage", p_qty_kg: 1000 });
  assertDenied(error, "over-stock wastage accepted");
  assert(/wastage exceeds stock/.test(error.message), error.message);
});

test("top_items_between ranks by revenue and returns the unit", async () => {
  const w = await getW();
  const done = async (itemId, qty, price) => {
    const b = await recordingBill(w);
    await sql(`insert into bill_items (bill_id, vendor_id, item_id, qty_kg, unit_price, line_total) values ($1,$2,$3,$4,$5,$6)`,
      [b, w.a.vendorId, itemId, qty, price, qty * price]);
    await sql(`select issue_token($1)`, [b]);
    await sql(`select complete_bill($1)`, [b]);
  };
  // Discriminates revenue-ranking from quantity-ranking: by quantity onion (9) beats
  // coconut (4), but by revenue coconut (400) beats onion (360), so this only passes if
  // the function truly ranks by revenue.
  await done(w.coconut, 4, 100);
  await done(w.onion, 9, 40);
  const now = Date.now();
  const { data, error } = await w.a.clients.admin.rpc("top_items_between", {
    p_from: new Date(now - 3600e3).toISOString(), p_to: new Date(now + 3600e3).toISOString() });
  assert(!error, error?.message);
  const ours = data.filter((r) => r.item_id === w.coconut || r.item_id === w.onion);
  assertEqual(ours[0].item_id, w.coconut, "400 of coconuts must outrank 360 of onion");
  assertEqual(ours[0].unit, "piece", "unit missing");
  assertEqual(Number(ours[0].total_qty_kg), 4, "quantity in pieces");
  assertEqual(ours[1].unit, "kg", "onion unit");
});

test("stock_movements_between returns the unit", async () => {
  const w = await getW();
  const now = Date.now();
  const { data } = await w.a.clients.admin.rpc("stock_movements_between", {
    p_from: new Date(now - 3600e3).toISOString(), p_to: new Date(now + 3600e3).toISOString() });
  const row = data.find((r) => r.item_id === w.coconut);
  assert(row, "coconut movement missing");
  assertEqual(row.unit, "piece", "unit");
});
