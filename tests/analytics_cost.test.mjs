import { test, assert, assertEqual, assertInvisible, once } from "./framework.mjs";
import { sql } from "./fixtures.mjs";
import { seedTwoVendors } from "./seed.mjs";

// Explicit timestamps, never now()-relative: a clock-relative test fails at midnight.
const SEP = ["2026-09-01T00:00:00Z", "2026-10-01T00:00:00Z"];
const NOV = ["2026-11-01T00:00:00Z", "2026-12-01T00:00:00Z"];
const DEC = ["2026-12-01T00:00:00Z", "2027-01-01T00:00:00Z"];

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
const rpc = (w, fn, from = SEP[0], to = SEP[1]) =>
  w.a.clients.admin.rpc(fn, { p_from: from, p_to: to });

// A separate world in its own month, so its numbers never disturb costedWorld's
// collected_between/top_items_between assertions above. One line costed, one not, on the
// SAME item, in the same window -- the only case that exercises top_items_between's
// margin filter (a half-costed item), per fix-round-1 finding #2.
async function partialWorld() {
  const w = await seedTwoVendors();
  const v = w.a.vendorId;
  const { rows: [carrot] } = await sql(
    `insert into items (vendor_id, name_en, name_hi, name_mr, price, stock_kg)
     values ($1,'Carrot','Carrot-hi','Carrot-mr',50,100) returning id`, [v]);
  const { rows: [b] } = await sql(
    `insert into bills (vendor_id, customer_id, total, status, completed_at)
     values ($1,$2,150,'done','2026-11-05T04:00:00Z'::timestamptz) returning id`,
    [v, w.a.customerId]);
  // Costed: 3 kg @ cost 20/kg -> cost 60, revenue 90. Uncosted: 2 kg for 60, cost unknown.
  await sql(`insert into bill_items (bill_id, vendor_id, item_id, qty_kg, unit_price, line_total, unit_cost)
             values ($1,$2,$3,3,30,90,20)`, [b.id, v, carrot.id]);
  await sql(`insert into bill_items (bill_id, vendor_id, item_id, qty_kg, unit_price, line_total, unit_cost)
             values ($1,$2,$3,2,30,60,null)`, [b.id, v, carrot.id]);
  return { ...w, carrot: carrot.id };
}
const getP = once(partialWorld);

// Another separate world/month: a done bill whose total is NET of redeemed points (see
// 0010), so it is lower than the sum of its (fully costed) line totals. Per fix-round-1
// finding #2 and the controller's ruling, collected_between.profit must be computed
// against this net total, not against the pre-redemption line totals.
async function pointsWorld() {
  const w = await seedTwoVendors();
  const v = w.a.vendorId;
  const { rows: [item] } = await sql(
    `insert into items (vendor_id, name_en, name_hi, name_mr, price, stock_kg)
     values ($1,'Potato','Potato-hi','Potato-mr',100,100) returning id`, [v]);
  const { rows: [b] } = await sql(
    // line_total would be 200; 20 points were redeemed, so bills.total (net) is 180.
    `insert into bills (vendor_id, customer_id, total, status, completed_at)
     values ($1,$2,180,'done','2026-12-05T04:00:00Z'::timestamptz) returning id`,
    [v, w.a.customerId]);
  // 2 kg at cost 50/kg -> cost 100, fully costed.
  await sql(`insert into bill_items (bill_id, vendor_id, item_id, qty_kg, unit_price, line_total, unit_cost)
             values ($1,$2,$3,2,100,200,50)`, [b.id, v, item.id]);
  return w;
}
const getPts = once(pointsWorld);

test("collected_between reports cost, profit and uncosted lines", async () => {
  const w = await getC();
  const { data, error } = await rpc(w, "collected_between");
  assert(!error, error?.message);
  const r = data[0];
  assertEqual(Number(r.total), 350, "total");
  assertEqual(Number(r.bill_count), 2, "bill_count");
  assertEqual(Number(r.cost), 200, "cost = 60 + 140; garlic excluded");
  // profit covers costed sales only: total (350) minus the uncosted garlic line's own
  // revenue (50) minus cost (200). Not total - cost (150), which would book garlic's
  // whole ₹50 sale price as pure profit just because its cost is unknown.
  assertEqual(Number(r.profit), 100, "profit = 350 - 50 (garlic revenue) - 200 (cost)");
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

test("collected_between charges a bill's redeemed points against the costed portion", async () => {
  const w = await getPts();
  const { data, error } = await rpc(w, "collected_between", DEC[0], DEC[1]);
  assert(!error, error?.message);
  const r = data[0];
  assertEqual(Number(r.total), 180, "total is the net (post-redemption) amount");
  assertEqual(Number(r.cost), 100, "cost");
  assertEqual(Number(r.uncosted_lines), 0, "the line is fully costed");
  assertEqual(Number(r.profit), 80, "profit = 180 (net total) - 100 (cost)");
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

test("top_items_between margin filters revenue to the costed lines of a half-costed item", async () => {
  const w = await getP();
  const { data, error } = await rpc(w, "top_items_between", NOV[0], NOV[1]);
  assert(!error, error?.message);
  const carrot = data.find((r) => r.item_id === w.carrot);
  assert(carrot, "the carrot row is missing");
  assertEqual(Number(carrot.total_qty_kg), 5, "3 kg costed + 2 kg uncosted");
  assertEqual(Number(carrot.total_revenue), 150, "revenue is the full 90 + 60");
  assertEqual(Number(carrot.total_cost), 60, "cost is only the costed line's 3 kg @ 20");
  assertEqual(Number(carrot.margin), 30, "margin = 90 (costed revenue) - 60 (cost)");
  assertEqual(Number(carrot.uncosted_lines), 1, "the 2 kg line with no unit_cost");
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
  // Inserted directly (owner role, bypasses RLS) so created_at can be set explicitly,
  // rather than relying on log_stock_movement's now(). created_by must be a real
  // app_users id: stock_movements_between left-joins app_users for the author's name.
  const outside = await sql(
    `insert into stock_movements (vendor_id, item_id, kind, qty_kg, unit_cost, note, created_by, created_at)
     values ($1,$2,'purchase',1,10,'outside',$3,'2020-01-01T12:00:00Z'::timestamptz) returning id`,
    [w.a.vendorId, w.onion, w.a.recorderId]);
  const inside = await sql(
    `insert into stock_movements (vendor_id, item_id, kind, qty_kg, unit_cost, note, created_by, created_at)
     values ($1,$2,'purchase',1,10,'inside',$3,'2020-01-02T12:00:00Z'::timestamptz) returning id`,
    [w.a.vendorId, w.onion, w.a.recorderId]);
  const { data, error } = await w.a.clients.admin.rpc("stock_movements_between", {
    p_from: "2020-01-02T00:00:00Z", p_to: "2020-01-03T00:00:00Z" });
  assert(!error, error?.message);
  const ids = data.map((r) => r.id);
  assert(ids.includes(inside.rows[0].id), "the in-window movement is missing");
  assert(!ids.includes(outside.rows[0].id), "the out-of-window movement leaked in");
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
