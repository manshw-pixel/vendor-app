import { test, assert, assertEqual } from "./framework.mjs";
import { sql } from "./fixtures.mjs";

async function customerWithLedger(entries) {
  const { rows: [v] } = await sql(`insert into vendors (name) values ('Balance Co') returning id`);
  const { rows: [c] } = await sql(
    `insert into customers (vendor_id, name, flat_no, mobile)
     values ($1,'Bal','E-1','+91955550' || floor(random()*10000)::text) returning id`, [v.id]);
  for (const e of entries) {
    await sql(
      `insert into points_ledger (vendor_id, customer_id, points, expires_at)
       values ($1,$2,$3, now() + ($4 || ' days')::interval)`, [v.id, c.id, e.points, e.inDays]);
  }
  return c.id;
}

test("balance sums unexpired points", async () => {
  const id = await customerWithLedger([{ points: 50, inDays: 10 }, { points: 100, inDays: 20 }]);
  const { rows: [r] } = await sql(`select * from customer_points_balance($1)`, [id]);
  assertEqual(r.balance, 150, "balance is wrong");
});

test("expired points are excluded", async () => {
  const id = await customerWithLedger([{ points: 50, inDays: -1 }, { points: 30, inDays: 5 }]);
  const { rows: [r] } = await sql(`select * from customer_points_balance($1)`, [id]);
  assertEqual(r.balance, 30, "expired points were counted");
});

test("redemptions are negative rows and reduce the balance", async () => {
  const id = await customerWithLedger([{ points: 100, inDays: 10 }, { points: -40, inDays: 10 }]);
  const { rows: [r] } = await sql(`select * from customer_points_balance($1)`, [id]);
  assertEqual(r.balance, 60, "a redemption did not reduce the balance");
});

test("days_left comes from the earliest future expiry", async () => {
  const id = await customerWithLedger([{ points: 50, inDays: 3 }, { points: 100, inDays: 25 }]);
  const { rows: [r] } = await sql(`select * from customer_points_balance($1)`, [id]);
  assertEqual(r.days_left, 3, "days_left should track the soonest expiry");
});

test("a customer with nothing has zero balance and no days_left", async () => {
  const id = await customerWithLedger([]);
  const { rows: [r] } = await sql(`select * from customer_points_balance($1)`, [id]);
  assertEqual(r.balance, 0, "expected zero");
  assert(r.days_left === null, "days_left should be null with no points");
});
