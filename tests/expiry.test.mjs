import { test, assertEqual } from "./framework.mjs";
import { sql } from "./fixtures.mjs";

async function ledgerVendor(entries) {
  const { rows: [v] } = await sql(`insert into vendors (name) values ('Expiry Co') returning id`);
  const { rows: [c] } = await sql(
    `insert into customers (vendor_id, name, flat_no, mobile)
     values ($1,'Ex','G-1','+91933330' || floor(random()*10000)::text) returning id`, [v.id]);
  for (const e of entries) {
    await sql(
      `insert into points_ledger (vendor_id, customer_id, points, expires_at)
       values ($1,$2,$3, now() + ($4 || ' days')::interval)`, [v.id, c.id, e.points, e.inDays]);
  }
  return { vendorId: v.id, customerId: c.id };
}

const total = async (vendorId) => {
  const { rows } = await sql(
    `select coalesce(sum(points),0)::int as p from points_ledger where vendor_id = $1`, [vendorId]);
  return rows[0].p;
};

test("expire_points writes an offsetting row for lapsed points", async () => {
  const w = await ledgerVendor([{ points: 50, inDays: -1 }]);
  await sql(`select expire_points()`);
  assertEqual(await total(w.vendorId), 0, "lapsed points were not offset");
  const { rows } = await sql(
    `select points from points_ledger where vendor_id = $1 and points < 0`, [w.vendorId]);
  assertEqual(rows.length, 1, "expected one expiry row");
  assertEqual(rows[0].points, -50, "expiry row has the wrong sign or amount");
});

test("expire_points leaves unexpired points alone", async () => {
  const w = await ledgerVendor([{ points: 80, inDays: 5 }]);
  await sql(`select expire_points()`);
  assertEqual(await total(w.vendorId), 80, "live points were expired early");
});

test("expire_points is idempotent across runs", async () => {
  const w = await ledgerVendor([{ points: 50, inDays: -1 }]);
  await sql(`select expire_points()`);
  await sql(`select expire_points()`);
  assertEqual(await total(w.vendorId), 0, "a second sweep double-counted the expiry");
  const { rows } = await sql(
    `select count(*)::int as n from points_ledger where vendor_id = $1 and points < 0`, [w.vendorId]);
  assertEqual(rows[0].n, 1, "a second expiry row was written");
});
