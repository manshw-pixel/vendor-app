import { test, assert, assertEqual } from "./framework.mjs";
import { sql } from "./fixtures.mjs";

const TABLES = [
  "vendors", "vendor_counters", "app_users", "items", "customers",
  "bills", "bill_items", "points_ledger", "stock_requests", "outbound_messages",
];

test("all expected tables exist", async () => {
  const { rows } = await sql(
    `select table_name from information_schema.tables
      where table_schema = 'public' and table_type = 'BASE TABLE'`
  );
  const present = rows.map(r => r.table_name).sort();
  for (const t of TABLES) assert(present.includes(t), `missing table: ${t}`);
});

test("every table except vendors carries vendor_id", async () => {
  for (const t of TABLES.filter(t => t !== "vendors")) {
    const { rows } = await sql(
      `select 1 from information_schema.columns
        where table_schema='public' and table_name=$1 and column_name='vendor_id'`, [t]
    );
    assertEqual(rows.length, 1, `${t} has no vendor_id column`);
  }
});

test("customer name, flat_no and mobile are all NOT NULL", async () => {
  const { rows } = await sql(
    `select column_name, is_nullable from information_schema.columns
      where table_schema='public' and table_name='customers'
        and column_name in ('name','flat_no','mobile')`
  );
  assertEqual(rows.length, 3, "expected three columns");
  for (const r of rows) assertEqual(r.is_nullable, "NO", `${r.column_name} must be NOT NULL`);
});

test("vendor loyalty defaults match the spec", async () => {
  const { rows } = await sql(
    `insert into vendors (name) values ('Defaults Co') returning *`
  );
  const v = rows[0];
  assertEqual(Number(v.points_threshold_1), 600, "threshold 1");
  assertEqual(Number(v.points_reward_1), 50, "reward 1");
  assertEqual(Number(v.points_threshold_2), 1000, "threshold 2");
  assertEqual(Number(v.points_reward_2), 100, "reward 2");
  assertEqual(Number(v.redeem_days), 30, "redeem days default");
});

test("bill status is constrained to the three lifecycle values", async () => {
  const { rows: [v] } = await sql(`insert into vendors (name) values ('Status Co') returning id`);
  let threw = false;
  try {
    await sql(`insert into bills (vendor_id, status, total) values ($1, 'nonsense', 0)`, [v.id]);
  } catch { threw = true; }
  assert(threw, "an invalid bill status was accepted");
});

test("app_users role is constrained to the three roles", async () => {
  const { rows: [v] } = await sql(`insert into vendors (name) values ('Role Co') returning id`);
  let threw = false;
  try {
    await sql(`insert into app_users (id, vendor_id, role, name)
               values (gen_random_uuid(), $1, 'wizard', 'X')`, [v.id]);
  } catch { threw = true; }
  assert(threw, "an invalid role was accepted");
});

test("vendors carries a nullable address and phone for the receipt header", async () => {
  const { rows } = await sql(
    `select column_name, is_nullable, data_type from information_schema.columns
      where table_schema='public' and table_name='vendors'
        and column_name in ('address','phone')`
  );
  assertEqual(rows.length, 2, "expected address and phone on vendors");
  for (const r of rows) {
    assertEqual(r.is_nullable, "YES", `${r.column_name} must stay nullable`);
    assertEqual(r.data_type, "text", `${r.column_name} must be text`);
  }
});

test("a vendor created without shop details is still valid", async () => {
  // Nullable is the whole point: every vendor row predating 0014 has neither, and the
  // slip omits a blank line rather than refusing to render.
  const { rows } = await sql(
    `insert into vendors (name) values ('No Details Co') returning address, phone`
  );
  assertEqual(rows[0].address, null, "address defaults to null");
  assertEqual(rows[0].phone, null, "phone defaults to null");
});
