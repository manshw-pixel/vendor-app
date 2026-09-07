# Vendor App Database Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build and prove the Postgres foundation of the vegetable & fruit vendor app — schema, RLS on every table, the billing functions, dashboard views, and the expiry job — with an automated suite that fails if vendor isolation or role separation ever breaks.

**Architecture:** One self-hosted Supabase project, tenanted by `vendor_id`, with RLS as the *only* authorization layer (there is no app server). Anything unforgeable — token issuance, stock decrements, points awards — lives in `SECURITY DEFINER` functions that clients may call but whose tables clients cannot write. Outbound WhatsApp messages are queued as rows inside the originating transaction, so delivery can fail without corrupting a sale.

**Tech Stack:** Postgres 15 (Supabase), Supabase CLI 2.x local stack, pg_cron, Node 24 + `@supabase/supabase-js` + `pg` for the test harness.

**Spec:** `docs/superpowers/specs/2026-09-07-vegetable-vendor-app-design.md`
(Product spec it derives from: `SKILLVendor.md` at the repo root.)

## Global Constraints

- Everything created by this plan lives under `vendor-app/`. Do not modify anything in
  `backend/`, `frontend-internal/`, `tests/`, `supabase/`, `build.mjs`, or
  `supabase-setup.sql` — those belong to the unrelated `onevio-crm` project sharing this
  directory.
- **Every table has `vendor_id`** and `alter table … enable row level security`. A table
  without RLS is a data breach between vendors, not a missing feature.
- `vendor_id` is **denormalised onto every child table** (`bill_items` included) so each
  policy is a plain column comparison, never a join.
- Fixed thresholds from the product spec, not configurable: bought-together pair counts
  only at **>= 3** co-occurring completed bills (#8); the low-stock bell fires below
  **10 kg** (#9); in-stock qualifies at **> 0 kg** (#18).
- Vendor-configurable loyalty defaults (#5, #15): `points_threshold_1 = 600`,
  `points_reward_1 = 50`, `points_threshold_2 = 1000`, `points_reward_2 = 100`. Functions
  must **read these from the vendor row**, never hardcode them.
- Roles are exactly `admin`, `recorder`, `biller`.
- Bill status is exactly `recording` → `billed` → `done`.
- `points_ledger` is append-only: no role gets an `update` or `delete` policy on it.
  Balances are always a `sum`, never a stored counter.
- Token numbers come only from `update vendor_counters … returning`. `max(token_no) + 1`
  in application code is forbidden.
- All dashboard views are created `with (security_invoker = true)`.
- Local stack ports are **55321 (API) / 55322 (DB)** — deliberately not the 54321/54322
  that `onevio-crm`'s `supabase/config.toml` claims, so both stacks can coexist.

## Prerequisites (do these before Task 1)

- **Docker Desktop is not installed on this machine.** `supabase start` cannot run without
  it. Install Docker Desktop for Windows and confirm `docker --version` answers before
  starting Task 0, or every test step in this plan will fail at bootstrap.
- **This directory is not a git repository.** The commit steps below assume one. Either run
  `git init` in `D:/AI Project/Vendor App` first, or skip every "Commit" step and let the
  reviewer gate each task instead.
- Supabase CLI is present (2.114.0 via `supabase`, or use `npx supabase`).

---

### Task 0: Scaffold `vendor-app/` and a working test harness

Nothing here tests product behaviour. The deliverable is a stack that comes up, a harness
that can reset it and act as a specific user, and one trivial test that proves the loop
works. Every later task depends on this and would otherwise debug the harness and the
schema at the same time.

**Files:**
- Create: `vendor-app/supabase/config.toml`
- Create: `vendor-app/supabase/migrations/.gitkeep`
- Create: `vendor-app/package.json`
- Create: `vendor-app/tests/framework.mjs`
- Create: `vendor-app/tests/fixtures.mjs`
- Create: `vendor-app/tests/run.mjs`
- Create: `vendor-app/tests/smoke.test.mjs`

**Interfaces:**
- Consumes: nothing.
- Produces: `test(name, fn)` and `CASES` from `framework.mjs`; from `fixtures.mjs` —
  `DB_URL: string`, `API_URL: string`, `ANON_KEY: string`, `newClient(): SupabaseClient`,
  `sql(text: string, params?: any[]): Promise<{rows: any[]}>`,
  `resetStack(): Promise<void>`, `bootstrap(): Promise<void>`.

- [ ] **Step 1: Create the Supabase project config**

`vendor-app/supabase/config.toml`:

```toml
project_id = "vendor-app"

[api]
enabled = true
port = 55321
schemas = ["public"]

[db]
port = 55322
major_version = 15

[auth]
enabled = true
site_url = "http://127.0.0.1:3000"
# Tests sign up real users and need a session immediately. With confirmations on,
# signUp returns { session: null } and every downstream assertion fails on a null token.
enable_confirmations = false
```

- [ ] **Step 2: Create the test package manifest**

`vendor-app/package.json`:

```json
{
  "name": "vendor-app",
  "private": true,
  "type": "module",
  "scripts": {
    "test": "node tests/run.mjs"
  },
  "dependencies": {
    "@supabase/supabase-js": "^2.45.4",
    "pg": "^8.13.0"
  }
}
```

Run: `cd vendor-app && npm install`

- [ ] **Step 3: Write the minimal test framework**

`vendor-app/tests/framework.mjs`:

```js
// Deliberately tiny and self-contained: this project does not share a harness with
// onevio-crm. Collect cases at import time, run them in order in run.mjs.
export const CASES = [];
export const test = (name, fn) => CASES.push({ name, fn });

// Test files are imported BEFORE bootstrap() resets the schema, so nothing may touch the
// database at import time -- it would be dropped before the first assertion. Wrap shared
// setup in once() and call it inside each test: the first caller builds it, the rest wait
// on the same promise.
export function once(fn) {
  let p = null;
  return () => (p ??= fn());
}

export function assert(cond, msg) {
  if (!cond) throw new Error(msg || "assertion failed");
}

export function assertEqual(actual, expected, msg) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${msg || "not equal"}: expected ${e}, got ${a}`);
}

// A denial can arrive two ways through PostgREST: an explicit error (insert/update
// blocked by a policy) or a silent empty result (select filtered by a policy). Tests must
// say which they mean, so there are two helpers rather than one fuzzy one.
export function assertDenied(error, msg) {
  if (!error) throw new Error(msg || "expected the write to be denied, but it succeeded");
}

export function assertInvisible(data, msg) {
  if (!Array.isArray(data)) throw new Error(`expected rows array, got ${JSON.stringify(data)}`);
  if (data.length !== 0) throw new Error(`${msg || "expected zero visible rows"}: saw ${data.length}`);
}
```

- [ ] **Step 4: Write the fixtures**

`vendor-app/tests/fixtures.mjs`:

```js
// NOTHING here is mocked. This talks to the real local Postgres + GoTrue brought up by
// `supabase start` inside vendor-app/, with the real migrations applied.
// See docs/superpowers/specs/2026-09-07-vegetable-vendor-app-design.md
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import pg from "pg";

export const API_URL = process.env.SUPABASE_API_URL || "http://127.0.0.1:55321";
export const DB_URL = process.env.SUPABASE_DB_URL
  || "postgresql://postgres:postgres@127.0.0.1:55322/postgres";
export const PASSWORD = "test-password-123";

// The CLI's local anon key is public, but NOT fixed across CLI versions. Always export it
// from `supabase status -o json` rather than trusting a literal.
export const ANON_KEY = process.env.SUPABASE_ANON_KEY;
export const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const MIGRATIONS_DIR = fileURLToPath(new URL("../supabase/migrations/", import.meta.url));

export const newClient = () => createClient(API_URL, ANON_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

let pool = null;

// Direct SQL as superuser. Used to seed fixtures and to assert what is REALLY in a table,
// independent of whatever the policies let a given session see.
export async function sql(text, params = []) {
  if (!pool) pool = new pg.Pool({ connectionString: DB_URL });
  return pool.query(text, params);
}

// Drop and rebuild public from the migrations, in filename order.
export async function resetStack() {
  const client = new pg.Client({ connectionString: DB_URL });
  await client.connect();
  try {
    // The `alter default privileges` lines are not ceremony. Supabase grants those
    // defaults against the schema named `public`; dropping the schema drops them with it,
    // so newly created tables would have no grants for anon/authenticated at all and
    // PostgREST would answer every request with "permission denied for table" — which
    // looks exactly like a policy bug but is a missing GRANT.
    await client.query(`
      drop schema if exists public cascade;
      create schema public;
      grant usage, create on schema public to postgres, anon, authenticated, service_role;
      alter default privileges in schema public grant all on tables to postgres, anon, authenticated, service_role;
      alter default privileges in schema public grant all on functions to postgres, anon, authenticated, service_role;
      alter default privileges in schema public grant all on sequences to postgres, anon, authenticated, service_role;
      delete from auth.users;
    `);
    const files = readdirSync(MIGRATIONS_DIR).filter(f => f.endsWith(".sql")).sort();
    for (const f of files) {
      await client.query(readFileSync(MIGRATIONS_DIR + f, "utf8"));
    }
    // PostgREST caches the schema; without this the tables we just recreated come back as
    // PGRST205 "Could not find the table in the schema cache" on the first request.
    await client.query(`notify pgrst, 'reload schema';`);
  } finally {
    await client.end();
  }
}

export async function bootstrap() {
  if (!ANON_KEY || !SERVICE_KEY) {
    throw new Error(
      "Export SUPABASE_ANON_KEY and SUPABASE_SERVICE_ROLE_KEY first:\n" +
      "  cd vendor-app && supabase status -o json"
    );
  }
  await resetStack();
}
```

- [ ] **Step 5: Write the runner**

`vendor-app/tests/run.mjs`:

```js
// The exit code IS the gate. Never pipe this.
import { CASES } from "./framework.mjs";
import { bootstrap } from "./fixtures.mjs";

import "./smoke.test.mjs";

try {
  await bootstrap();
} catch (e) {
  console.error("\nBootstrap failed, so no test ran.\n");
  console.error(e.stack || e.message);
  console.error("\nIf that reads as a connection failure: is Docker running, and did you run `supabase start` inside vendor-app/?");
  process.exit(2);
}

let pass = 0, fail = 0;
for (const c of CASES) {
  try { await c.fn(); console.log("PASS", c.name); pass++; }
  catch (e) { console.error("FAIL", c.name, "\n  ", e.message); fail++; }
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
```

- [ ] **Step 6: Write the failing smoke test**

`vendor-app/tests/smoke.test.mjs`:

```js
import { test, assertEqual } from "./framework.mjs";
import { sql } from "./fixtures.mjs";

test("the harness can reach the database", async () => {
  const { rows } = await sql("select 1 as one");
  assertEqual(rows[0].one, 1, "expected a live connection");
});
```

- [ ] **Step 7: Bring the stack up and run the test**

```bash
cd vendor-app
supabase start
supabase status -o json   # copy ANON_KEY and SERVICE_ROLE_KEY into your env
export SUPABASE_ANON_KEY=...
export SUPABASE_SERVICE_ROLE_KEY=...
npm test
```

Expected: `1 passed, 0 failed`. If bootstrap fails with a Docker error, stop — see
Prerequisites.

- [ ] **Step 8: Commit**

```bash
git add vendor-app/
git commit -m "chore(vendor-app): scaffold supabase project and test harness"
```

---

### Task 1: Schema

**Files:**
- Create: `vendor-app/supabase/migrations/0001_schema.sql`
- Create: `vendor-app/tests/schema.test.mjs`
- Modify: `vendor-app/tests/run.mjs` (add `import "./schema.test.mjs";`)

**Interfaces:**
- Consumes: `sql`, `resetStack` from `fixtures.mjs`.
- Produces: tables `vendors`, `vendor_counters`, `app_users`, `items`, `customers`,
  `bills`, `bill_items`, `points_ledger`, `stock_requests`, `outbound_messages`. All ids
  are `uuid` defaulting to `gen_random_uuid()` except `app_users.id`, which is the auth
  uid. Money and weights are `numeric(10,2)`.

- [ ] **Step 1: Write the failing test**

`vendor-app/tests/schema.test.mjs`:

```js
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
  let threw = false;
  try {
    await sql(`insert into app_users (id, vendor_id, role, name)
               values (gen_random_uuid(), gen_random_uuid(), 'wizard', 'X')`);
  } catch { threw = true; }
  assert(threw, "an invalid role was accepted");
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd vendor-app && npm test`
Expected: FAIL — `relation "vendors" does not exist` / missing-table assertions.

- [ ] **Step 3: Write the migration**

`vendor-app/supabase/migrations/0001_schema.sql`:

```sql
-- Vendor app schema. Every table carries vendor_id (denormalised onto children) so that
-- every RLS policy in 0002 is a plain column check rather than a join.
create extension if not exists pgcrypto;

create table vendors (
  id                  uuid primary key default gen_random_uuid(),
  name                text not null,
  -- Loyalty rules are per-vendor config (#5); the functions in 0003 read them from here
  -- and never hardcode. Defaults are the spec's values (#15).
  points_threshold_1  numeric(10,2) not null default 600,
  points_reward_1     integer       not null default 50,
  points_threshold_2  numeric(10,2) not null default 1000,
  points_reward_2     integer       not null default 100,
  redeem_days         integer       not null default 30,
  created_at          timestamptz not null default now()
);

-- The atomic token source (#12). One row per vendor, incremented with UPDATE ... RETURNING.
create table vendor_counters (
  vendor_id  uuid primary key references vendors(id) on delete cascade,
  last_token integer not null default 0
);

-- Created automatically so issue_token never has to cope with a missing counter row.
create function ensure_vendor_counter() returns trigger language plpgsql as $$
begin
  insert into vendor_counters (vendor_id) values (new.id);
  return new;
end $$;

create trigger vendors_counter_ai after insert on vendors
  for each row execute function ensure_vendor_counter();

create table app_users (
  id         uuid primary key,          -- equals auth.users.id
  vendor_id  uuid not null references vendors(id) on delete cascade,
  role       text not null check (role in ('admin','recorder','biller')),
  name       text not null,
  created_at timestamptz not null default now()
);
create index app_users_vendor_idx on app_users(vendor_id);

create table items (
  id        uuid primary key default gen_random_uuid(),
  vendor_id uuid not null references vendors(id) on delete cascade,
  name_en   text not null,
  name_hi   text not null default '',
  name_mr   text not null default '',
  price     numeric(10,2) not null check (price >= 0),   -- per kg
  stock_kg  numeric(10,2) not null default 0 check (stock_kg >= 0),
  is_active boolean not null default true
);
create index items_vendor_idx on items(vendor_id);
-- Serves the low-stock bell (#9) and the in-stock list (#18).
create index items_vendor_stock_idx on items(vendor_id, stock_kg);

-- #11: all three fields mandatory. Mobile is stored E.164-normalised so the WhatsApp
-- webhook can find a customer by sender number.
create table customers (
  id         uuid primary key default gen_random_uuid(),
  vendor_id  uuid not null references vendors(id) on delete cascade,
  name       text not null,
  flat_no    text not null,
  mobile     text not null,
  created_at timestamptz not null default now(),
  unique (vendor_id, mobile)
);
create index customers_vendor_idx on customers(vendor_id);

create table bills (
  id           uuid primary key default gen_random_uuid(),
  vendor_id    uuid not null references vendors(id) on delete cascade,
  token_no     integer,                       -- null until issue_token runs
  customer_id  uuid references customers(id),
  recorder_id  uuid references app_users(id),
  biller_id    uuid references app_users(id),
  total        numeric(10,2) not null default 0 check (total >= 0),
  status       text not null default 'recording'
               check (status in ('recording','billed','done')),
  created_at   timestamptz not null default now(),
  completed_at timestamptz,
  unique (vendor_id, token_no)
);
create index bills_vendor_status_idx on bills(vendor_id, status);
create index bills_vendor_completed_idx on bills(vendor_id, completed_at);

create table bill_items (
  id         uuid primary key default gen_random_uuid(),
  bill_id    uuid not null references bills(id) on delete cascade,
  vendor_id  uuid not null references vendors(id) on delete cascade,
  item_id    uuid not null references items(id),
  qty_kg     numeric(10,2) not null check (qty_kg > 0),
  unit_price numeric(10,2) not null check (unit_price >= 0),
  line_total numeric(10,2) not null check (line_total >= 0)
);
create index bill_items_bill_idx on bill_items(bill_id);
create index bill_items_vendor_item_idx on bill_items(vendor_id, item_id);

-- Append-only (#15). Redemptions are negative rows. A balance is always a sum.
create table points_ledger (
  id          uuid primary key default gen_random_uuid(),
  vendor_id   uuid not null references vendors(id) on delete cascade,
  customer_id uuid not null references customers(id) on delete cascade,
  bill_id     uuid references bills(id),
  points      integer not null,
  earned_at   timestamptz not null default now(),
  expires_at  timestamptz not null
);
create index points_ledger_lookup_idx on points_ledger(vendor_id, customer_id, expires_at);

-- #10 and #20: customers suggesting items the vendor does not stock.
create table stock_requests (
  id          uuid primary key default gen_random_uuid(),
  vendor_id   uuid not null references vendors(id) on delete cascade,
  customer_id uuid references customers(id) on delete set null,
  item_name   text not null,
  created_at  timestamptz not null default now()
);
create index stock_requests_vendor_idx on stock_requests(vendor_id, created_at);

-- Outbound WhatsApp queue (#13, #16, #18). Rows are inserted inside the transaction that
-- causes them; delivery is a separate concern that may fail and retry without ever
-- rolling back a completed sale.
create table outbound_messages (
  id           uuid primary key default gen_random_uuid(),
  vendor_id    uuid not null references vendors(id) on delete cascade,
  customer_id  uuid references customers(id) on delete set null,
  template_key text not null,
  payload      jsonb not null default '{}'::jsonb,
  status       text not null default 'pending'
               check (status in ('pending','sent','failed')),
  attempts     integer not null default 0,
  created_at   timestamptz not null default now(),
  sent_at      timestamptz,
  last_error   text
);
create index outbound_pending_idx on outbound_messages(status, created_at);
```

- [ ] **Step 4: Add the test file to the runner**

In `vendor-app/tests/run.mjs`, after `import "./smoke.test.mjs";` add:

```js
import "./schema.test.mjs";
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd vendor-app && npm test`
Expected: PASS — 7 passed, 0 failed.

- [ ] **Step 6: Commit**

```bash
git add vendor-app/supabase/migrations/0001_schema.sql vendor-app/tests/
git commit -m "feat(vendor-app): schema for vendors, items, bills, points and message queue"
```

---

### Task 2: RLS — vendor isolation and role separation

The security boundary. This task is the reason slice one exists, and its tests are the
gate for everything built later.

**Files:**
- Create: `vendor-app/supabase/migrations/0002_rls.sql`
- Create: `vendor-app/tests/seed.mjs`
- Create: `vendor-app/tests/rls.test.mjs`
- Modify: `vendor-app/tests/run.mjs` (add `import "./rls.test.mjs";`)

**Interfaces:**
- Consumes: all tables from Task 1; `sql`, `newClient`, `PASSWORD`, `SERVICE_KEY` from
  `fixtures.mjs`.
- Produces:
  - SQL: `current_vendor_id() returns uuid`, `current_user_role() returns text` — both
    `stable security definer`, resolving from `app_users` by `auth.uid()`.
  - JS: `seedTwoVendors(): Promise<World>` from `seed.mjs`, where `World` is
    `{ a: VendorWorld, b: VendorWorld }` and `VendorWorld` is
    `{ vendorId, adminId, recorderId, billerId, itemId, customerId, clients: { admin, recorder, biller } }`.
    Each `clients.*` is a signed-in `SupabaseClient` for that role.

- [ ] **Step 1: Write the seed helper**

`vendor-app/tests/seed.mjs`:

```js
// Builds two complete vendors, each with all three roles signed in. Everything the RLS
// suite asserts is "can A's session see or touch B's rows", so both worlds must be fully
// populated before a single assertion runs.
import { createClient } from "@supabase/supabase-js";
import { API_URL, ANON_KEY, SERVICE_KEY, PASSWORD, sql, newClient } from "./fixtures.mjs";

const admin = () => createClient(API_URL, SERVICE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

async function makeUser(email, vendorId, role, name) {
  // Create through GoTrue's admin API so the user is real and can sign in, then map them
  // to a vendor and role in app_users.
  const { data, error } = await admin().auth.admin.createUser({
    email, password: PASSWORD, email_confirm: true,
  });
  if (error) throw new Error(`createUser(${email}): ${error.message}`);
  const id = data.user.id;
  await sql(`insert into app_users (id, vendor_id, role, name) values ($1,$2,$3,$4)`,
    [id, vendorId, role, name]);

  const client = newClient();
  const { error: signInError } = await client.auth.signInWithPassword({ email, password: PASSWORD });
  if (signInError) throw new Error(`signIn(${email}): ${signInError.message}`);
  return { id, client };
}

// Emails must be unique across the whole run: seedTwoVendors() is called by more than one
// test file, and GoTrue rejects a duplicate address.
let seq = 0;

async function makeVendor(tag) {
  const n = ++seq;
  const { rows: [v] } = await sql(`insert into vendors (name) values ($1) returning id`, [`Vendor ${tag}${n}`]);
  const vendorId = v.id;

  const adminU    = await makeUser(`admin-${tag}${n}@example.test`,    vendorId, "admin",    `Admin ${tag}`);
  const recorderU = await makeUser(`recorder-${tag}${n}@example.test`, vendorId, "recorder", `Recorder ${tag}`);
  const billerU   = await makeUser(`biller-${tag}${n}@example.test`,   vendorId, "biller",   `Biller ${tag}`);

  const { rows: [item] } = await sql(
    `insert into items (vendor_id, name_en, price, stock_kg) values ($1,$2,$3,$4) returning id`,
    [vendorId, `Onion ${tag}`, 40, 100]);
  const { rows: [cust] } = await sql(
    `insert into customers (vendor_id, name, flat_no, mobile) values ($1,$2,$3,$4) returning id`,
    [vendorId, `Cust ${tag}`, `A-10${n}`, `+9199999${String(n).padStart(5, "0")}`]);

  return {
    vendorId,
    adminId: adminU.id, recorderId: recorderU.id, billerId: billerU.id,
    itemId: item.id, customerId: cust.id,
    clients: { admin: adminU.client, recorder: recorderU.client, biller: billerU.client },
  };
}

export async function seedTwoVendors() {
  return { a: await makeVendor("A"), b: await makeVendor("B") };
}
```

- [ ] **Step 2: Write the failing isolation tests**

`vendor-app/tests/rls.test.mjs`:

```js
import { test, assert, assertDenied, assertInvisible, assertEqual, once } from "./framework.mjs";
import { sql } from "./fixtures.mjs";
import { seedTwoVendors } from "./seed.mjs";

// NOT seeded at import time: run.mjs imports this file before bootstrap() rebuilds the
// schema, so an import-time seed would be dropped. once() defers it to the first test.
const getWorld = once(seedTwoVendors);

const TENANT_TABLES = [
  "vendors", "app_users", "items", "customers",
  "bills", "bill_items", "points_ledger", "stock_requests", "outbound_messages",
];

test("RLS is enabled on every table", async () => {
  const world = await getWorld();
  const { rows } = await sql(
    `select relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind = 'r' and c.relrowsecurity = false`
  );
  assertEqual(rows.map(r => r.relname), [], "these tables have RLS disabled");
});

test("vendor A sees none of vendor B's rows, on any table", async () => {
  const world = await getWorld();
  // Give both worlds a bill, a line, a ledger row and a queued message to see.
  for (const w of [world.a, world.b]) {
    const { rows: [b] } = await sql(
      `insert into bills (vendor_id, customer_id, total, status)
       values ($1,$2,500,'done') returning id`, [w.vendorId, w.customerId]);
    await sql(`insert into bill_items (bill_id, vendor_id, item_id, qty_kg, unit_price, line_total)
               values ($1,$2,$3,2,40,80)`, [b.id, w.vendorId, w.itemId]);
    await sql(`insert into points_ledger (vendor_id, customer_id, bill_id, points, expires_at)
               values ($1,$2,$3,50, now() + interval '30 days')`, [w.vendorId, w.customerId, b.id]);
    await sql(`insert into stock_requests (vendor_id, customer_id, item_name)
               values ($1,$2,'dragonfruit')`, [w.vendorId, w.customerId]);
    await sql(`insert into outbound_messages (vendor_id, customer_id, template_key)
               values ($1,$2,'token_issued')`, [w.vendorId, w.customerId]);
  }

  for (const table of TENANT_TABLES) {
    const col = table === "vendors" ? "id" : "vendor_id";
    const { data, error } = await world.a.clients.admin
      .from(table).select("*").eq(col, world.b.vendorId);
    assert(!error, `${table}: unexpected error ${error?.message}`);
    assertInvisible(data, `${table}: vendor A could see vendor B's rows`);
  }
});

test("vendor A sees its own rows", async () => {
  const world = await getWorld();
  const { data, error } = await world.a.clients.admin.from("items").select("id");
  assert(!error, `unexpected error: ${error?.message}`);
  assert(data.length > 0, "vendor A cannot see its own items");
});

test("vendor A cannot insert a row carrying vendor B's id", async () => {
  const world = await getWorld();
  const { error } = await world.a.clients.admin.from("items").insert({
    vendor_id: world.b.vendorId, name_en: "Smuggled", price: 10, stock_kg: 5,
  });
  assertDenied(error, "vendor A inserted an item into vendor B");
});

test("vendor A cannot update vendor B's item", async () => {
  const world = await getWorld();
  const { data, error } = await world.a.clients.admin
    .from("items").update({ price: 1 }).eq("id", world.b.itemId).select();
  assert(!error || error, "");             // either shape is acceptable
  const { rows } = await sql(`select price from items where id = $1`, [world.b.itemId]);
  assertEqual(Number(rows[0].price), 40, "vendor B's price was changed by vendor A");
  assertInvisible(data || [], "vendor A updated a vendor B row");
});

test("recorder cannot change item prices", async () => {
  const world = await getWorld();
  const { data } = await world.a.clients.recorder
    .from("items").update({ price: 999 }).eq("id", world.a.itemId).select();
  const { rows } = await sql(`select price from items where id = $1`, [world.a.itemId]);
  assertEqual(Number(rows[0].price), 40, "a recorder changed a price");
  assertInvisible(data || [], "recorder update returned rows");
});

test("biller cannot change item prices", async () => {
  const world = await getWorld();
  const { data } = await world.a.clients.biller
    .from("items").update({ price: 888 }).eq("id", world.a.itemId).select();
  const { rows } = await sql(`select price from items where id = $1`, [world.a.itemId]);
  assertEqual(Number(rows[0].price), 40, "a biller changed a price");
  assertInvisible(data || [], "biller update returned rows");
});

test("admin can change item prices", async () => {
  const world = await getWorld();
  const { error } = await world.a.clients.admin
    .from("items").update({ price: 45 }).eq("id", world.a.itemId);
  assert(!error, `admin was denied a price update: ${error?.message}`);
  const { rows } = await sql(`select price from items where id = $1`, [world.a.itemId]);
  assertEqual(Number(rows[0].price), 45, "admin price update did not land");
  await sql(`update items set price = 40 where id = $1`, [world.a.itemId]);  // restore
});

test("recorder can create a customer", async () => {
  const world = await getWorld();
  const { error } = await world.a.clients.recorder.from("customers").insert({
    vendor_id: world.a.vendorId, name: "New Cust", flat_no: "B-2", mobile: "+919888800001",
  });
  assert(!error, `recorder could not create a customer: ${error?.message}`);
});

test("no role can write the points ledger directly", async () => {
  const world = await getWorld();
  for (const role of ["admin", "recorder", "biller"]) {
    const { error } = await world.a.clients[role].from("points_ledger").insert({
      vendor_id: world.a.vendorId, customer_id: world.a.customerId,
      points: 10000, expires_at: new Date(Date.now() + 8.64e7).toISOString(),
    });
    assertDenied(error, `${role} forged a points_ledger row`);
  }
});

test("no role can update or delete a points ledger row", async () => {
  const world = await getWorld();
  const { rows: [led] } = await sql(
    `select id from points_ledger where vendor_id = $1 limit 1`, [world.a.vendorId]);
  const { data: updated } = await world.a.clients.admin
    .from("points_ledger").update({ points: 5000 }).eq("id", led.id).select();
  assertInvisible(updated || [], "a ledger row was updated");
  const { data: deleted } = await world.a.clients.admin
    .from("points_ledger").delete().eq("id", led.id).select();
  assertInvisible(deleted || [], "a ledger row was deleted");
});

test("no role can write vendor_counters directly", async () => {
  const world = await getWorld();
  for (const role of ["admin", "recorder", "biller"]) {
    const { data } = await world.a.clients[role]
      .from("vendor_counters").update({ last_token: 9999 })
      .eq("vendor_id", world.a.vendorId).select();
    assertInvisible(data || [], `${role} rewrote the token counter`);
  }
});

test("an anonymous client sees nothing", async () => {
  const world = await getWorld();
  const { newClient } = await import("./fixtures.mjs");
  const anon = newClient();
  for (const table of TENANT_TABLES) {
    const { data } = await anon.from(table).select("*");
    assertInvisible(data || [], `${table}: anonymous read returned rows`);
  }
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `cd vendor-app && npm test`
Expected: FAIL — "these tables have RLS disabled" lists all ten, and vendor A can see
vendor B's rows because no policies exist yet.

- [ ] **Step 4: Write the RLS migration**

`vendor-app/supabase/migrations/0002_rls.sql`:

```sql
-- The security boundary. There is no application server: these policies ARE the
-- authorization layer, so a missing policy is a cross-vendor data breach.

-- Resolve the caller's tenant and role from app_users. SECURITY DEFINER because
-- app_users itself is behind RLS and the policies below would otherwise recurse.
create function current_vendor_id() returns uuid
  language sql stable security definer set search_path = public as $$
  select vendor_id from app_users where id = auth.uid()
$$;

create function current_user_role() returns text
  language sql stable security definer set search_path = public as $$
  select role from app_users where id = auth.uid()
$$;

alter table vendors           enable row level security;
alter table vendor_counters   enable row level security;
alter table app_users         enable row level security;
alter table items             enable row level security;
alter table customers         enable row level security;
alter table bills             enable row level security;
alter table bill_items        enable row level security;
alter table points_ledger     enable row level security;
alter table stock_requests    enable row level security;
alter table outbound_messages enable row level security;

-- vendors: everyone in the tenant reads their own vendor row; only admin tunes the
-- loyalty config (#5).
create policy vendors_read on vendors for select to authenticated
  using (id = current_vendor_id());
create policy vendors_admin_update on vendors for update to authenticated
  using (id = current_vendor_id() and current_user_role() = 'admin')
  with check (id = current_vendor_id());

-- vendor_counters: readable within the tenant, writable by NO ONE. The only writer is
-- issue_token(), which is SECURITY DEFINER and therefore bypasses RLS entirely. This is
-- what makes token numbers unforgeable (#12).
create policy counters_read on vendor_counters for select to authenticated
  using (vendor_id = current_vendor_id());

-- app_users: visible within the tenant; only admin creates staff (#4).
create policy users_read on app_users for select to authenticated
  using (vendor_id = current_vendor_id());
create policy users_admin_write on app_users for all to authenticated
  using (vendor_id = current_vendor_id() and current_user_role() = 'admin')
  with check (vendor_id = current_vendor_id() and current_user_role() = 'admin');

-- items: everyone in the tenant reads (recorders need prices to build a basket);
-- only admin maintains the list, prices and stock (#2, #3). Stock is also written by
-- complete_bill(), which is SECURITY DEFINER and unaffected by this.
create policy items_read on items for select to authenticated
  using (vendor_id = current_vendor_id());
create policy items_admin_write on items for all to authenticated
  using (vendor_id = current_vendor_id() and current_user_role() = 'admin')
  with check (vendor_id = current_vendor_id() and current_user_role() = 'admin');

-- customers: readable in the tenant; admins and recorders create them (#11).
create policy customers_read on customers for select to authenticated
  using (vendor_id = current_vendor_id());
create policy customers_write on customers for all to authenticated
  using (vendor_id = current_vendor_id() and current_user_role() in ('admin','recorder'))
  with check (vendor_id = current_vendor_id() and current_user_role() in ('admin','recorder'));

-- bills: readable in the tenant (#14 history, dashboards). A recorder may create and edit
-- a basket only while it is still 'recording' — once issue_token has moved it to 'billed',
-- the basket is frozen and only complete_bill() may touch it.
create policy bills_read on bills for select to authenticated
  using (vendor_id = current_vendor_id());
create policy bills_recorder_insert on bills for insert to authenticated
  with check (vendor_id = current_vendor_id()
              and current_user_role() in ('admin','recorder')
              and status = 'recording');
create policy bills_recorder_update on bills for update to authenticated
  using (vendor_id = current_vendor_id()
         and current_user_role() in ('admin','recorder')
         and status = 'recording')
  with check (vendor_id = current_vendor_id() and status = 'recording');
create policy bills_recorder_delete on bills for delete to authenticated
  using (vendor_id = current_vendor_id()
         and current_user_role() in ('admin','recorder')
         and status = 'recording');

-- bill_items: same rule, expressed against the parent's status (#12 edit-before-Done).
create policy bill_items_read on bill_items for select to authenticated
  using (vendor_id = current_vendor_id());
create policy bill_items_write on bill_items for all to authenticated
  using (vendor_id = current_vendor_id()
         and current_user_role() in ('admin','recorder')
         and exists (select 1 from bills b where b.id = bill_id and b.status = 'recording'))
  with check (vendor_id = current_vendor_id()
              and current_user_role() in ('admin','recorder')
              and exists (select 1 from bills b where b.id = bill_id and b.status = 'recording'));

-- points_ledger: read-only to every role, forever. Append-only means no insert, update or
-- delete policy exists; complete_bill() writes it as definer (#15).
create policy points_read on points_ledger for select to authenticated
  using (vendor_id = current_vendor_id());

-- stock_requests: readable for the #10 dashboard. The bot inserts them as service_role,
-- which bypasses RLS; staff may clear handled ones.
create policy stock_requests_read on stock_requests for select to authenticated
  using (vendor_id = current_vendor_id());
create policy stock_requests_admin_delete on stock_requests for delete to authenticated
  using (vendor_id = current_vendor_id() and current_user_role() = 'admin');

-- outbound_messages: readable in the tenant so staff can see whether a message went out.
-- Written only by the billing functions and drained only by the Edge Function's
-- service_role key — no client write policy at all.
create policy outbound_read on outbound_messages for select to authenticated
  using (vendor_id = current_vendor_id());
```

- [ ] **Step 5: Add the test file to the runner**

In `vendor-app/tests/run.mjs` add, after the schema import:

```js
import "./rls.test.mjs";
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `cd vendor-app && npm test`
Expected: PASS — all RLS cases green.

- [ ] **Step 7: Commit**

```bash
git add vendor-app/supabase/migrations/0002_rls.sql vendor-app/tests/
git commit -m "feat(vendor-app): RLS policies for vendor isolation and role separation"
```

---

### Task 3: `issue_token` and the concurrency guarantee

**Files:**
- Create: `vendor-app/supabase/migrations/0003_functions.sql`
- Create: `vendor-app/tests/issue_token.test.mjs`
- Modify: `vendor-app/tests/run.mjs`

**Interfaces:**
- Consumes: tables from Task 1; `current_vendor_id()`, `current_user_role()` from Task 2.
- Produces: `issue_token(p_bill_id uuid) returns integer` — `security definer`, sets the
  bill's `token_no`, moves `recording` → `billed`, queues one `outbound_messages` row with
  `template_key = 'token_issued'`, and returns the token number.

- [ ] **Step 1: Write the failing test**

`vendor-app/tests/issue_token.test.mjs`:

```js
import { test, assert, assertEqual } from "./framework.mjs";
import { sql, DB_URL } from "./fixtures.mjs";
import pg from "pg";

async function freshVendorWithBills(n) {
  const { rows: [v] } = await sql(`insert into vendors (name) values ('Token Co') returning id`);
  const { rows: [c] } = await sql(
    `insert into customers (vendor_id, name, flat_no, mobile)
     values ($1,'Tok','C-1','+919777700001') returning id`, [v.id]);
  const ids = [];
  for (let i = 0; i < n; i++) {
    const { rows: [b] } = await sql(
      `insert into bills (vendor_id, customer_id, total, status)
       values ($1,$2,100,'recording') returning id`, [v.id, c.id]);
    ids.push(b.id);
  }
  return { vendorId: v.id, customerId: c.id, billIds: ids };
}

test("issue_token assigns sequential tokens starting at 1", async () => {
  const w = await freshVendorWithBills(3);
  const got = [];
  for (const id of w.billIds) {
    const { rows } = await sql(`select issue_token($1) as t`, [id]);
    got.push(rows[0].t);
  }
  assertEqual(got, [1, 2, 3], "tokens were not sequential from 1");
});

test("issue_token moves the bill to billed and stamps the token", async () => {
  const w = await freshVendorWithBills(1);
  const { rows: [{ t }] } = await sql(`select issue_token($1) as t`, [w.billIds[0]]);
  const { rows: [b] } = await sql(`select status, token_no from bills where id = $1`, [w.billIds[0]]);
  assertEqual(b.status, "billed", "status did not advance");
  assertEqual(b.token_no, t, "token_no does not match the returned token");
});

test("issue_token queues exactly one token_issued message", async () => {
  const w = await freshVendorWithBills(1);
  await sql(`select issue_token($1)`, [w.billIds[0]]);
  const { rows } = await sql(
    `select template_key, status, payload from outbound_messages
      where vendor_id = $1 and template_key = 'token_issued'`, [w.vendorId]);
  assertEqual(rows.length, 1, "expected one queued message");
  assertEqual(rows[0].status, "pending", "message should start pending");
  assert(rows[0].payload.token_no != null, "payload is missing token_no");
  assert(rows[0].payload.total != null, "payload is missing total");
});

test("issue_token refuses a bill that is not recording", async () => {
  const w = await freshVendorWithBills(1);
  await sql(`select issue_token($1)`, [w.billIds[0]]);
  let threw = false;
  try { await sql(`select issue_token($1)`, [w.billIds[0]]); } catch { threw = true; }
  assert(threw, "issue_token ran twice on the same bill");
});

test("concurrent issue_token calls never collide", async () => {
  // The whole point of UPDATE ... RETURNING over max(token_no)+1: N recorders pressing
  // Done at the same instant must get N distinct tokens.
  const N = 20;
  const w = await freshVendorWithBills(N);
  const clients = [];
  try {
    const results = await Promise.all(w.billIds.map(async (billId) => {
      const c = new pg.Client({ connectionString: DB_URL });
      clients.push(c);
      await c.connect();
      const { rows } = await c.query(`select issue_token($1) as t`, [billId]);
      return rows[0].t;
    }));
    const unique = new Set(results);
    assertEqual(unique.size, N, `expected ${N} distinct tokens, got ${unique.size}`);
    assertEqual([...unique].sort((x, y) => x - y), Array.from({ length: N }, (_, i) => i + 1),
      "tokens are not 1..N");
  } finally {
    await Promise.all(clients.map(c => c.end().catch(() => {})));
  }
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd vendor-app && npm test`
Expected: FAIL — `function issue_token(uuid) does not exist`.

- [ ] **Step 3: Write the function**

`vendor-app/supabase/migrations/0003_functions.sql`:

```sql
-- Billing lifecycle. Both functions are SECURITY DEFINER: the client may CALL them but has
-- no write policy on vendor_counters, items.stock_kg or points_ledger, so tokens, stock and
-- points cannot be forged from the browser.

-- #12: recorder finishes the basket. Token comes from UPDATE ... RETURNING, which is
-- atomic under the row lock. max(token_no) + 1 in app code would hand two recorders
-- pressing Done in the same second the same token.
create function issue_token(p_bill_id uuid)
  returns integer
  language plpgsql security definer set search_path = public as $$
declare
  v_bill   bills%rowtype;
  v_token  integer;
begin
  -- Lock the bill first so two calls on the SAME bill serialise; the status guard below
  -- then makes the second one fail rather than issue a second token.
  select * into v_bill from bills where id = p_bill_id for update;
  if not found then
    raise exception 'bill % not found', p_bill_id;
  end if;
  if v_bill.status <> 'recording' then
    raise exception 'bill % is %, expected recording', p_bill_id, v_bill.status;
  end if;

  update vendor_counters
     set last_token = last_token + 1
   where vendor_id = v_bill.vendor_id
  returning last_token into v_token;

  update bills
     set token_no = v_token, status = 'billed'
   where id = p_bill_id;

  -- #13: the customer is told their token and what to pay. Queued, never sent inline —
  -- a WhatsApp outage must not roll back a finished basket.
  insert into outbound_messages (vendor_id, customer_id, template_key, payload)
  values (v_bill.vendor_id, v_bill.customer_id, 'token_issued',
          jsonb_build_object('token_no', v_token, 'total', v_bill.total));

  return v_token;
end $$;

revoke all on function issue_token(uuid) from public, anon;
grant execute on function issue_token(uuid) to authenticated;
```

- [ ] **Step 4: Add the test file to the runner**

```js
import "./issue_token.test.mjs";
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd vendor-app && npm test`
Expected: PASS, including the 20-way concurrency case.

- [ ] **Step 6: Commit**

```bash
git add vendor-app/supabase/migrations/0003_functions.sql vendor-app/tests/
git commit -m "feat(vendor-app): atomic token issuance with concurrency test"
```

---

### Task 4: `complete_bill` — stock, points and idempotency

**Files:**
- Modify: `vendor-app/supabase/migrations/0003_functions.sql` (append)
- Create: `vendor-app/tests/complete_bill.test.mjs`
- Modify: `vendor-app/tests/run.mjs`

**Interfaces:**
- Consumes: `issue_token` from Task 3; `vendors` loyalty columns from Task 1.
- Produces: `complete_bill(p_bill_id uuid, p_biller_id uuid default null) returns void` —
  `security definer`, idempotent, decrements stock, awards points from vendor config,
  sets `done` and `completed_at`, queues `template_key = 'points_awarded'`.

- [ ] **Step 1: Write the failing test**

`vendor-app/tests/complete_bill.test.mjs`:

```js
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd vendor-app && npm test`
Expected: FAIL — `function complete_bill(uuid) does not exist`.

- [ ] **Step 3: Append the function to the migration**

Append to `vendor-app/supabase/migrations/0003_functions.sql`:

```sql
-- #14/#15: biller takes payment. Stock, points and status move together or not at all —
-- a bill that is 'done' with stock unadjusted is the failure this design exists to prevent.
create function complete_bill(p_bill_id uuid, p_biller_id uuid default null)
  returns void
  language plpgsql security definer set search_path = public as $$
declare
  v_bill    bills%rowtype;
  v_vendor  vendors%rowtype;
  v_points  integer := 0;
begin
  select * into v_bill from bills where id = p_bill_id for update;
  if not found then
    raise exception 'bill % not found', p_bill_id;
  end if;

  -- Idempotent by guard: a retried request (double click, network retry) must not award
  -- points twice or decrement stock twice. Already-done is success, not an error.
  if v_bill.status = 'done' then
    return;
  end if;
  if v_bill.status <> 'billed' then
    raise exception 'bill % is %, expected billed', p_bill_id, v_bill.status;
  end if;

  select * into v_vendor from vendors where id = v_bill.vendor_id;

  -- Stock (#3). greatest(...,0) keeps the non-negative check from turning an
  -- over-sold line into a hard failure at the counter with a customer waiting.
  update items i
     set stock_kg = greatest(i.stock_kg - agg.qty, 0)
    from (select item_id, sum(qty_kg) as qty
            from bill_items where bill_id = p_bill_id group by item_id) agg
   where i.id = agg.item_id;

  -- Points (#15). Thresholds and rewards are this vendor's config, never constants.
  -- Note the asymmetry the spec fixes: strictly ABOVE threshold 1, but AT OR ABOVE
  -- threshold 2.
  if v_bill.total >= v_vendor.points_threshold_2 then
    v_points := v_vendor.points_reward_2;
  elsif v_bill.total > v_vendor.points_threshold_1 then
    v_points := v_vendor.points_reward_1;
  end if;

  if v_points > 0 and v_bill.customer_id is not null then
    insert into points_ledger (vendor_id, customer_id, bill_id, points, expires_at)
    values (v_bill.vendor_id, v_bill.customer_id, p_bill_id, v_points,
            now() + (v_vendor.redeem_days || ' days')::interval);

    -- #16: tell the customer their points, queued in the same transaction.
    insert into outbound_messages (vendor_id, customer_id, template_key, payload)
    values (v_bill.vendor_id, v_bill.customer_id, 'points_awarded',
            jsonb_build_object('points', v_points, 'total', v_bill.total,
                               'expires_in_days', v_vendor.redeem_days));
  end if;

  update bills
     set status = 'done',
         completed_at = now(),
         biller_id = coalesce(p_biller_id, biller_id)
   where id = p_bill_id;
end $$;

revoke all on function complete_bill(uuid, uuid) from public, anon;
grant execute on function complete_bill(uuid, uuid) to authenticated;
```

- [ ] **Step 4: Add the test file to the runner**

```js
import "./complete_bill.test.mjs";
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd vendor-app && npm test`
Expected: PASS — all eleven `complete_bill` cases green.

- [ ] **Step 6: Commit**

```bash
git add vendor-app/supabase/migrations/0003_functions.sql vendor-app/tests/
git commit -m "feat(vendor-app): complete_bill with idempotent stock and points"
```

---

### Task 5: Points balance for the bot (#17)

**Files:**
- Modify: `vendor-app/supabase/migrations/0003_functions.sql` (append)
- Create: `vendor-app/tests/points_balance.test.mjs`
- Modify: `vendor-app/tests/run.mjs`

**Interfaces:**
- Consumes: `points_ledger` from Task 1.
- Produces: `customer_points_balance(p_customer_id uuid)` returning one row
  `(balance integer, days_left integer)`. `days_left` is null when the balance is zero.

- [ ] **Step 1: Write the failing test**

`vendor-app/tests/points_balance.test.mjs`:

```js
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd vendor-app && npm test`
Expected: FAIL — `function customer_points_balance(uuid) does not exist`.

- [ ] **Step 3: Append the function**

Append to `vendor-app/supabase/migrations/0003_functions.sql`:

```sql
-- #17: the bot answers "how many points do I have, and how long have I got?"
-- Called by the webhook with the service role, so it is a definer function reading across
-- the tenant boundary deliberately — the caller has already matched the customer by their
-- WhatsApp sender number.
create function customer_points_balance(p_customer_id uuid)
  returns table (balance integer, days_left integer)
  language sql stable security definer set search_path = public as $$
  select
    coalesce(sum(points), 0)::integer as balance,
    case when coalesce(sum(points), 0) > 0
         then ceil(extract(epoch from (min(expires_at) - now())) / 86400)::integer
    end as days_left
  from points_ledger
  where customer_id = p_customer_id
    and expires_at > now()
$$;

revoke all on function customer_points_balance(uuid) from public, anon;
grant execute on function customer_points_balance(uuid) to authenticated, service_role;
```

- [ ] **Step 4: Add the test file to the runner**

```js
import "./points_balance.test.mjs";
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd vendor-app && npm test`
Expected: PASS — 5 balance cases green.

- [ ] **Step 6: Commit**

```bash
git add vendor-app/supabase/migrations/0003_functions.sql vendor-app/tests/
git commit -m "feat(vendor-app): customer points balance and days-to-redeem"
```

---

### Task 6: Dashboard views (#6, #7, #8, #9, #10, #18)

**Files:**
- Create: `vendor-app/supabase/migrations/0004_views.sql`
- Create: `vendor-app/tests/views.test.mjs`
- Modify: `vendor-app/tests/run.mjs`

**Interfaces:**
- Consumes: `bills`, `bill_items`, `items`, `stock_requests` from Task 1; the RLS policies
  from Task 2 (views are `security_invoker`, so they inherit them).
- Produces: views `v_payments_daily`, `v_payments_weekly`, `v_payments_monthly`,
  `v_top_items`, `v_bought_together`, `v_low_stock`, `v_in_stock`, `v_stock_request_counts`.

- [ ] **Step 1: Write the failing test**

`vendor-app/tests/views.test.mjs`:

```js
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd vendor-app && npm test`
Expected: FAIL — `relation "v_payments_daily" does not exist`.

- [ ] **Step 3: Write the views migration**

`vendor-app/supabase/migrations/0004_views.sql`:

```sql
-- Dashboards. Every view is security_invoker so it runs with the CALLER's rights and
-- inherits the RLS policies from 0002. Without that flag a view runs as its owner
-- (postgres) and hands every vendor everyone else's numbers.

-- #6: payments collected, three grains over the same base.
create view v_payments_daily with (security_invoker = true) as
  select vendor_id, date_trunc('day', completed_at) as bucket,
         sum(total) as total_collected, count(*) as bill_count
    from bills where status = 'done'
   group by vendor_id, date_trunc('day', completed_at);

create view v_payments_weekly with (security_invoker = true) as
  select vendor_id, date_trunc('week', completed_at) as bucket,
         sum(total) as total_collected, count(*) as bill_count
    from bills where status = 'done'
   group by vendor_id, date_trunc('week', completed_at);

create view v_payments_monthly with (security_invoker = true) as
  select vendor_id, date_trunc('month', completed_at) as bucket,
         sum(total) as total_collected, count(*) as bill_count
    from bills where status = 'done'
   group by vendor_id, date_trunc('month', completed_at);

-- #7: most items sold, by weight.
create view v_top_items with (security_invoker = true) as
  select bi.vendor_id, bi.item_id, i.name_en,
         sum(bi.qty_kg) as total_qty_kg, sum(bi.line_total) as total_revenue
    from bill_items bi
    join bills b on b.id = bi.bill_id and b.status = 'done'
    join items i on i.id = bi.item_id
   group by bi.vendor_id, bi.item_id, i.name_en;

-- #8: bought-together pairs. item_a < item_b keeps each unordered pair once; the
-- threshold of 3 completed bills is fixed by the product spec.
create view v_bought_together with (security_invoker = true) as
  select a.vendor_id, a.item_id as item_a, b.item_id as item_b,
         count(distinct a.bill_id) as bill_count
    from bill_items a
    join bill_items b on b.bill_id = a.bill_id and a.item_id < b.item_id
    join bills bl on bl.id = a.bill_id and bl.status = 'done'
   group by a.vendor_id, a.item_id, b.item_id
  having count(distinct a.bill_id) >= 3;

-- #9: the low-stock bell. Threshold fixed at 10 kg.
create view v_low_stock with (security_invoker = true) as
  select id, vendor_id, name_en, name_hi, name_mr, stock_kg
    from items where is_active and stock_kg < 10;

-- #18: in stock qualifies above 0 kg.
create view v_in_stock with (security_invoker = true) as
  select id, vendor_id, name_en, name_hi, name_mr, stock_kg
    from items where is_active and stock_kg > 0;

-- #10: how often customers asked for something we do not stock.
create view v_stock_request_counts with (security_invoker = true) as
  select vendor_id, lower(item_name) as item_name, count(*) as request_count,
         max(created_at) as last_requested_at
    from stock_requests
   group by vendor_id, lower(item_name);
```

- [ ] **Step 4: Add the test file to the runner**

```js
import "./views.test.mjs";
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd vendor-app && npm test`
Expected: PASS — 9 view cases green, including the leak check.

- [ ] **Step 6: Commit**

```bash
git add vendor-app/supabase/migrations/0004_views.sql vendor-app/tests/
git commit -m "feat(vendor-app): dashboard views for payments, top items and pairs"
```

---

### Task 7: pg_cron points expiry sweep

Expiry is already correct on read — `customer_points_balance` filters on `expires_at`.
This job exists so the ledger records the expiry as an explicit event, which is what makes
"where did my points go" answerable later.

**Files:**
- Create: `vendor-app/supabase/migrations/0005_cron.sql`
- Create: `vendor-app/tests/expiry.test.mjs`
- Modify: `vendor-app/tests/run.mjs`

**Interfaces:**
- Consumes: `points_ledger` from Task 1.
- Produces: `expire_points() returns integer` — writes one offsetting negative row per
  customer whose points have lapsed, returns the number of rows written. Scheduled daily.

- [ ] **Step 1: Write the failing test**

`vendor-app/tests/expiry.test.mjs`:

```js
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd vendor-app && npm test`
Expected: FAIL — `function expire_points() does not exist`.

- [ ] **Step 3: Write the cron migration**

`vendor-app/supabase/migrations/0005_cron.sql`:

```sql
-- Expiry is already correct on READ (customer_points_balance filters on expires_at).
-- This sweep makes the lapse an explicit, auditable ledger event so a customer asking
-- "where did my points go" has an answer.

-- Marks which expiry rows this job wrote, so a second run can tell what it already
-- handled. Without it the sweep would re-offset the same lapsed points every night.
alter table points_ledger add column is_expiry boolean not null default false;

create function expire_points() returns integer
  language plpgsql security definer set search_path = public as $$
declare
  v_written integer;
begin
  with lapsed as (
    select vendor_id, customer_id, sum(points) as pts
      from points_ledger
     where not is_expiry and expires_at <= now()
     group by vendor_id, customer_id
    having sum(points) > 0
  ),
  already as (
    select vendor_id, customer_id, sum(points) as offset_pts
      from points_ledger where is_expiry
     group by vendor_id, customer_id
  )
  insert into points_ledger (vendor_id, customer_id, points, expires_at, is_expiry)
  select l.vendor_id, l.customer_id, -(l.pts + coalesce(a.offset_pts, 0)), now(), true
    from lapsed l
    left join already a
      on a.vendor_id = l.vendor_id and a.customer_id = l.customer_id
   where l.pts + coalesce(a.offset_pts, 0) > 0;

  get diagnostics v_written = row_count;
  return v_written;
end $$;

revoke all on function expire_points() from public, anon, authenticated;

-- Daily at 01:00. pg_cron lives in the extensions schema on Supabase.
create extension if not exists pg_cron with schema extensions;

select cron.schedule('vendor-app-points-expiry', '0 1 * * *', $$select expire_points()$$);
```

- [ ] **Step 4: Add the test file to the runner**

```js
import "./expiry.test.mjs";
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd vendor-app && npm test`
Expected: PASS — the whole suite green, roughly 45 cases.

If `create extension pg_cron` fails on the local stack, add
`[db.extensions]\nenabled = ["pg_cron"]` handling per your CLI version, or split the
`cron.schedule` call into a separate file applied only in deployed environments — but keep
`expire_points()` itself in the migration, since that is what the tests cover.

- [ ] **Step 6: Commit**

```bash
git add vendor-app/supabase/migrations/0005_cron.sql vendor-app/tests/
git commit -m "feat(vendor-app): auditable points expiry sweep on pg_cron"
```

---

## Slice 1 done

At this point the database foundation is complete and proven: schema, RLS verified across
two vendors and three roles, atomic token issuance under 20-way concurrency, idempotent
bill completion with vendor-configured points, dashboard views that do not leak, and an
auditable expiry job.

Not in this slice, by design: the Edge Functions (`whatsapp-webhook`,
`send-notifications`), the pg_cron daily rollup, the React SPA, and Drive integration.
Those are slices 2–4 in the spec.

Two things to start in parallel regardless: Meta business verification and template
approval for `token_issued` and `points_awarded`, which gate slice 2's switch from the
`log` sender to `meta-cloud` and nothing else.
