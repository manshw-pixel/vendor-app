import { test, assert, assertEqual } from "./framework.mjs";
import { sql } from "./fixtures.mjs";

// Builds a vendor with one item at a known stock level and a bill of the given total,
// already advanced to 'billed'. Every case below starts from its own vendor so that
// stock and ledger assertions never see another case's writes.
async function billedBill({ total, stockKg = 100, qtyKg = 5, vendorOverrides = {} }) {
  const { rows: [v] } = await sql(`insert into vendors (name) values ('Complete Co') returning id`);
  for (const [col, val] of Object.entries(vendorOverrides)) {
    await sql(`update vendors set ${col} = $1 where id = $2`, [val, v.id]);
  }
  const { rows: [c] } = await sql(
    `insert into customers (vendor_id, name, flat_no, mobile)
     values ($1,'CB','D-1', '+91966660' || floor(random()*10000)::text) returning id`, [v.id]);
  const { rows: [i] } = await sql(
    `insert into items (vendor_id, name_en, price, stock_kg) values ($1,'Onion',40,$2) returning id`,
    [v.id, stockKg]);
  const { rows: [b] } = await sql(
    `insert into bills (vendor_id, customer_id, total, status)
     values ($1,$2,$3,'recording') returning id`, [v.id, c.id, total]);
  await sql(`insert into bill_items (bill_id, vendor_id, item_id, qty_kg, unit_price, line_total)
             values ($1,$2,$3,$4,40,$5)`, [b.id, v.id, i.id, qtyKg, total]);
  await sql(`select issue_token($1)`, [b.id]);
  return { vendorId: v.id, customerId: c.id, itemId: i.id, billId: b.id };
}

const points = async (vendorId) => {
  const { rows } = await sql(
    `select coalesce(sum(points),0)::int as p from points_ledger where vendor_id = $1`, [vendorId]);
  return rows[0].p;
};

test("complete_bill sets status done and stamps completed_at", async () => {
  const w = await billedBill({ total: 700 });
  await sql(`select complete_bill($1)`, [w.billId]);
  const { rows: [b] } = await sql(`select status, completed_at from bills where id = $1`, [w.billId]);
  assertEqual(b.status, "done", "status did not advance to done");
  assert(b.completed_at !== null, "completed_at was not stamped");
});

test("complete_bill decrements stock by the billed quantity", async () => {
  const w = await billedBill({ total: 700, stockKg: 100, qtyKg: 5 });
  await sql(`select complete_bill($1)`, [w.billId]);
  const { rows: [i] } = await sql(`select stock_kg from items where id = $1`, [w.itemId]);
  assertEqual(Number(i.stock_kg), 95, "stock was not decremented correctly");
});

test("spend below the first threshold earns no points", async () => {
  const w = await billedBill({ total: 599 });
  await sql(`select complete_bill($1)`, [w.billId]);
  assertEqual(await points(w.vendorId), 0, "points were awarded below 600");
});

test("spend above 600 earns 50 points", async () => {
  const w = await billedBill({ total: 601 });
  await sql(`select complete_bill($1)`, [w.billId]);
  assertEqual(await points(w.vendorId), 50, "expected 50 points above 600");
});

test("spend of exactly 1000 earns 100 points", async () => {
  // The spec's boundary: "above 600", but "1000 or above".
  const w = await billedBill({ total: 1000 });
  await sql(`select complete_bill($1)`, [w.billId]);
  assertEqual(await points(w.vendorId), 100, "expected 100 points at exactly 1000");
});

test("spend of exactly 600 earns nothing", async () => {
  const w = await billedBill({ total: 600 });
  await sql(`select complete_bill($1)`, [w.billId]);
  assertEqual(await points(w.vendorId), 0, "600 is not ABOVE 600");
});

test("points rules come from vendor config, not constants", async () => {
  const w = await billedBill({
    total: 300,
    vendorOverrides: { points_threshold_1: 200, points_reward_1: 7 },
  });
  await sql(`select complete_bill($1)`, [w.billId]);
  assertEqual(await points(w.vendorId), 7, "vendor-specific loyalty config was ignored");
});

test("the ledger row expires after the vendor's redeem_days", async () => {
  const w = await billedBill({ total: 700, vendorOverrides: { redeem_days: 10 } });
  await sql(`select complete_bill($1)`, [w.billId]);
  const { rows: [l] } = await sql(
    `select (expires_at::date - earned_at::date) as days from points_ledger where vendor_id = $1`,
    [w.vendorId]);
  assertEqual(Number(l.days), 10, "expires_at did not honour redeem_days");
});

test("complete_bill is idempotent: points and stock apply exactly once", async () => {
  const w = await billedBill({ total: 700, stockKg: 100, qtyKg: 5 });
  await sql(`select complete_bill($1)`, [w.billId]);
  await sql(`select complete_bill($1)`, [w.billId]);   // must be a no-op, not an error
  assertEqual(await points(w.vendorId), 50, "points were awarded twice");
  const { rows: [i] } = await sql(`select stock_kg from items where id = $1`, [w.itemId]);
  assertEqual(Number(i.stock_kg), 95, "stock was decremented twice");
});

test("complete_bill queues exactly one points_awarded message", async () => {
  const w = await billedBill({ total: 700 });
  await sql(`select complete_bill($1)`, [w.billId]);
  await sql(`select complete_bill($1)`, [w.billId]);
  const { rows } = await sql(
    `select payload from outbound_messages
      where vendor_id = $1 and template_key = 'points_awarded'`, [w.vendorId]);
  assertEqual(rows.length, 1, "expected exactly one points message");
  assertEqual(Number(rows[0].payload.points), 50, "payload points are wrong");
});

test("completing a bill that was never billed is refused", async () => {
  const { rows: [v] } = await sql(`insert into vendors (name) values ('Raw Co') returning id`);
  const { rows: [b] } = await sql(
    `insert into bills (vendor_id, total, status) values ($1, 700, 'recording') returning id`, [v.id]);
  let threw = false;
  try { await sql(`select complete_bill($1)`, [b.id]); } catch { threw = true; }
  assert(threw, "a recording bill was completed without a token");
});
