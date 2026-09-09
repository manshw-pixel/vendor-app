import { test, assert, assertEqual, once } from "./framework.mjs";
import { sql } from "./fixtures.mjs";
import { seedTwoVendors } from "./seed.mjs";

// A vendor whose bills sit on known days, so a date window can include some and exclude
// others. Times are explicit rather than now()-relative: a test that drifts with the
// clock fails at midnight and nowhere else.
async function windowedVendor() {
  const { rows: [v] } = await sql(`insert into vendors (name) values ('Window Co') returning id`);
  const { rows: [c] } = await sql(
    `insert into customers (vendor_id, name, flat_no, mobile)
     values ($1,'Win','W-1','+91955550' || floor(random()*10000)::text) returning id`, [v.id]);
  const item = async (n) => {
    const { rows: [i] } = await sql(
      `insert into items (vendor_id, name_en, name_hi, name_mr, price, stock_kg)
       values ($1,$2,$3,$4,50,100) returning id`, [v.id, n, `${n}-hi`, `${n}-mr`]);
    return i.id;
  };
  const onion = await item("Onion");
  const tomato = await item("Tomato");
  const bill = async (itemIds, when, qty) => {
    const { rows: [b] } = await sql(
      `insert into bills (vendor_id, customer_id, total, status, completed_at)
       values ($1,$2,100,'done',$3::timestamptz) returning id`, [v.id, c.id, when]);
    for (const id of itemIds) {
      await sql(`insert into bill_items (bill_id, vendor_id, item_id, qty_kg, unit_price, line_total)
                 values ($1,$2,$3,$4,50,100)`, [b.id, v.id, id, qty]);
    }
    return b.id;
  };
  // Inside the window: three onion+tomato bills on the 9th.
  await bill([onion, tomato], "2026-09-09T04:00:00Z", 2);
  await bill([onion, tomato], "2026-09-09T05:00:00Z", 2);
  await bill([onion, tomato], "2026-09-09T06:00:00Z", 2);
  // Outside: a big onion bill the month before, which must not leak into the window.
  await bill([onion], "2026-08-09T04:00:00Z", 999);
  // A bill still recording -- never counted, whatever its date.
  const { rows: [open] } = await sql(
    `insert into bills (vendor_id, customer_id, total, status) values ($1,$2,100,'recording') returning id`,
    [v.id, c.id]);
  await sql(`insert into bill_items (bill_id, vendor_id, item_id, qty_kg, unit_price, line_total)
             values ($1,$2,$3,500,50,100)`, [open.id, v.id, onion]);
  return { vendorId: v.id, onion, tomato };
}

const getW = once(windowedVendor);
const SEP = ["2026-09-01T00:00:00Z", "2026-10-01T00:00:00Z"];

test("top_items_between counts only bills completed inside the window", async () => {
  const w = await getW();
  const { rows } = await sql(
    `select * from top_items_between($1::timestamptz, $2::timestamptz)
      where item_id = $3`, [...SEP, w.onion]);
  assertEqual(rows.length, 1, "expected the onion row");
  // 3 bills x 2 kg. The 999 kg August bill is outside the window.
  assertEqual(Number(rows[0].total_qty_kg), 6, "August's bill leaked into September");
});

test("top_items_between ignores bills that are not done", async () => {
  const w = await getW();
  const { rows } = await sql(
    `select * from top_items_between('2000-01-01T00:00:00Z'::timestamptz,
                                     '2100-01-01T00:00:00Z'::timestamptz)
      where item_id = $1`, [w.onion]);
  // 6 kg in September + 999 kg in August. The 500 kg still 'recording' must not appear.
  assertEqual(Number(rows[0].total_qty_kg), 1005, "a recording bill was counted");
});

test("top_items_between returns all three names for the language the UI needs", async () => {
  const w = await getW();
  const { rows } = await sql(
    `select * from top_items_between($1::timestamptz, $2::timestamptz) where item_id = $3`,
    [...SEP, w.onion]);
  assertEqual(rows[0].name_hi, "Onion-hi", "name_hi missing");
  assertEqual(rows[0].name_mr, "Onion-mr", "name_mr missing");
});

test("bought_together_between applies the 3-bill threshold inside the window", async () => {
  const w = await getW();
  // sql() connects as a superuser, so RLS does not scope this query -- other suites'
  // vendors show up too. Scope to this vendor's onion/tomato pair as a set: the SQL
  // emits a.item_id < b.item_id, so which uuid lands in item_a is not knowable here.
  const { rows } = await sql(
    `select * from bought_together_between($1::timestamptz, $2::timestamptz)
      where item_a in ($3,$4) and item_b in ($3,$4)`, [...SEP, w.onion, w.tomato]);
  assertEqual(rows.length, 1, "expected exactly the onion/tomato pair");
  assertEqual(Number(rows[0].bill_count), 3, "expected three co-occurrences");
});

test("bought_together_between drops a pair that only qualifies outside the window", async () => {
  const w = await getW();
  // One day of the three: the pair now co-occurs once, below the threshold of 3.
  // Scoped the same way -- a global count would pass by luck if no other suite happens
  // to seed a qualifying pair inside this one-hour window.
  const { rows } = await sql(
    `select * from bought_together_between('2026-09-09T03:30:00Z'::timestamptz,
                                           '2026-09-09T04:30:00Z'::timestamptz)
      where item_a in ($1,$2) and item_b in ($1,$2)`, [w.onion, w.tomato]);
  assertEqual(rows.length, 0, "a pair under the threshold was returned");
});

// A window in 2099 that no other suite writes into, so the global aggregate this
// superuser connection sees IS exactly this vendor's contribution. That is what makes the
// assertions below falsifiable: drop the status filter and the total becomes 800, widen
// the upper bound and it becomes 1200.
async function futureVendor() {
  const { rows: [v] } = await sql(`insert into vendors (name) values ('Future Co') returning id`);
  const { rows: [c] } = await sql(
    `insert into customers (vendor_id, name, flat_no, mobile)
     values ($1,'Fut','F-9','+91977770' || floor(random()*10000)::text) returning id`, [v.id]);
  const bill = async (total, status, when) => {
    await sql(
      `insert into bills (vendor_id, customer_id, total, status, completed_at)
       values ($1,$2,$3,$4,$5::timestamptz)`, [v.id, c.id, total, status, when]);
  };
  await bill(100, "done",      "2099-01-10T04:00:00Z");   // in window
  await bill(200, "done",      "2099-01-20T04:00:00Z");   // in window
  await bill(500, "recording", "2099-01-15T04:00:00Z");   // in window, NOT done
  await bill(400, "done",      "2099-02-01T04:00:00Z");   // done, at the exclusive bound
  return { vendorId: v.id };
}
const getFuture = once(futureVendor);
const JAN99 = ["2099-01-01T00:00:00Z", "2099-02-01T00:00:00Z"];

test("collected_between sums only completed bills inside the window", async () => {
  await getFuture();
  const { rows } = await sql(
    `select * from collected_between($1::timestamptz, $2::timestamptz)`, JAN99);
  assertEqual(rows.length, 1, "expected exactly one aggregate row");
  // 100 + 200. The 500 is still 'recording'; the 400 sits exactly on the exclusive upper
  // bound and must be excluded by it.
  assertEqual(Number(rows[0].total), 300, "wrong total: a status or window filter is off");
  assertEqual(Number(rows[0].bill_count), 2, "wrong bill_count");
});

test("collected_between's upper bound is exclusive", async () => {
  await getFuture();
  // Widen by one day and the 400 at exactly 2099-02-01 joins the sum. If the function
  // used <= instead of <, the previous test's window would already have counted it.
  const { rows } = await sql(
    `select * from collected_between($1::timestamptz, '2099-02-02T00:00:00Z'::timestamptz)`,
    [JAN99[0]]);
  assertEqual(Number(rows[0].total), 700, "expected the boundary bill to be included now");
});

test("collected_between returns a zero row rather than nothing for an empty window", async () => {
  // A period with no sales must still render as 0, not as a missing row the caller has to
  // special-case into "no data".
  const { rows } = await sql(
    `select * from collected_between('1990-01-01T00:00:00Z'::timestamptz,
                                     '1990-01-02T00:00:00Z'::timestamptz)`);
  assertEqual(rows.length, 1, "expected one row even with no bills");
  assertEqual(Number(rows[0].total), 0, "expected zero, not null");
  assertEqual(Number(rows[0].bill_count), 0, "expected a zero count");
});

test("one vendor's admin cannot sum another vendor's takings", async () => {
  const world = await once(seedTwoVendors)();
  const { rows: [b] } = await sql(
    `insert into bills (vendor_id, customer_id, total, status, completed_at)
     values ($1,$2,777,'done', now()) returning id`, [world.b.vendorId, world.b.customerId]);
  assert(b.id, "seed bill was not created");
  const { data, error } = await world.a.clients.admin.rpc("collected_between", {
    p_from: "2000-01-01T00:00:00Z", p_to: "2100-01-01T00:00:00Z",
  });
  assert(!error, `rpc failed: ${error?.message}`);
  // Vendor A is freshly seeded and has no bills of its own, so the ONLY correct answer is
  // zero. Asserting `!== 777` would have passed even with RLS bypassed, because a bypass
  // returns 777 plus every other suite's bills -- never exactly 777.
  const total = Number(data?.[0]?.total ?? 0);
  assertEqual(total, 0, "vendor A saw takings that are not its own");
});

test("no analytics function is SECURITY DEFINER", async () => {
  // A definer function would bypass RLS and hand every vendor everyone else's numbers.
  const { rows } = await sql(
    `select proname, prosecdef from pg_proc
      where proname in ('top_items_between','bought_together_between','collected_between')`);
  assertEqual(rows.length, 3, "expected all three functions to exist");
  for (const r of rows) assert(r.prosecdef === false, `${r.proname} is SECURITY DEFINER`);
});

test("one vendor's admin cannot see another vendor's top items", async () => {
  const world = await once(seedTwoVendors)();
  const { data, error } = await world.a.clients.admin.rpc("top_items_between", {
    p_from: "2000-01-01T00:00:00Z", p_to: "2100-01-01T00:00:00Z",
  });
  assert(!error, `rpc failed: ${error?.message}`);
  // Vendor B's items must be absent entirely -- invoker rights means RLS filtered them.
  const ids = (data ?? []).map((r) => r.item_id);
  assert(!ids.includes(world.b.itemId), "vendor A saw vendor B's item");
});
