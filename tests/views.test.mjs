import { test, assert, assertEqual, once } from "./framework.mjs";
import { sql } from "./fixtures.mjs";
import { seedTwoVendors } from "./seed.mjs";

// A vendor with three items and a controlled set of completed bills, so the
// bought-together threshold can be tested exactly at its boundary.
async function analyticsVendor() {
  const { rows: [v] } = await sql(`insert into vendors (name) values ('Analytics Co') returning id`);
  const { rows: [c] } = await sql(
    `insert into customers (vendor_id, name, flat_no, mobile)
     values ($1,'An','F-1','+91944440' || floor(random()*10000)::text) returning id`, [v.id]);
  const item = async (n, stock) => {
    const { rows: [i] } = await sql(
      `insert into items (vendor_id, name_en, price, stock_kg) values ($1,$2,50,$3) returning id`,
      [v.id, n, stock]);
    return i.id;
  };
  const onion = await item("Onion", 100);
  const tomato = await item("Tomato", 4);     // below the 10 kg bell threshold
  const okra = await item("Okra", 0);         // out of stock
  const bill = async (itemIds, total) => {
    const { rows: [b] } = await sql(
      `insert into bills (vendor_id, customer_id, total, status, completed_at)
       values ($1,$2,$3,'done', now()) returning id`, [v.id, c.id, total]);
    for (const id of itemIds) {
      await sql(`insert into bill_items (bill_id, vendor_id, item_id, qty_kg, unit_price, line_total)
                 values ($1,$2,$3,2,50,100)`, [b.id, v.id, id]);
    }
    return b.id;
  };
  // onion+tomato co-occur three times -> qualifies. onion+okra twice -> does not.
  await bill([onion, tomato], 200);
  await bill([onion, tomato], 200);
  await bill([onion, tomato], 200);
  await bill([onion, okra], 200);
  await bill([onion, okra], 200);
  await sql(`insert into stock_requests (vendor_id, customer_id, item_name)
             values ($1,$2,'dragonfruit'), ($1,$2,'dragonfruit'), ($1,$2,'kiwi')`, [v.id, c.id]);
  return { vendorId: v.id, onion, tomato, okra };
}

// Deferred, not run at import time: bootstrap() rebuilds the schema after this file is
// imported, so anything seeded here at import time would be dropped.
const getW = once(analyticsVendor);

test("daily payments sum only completed bills", async () => {
  const w = await getW();
  const { rows } = await sql(
    `select total_collected from v_payments_daily where vendor_id = $1`, [w.vendorId]);
  assertEqual(rows.length, 1, "expected one day bucket");
  assertEqual(Number(rows[0].total_collected), 1000, "five bills of 200 should sum to 1000");
});

test("weekly and monthly payment views exist and agree with daily", async () => {
  const w = await getW();
  for (const view of ["v_payments_weekly", "v_payments_monthly"]) {
    const { rows } = await sql(
      `select total_collected from ${view} where vendor_id = $1`, [w.vendorId]);
    assertEqual(Number(rows[0].total_collected), 1000, `${view} disagrees`);
  }
});

test("top items ranks by quantity sold", async () => {
  const w = await getW();
  const { rows } = await sql(
    `select item_id, total_qty_kg from v_top_items where vendor_id = $1 order by total_qty_kg desc`,
    [w.vendorId]);
  assertEqual(rows[0].item_id, w.onion, "onion appears in all five bills and should rank first");
  assertEqual(Number(rows[0].total_qty_kg), 10, "onion quantity is wrong");
});

test("bought-together includes a pair at exactly 3 co-occurrences", async () => {
  const w = await getW();
  const { rows } = await sql(
    `select item_a, item_b, bill_count from v_bought_together where vendor_id = $1`, [w.vendorId]);
  assertEqual(rows.length, 1, "exactly one pair should meet the threshold of 3");
  assertEqual(Number(rows[0].bill_count), 3, "pair count is wrong");
  const pair = [rows[0].item_a, rows[0].item_b].sort();
  assertEqual(pair, [w.onion, w.tomato].sort(), "wrong pair qualified");
});

test("bought-together excludes a pair seen only twice", async () => {
  const w = await getW();
  const { rows } = await sql(
    `select 1 from v_bought_together
      where vendor_id = $1 and (item_a = $2 or item_b = $2)`, [w.vendorId, w.okra]);
  assertEqual(rows.length, 0, "a two-bill pair should not qualify");
});

test("low stock lists items under 10 kg only", async () => {
  const w = await getW();
  const { rows } = await sql(`select id from v_low_stock where vendor_id = $1`, [w.vendorId]);
  const ids = rows.map(r => r.id).sort();
  assertEqual(ids, [w.tomato, w.okra].sort(), "low-stock set is wrong");
});

test("in stock lists items above 0 kg only", async () => {
  const w = await getW();
  const { rows } = await sql(`select id from v_in_stock where vendor_id = $1`, [w.vendorId]);
  const ids = rows.map(r => r.id).sort();
  assertEqual(ids, [w.onion, w.tomato].sort(), "in-stock set is wrong");
});

test("stock request counts group by item name", async () => {
  const w = await getW();
  const { rows } = await sql(
    `select item_name, request_count from v_stock_request_counts
      where vendor_id = $1 order by request_count desc`, [w.vendorId]);
  assertEqual(rows[0].item_name, "dragonfruit", "most-requested item is wrong");
  assertEqual(Number(rows[0].request_count), 2, "request count is wrong");
});

test("views are security_invoker and do not leak across vendors", async () => {
  const w = await getW();
  // The trap this catches: a view owned by postgres WITHOUT security_invoker runs as its
  // owner and cheerfully hands vendor A every vendor's dashboard.
  const worlds = await seedTwoVendors();
  const { data, error } = await worlds.a.clients.admin
    .from("v_payments_daily").select("*").eq("vendor_id", w.vendorId);
  assert(!error, `unexpected error: ${error?.message}`);
  assertEqual(data.length, 0, "a dashboard view leaked another vendor's data");
});
