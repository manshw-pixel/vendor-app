# Purchase Cost, Stock Movements and Margin Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Record purchases and wastage as stock movements, snapshot the latest purchase cost onto each sold line, and show cost, profit and per-item margin on the dashboard.

**Architecture:** One new migration `0016_stock_movements.sql` adds an append-only `stock_movements` table written only through a `security definer` function that moves stock in the same transaction, a nullable `items.last_cost`, and a nullable `bill_items.unit_cost` that `complete_bill()` stamps at completion. Analytics functions widen to return cost and profit. The web app gains a `/stock` screen for admin and recorder, and the dashboard and items screens show the new numbers.

**Tech Stack:** Postgres 17 (Supabase Cloud in prod, native Postgres in tests), plpgsql, Node test runner in `tests/` (`npm test` at repo root), React + TypeScript + Vite + vitest + react-i18next in `web/` (`npm test` and `npm run build` in `web/`).

**Spec:** `docs/superpowers/specs/2026-09-18-purchase-cost-margin-design.md`

## Global Constraints

- Every new tenant table carries `vendor_id` and has RLS enabled; read policy is `vendor_id = current_vendor_id()`.
- `stock_movements` has **no** insert, update or delete policy for any client role. Writes only through `log_stock_movement()`.
- Roles allowed to log movements: `admin`, `recorder`. Biller is refused with sqlstate `42501`.
- Cross-vendor item in `log_stock_movement()` is refused with sqlstate `42501`.
- Wastage larger than current stock raises sqlstate `P0001` with message exactly `wastage exceeds stock`.
- Cost basis is **latest purchase price**. `items.last_cost` null means never purchased and is **never** treated as zero.
- `bill_items.unit_cost` is stamped by `complete_bill()` only; it is never recomputed later.
- Money columns are `numeric(10,2)`. The client never computes cost or profit; it only formats server numbers.
- PostgREST serialises Postgres `numeric` as a **string**. Every numeric read in the web app goes through `Number()`.
- Function parameter names in `supabase.rpc` calls must match the SQL exactly (`p_item_id`, `p_kind`, `p_qty_kg`, `p_unit_cost`, `p_note`, `p_from`, `p_to`).
- Return-type changes use `drop function` then `create function`, then re-issue `revoke ... from public, anon` and `grant execute ... to authenticated, service_role`.
- New i18n keys go into all three of `web/src/i18n/en.json`, `hi.json`, `mr.json`. They are AI-written and join the existing unreviewed set.
- Commit messages end with `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`.
- Deployment is out of scope for the plan's tasks. The migration is applied to Cloud by hand afterwards, then `git push`.

## Deviation from the spec, decided while planning

- **`log_stock_movement` is granted to `authenticated` only, not `service_role`.** `created_by` must be `auth.uid()`, which a service-role caller does not have, so the function refuses a null `current_vendor_id()`. No server-side caller exists or is planned.
- **`clear_vendor_data()` is extended to delete `stock_movements`.** The spec did not mention it. Clearing a shop's transactional data while leaving its intake ledger would leave the ledger pointing at stock levels that no longer mean anything. Items survive clearing, as today.
- **`stock_movements.created_by` references `app_users(id)` with no `ON DELETE`,** exactly like `bills.recorder_id`. Deleting a staff member who has logged movements is refused with `23503`, which the admin-delete-user function already reports as "has history".

## File Structure

| File | Change | Responsibility |
|---|---|---|
| `supabase/migrations/0016_stock_movements.sql` | Create | Table, columns, RLS, `log_stock_movement`, `complete_bill` cost stamp, `clear_vendor_data` extension, analytics functions |
| `tests/stock_movements.test.mjs` | Create | RLS and `log_stock_movement` behaviour |
| `tests/cost_snapshot.test.mjs` | Create | `complete_bill` stamping and `clear_vendor_data` |
| `tests/analytics_cost.test.mjs` | Create | `collected_between`, `top_items_between`, `stock_movements_between` |
| `tests/run.mjs` | Modify | Import the three new test files |
| `web/src/stockRules.ts` | Create | Pure validation and formatting for the intake form |
| `web/src/stock.ts` | Create | Every PostgREST call for stock movements |
| `web/src/screens/Stock.tsx` | Create | The `/stock` screen |
| `web/src/routes.ts` | Modify | `/stock` for admin and recorder |
| `web/src/App.tsx` | Modify | Route element for `/stock` |
| `web/src/errors.ts` | Modify | Map `wastage exceeds stock` to a translated key |
| `web/src/history.ts` | Modify | Widen `Collected` and `TopItem` types |
| `web/src/screens/Dashboards.tsx` | Modify | Cost, profit, uncosted note, margin column |
| `web/src/admin.ts` | Modify | Select `last_cost` |
| `web/src/screens/Items.tsx` | Modify | Show last cost read-only |
| `web/src/i18n/{en,hi,mr}.json` | Modify | New keys |
| `web/src/__tests__/stockRules.test.ts`, `stock.test.ts`, `Stock.test.tsx` | Create | Web tests |
| `web/src/__tests__/routes.test.ts`, `Dashboards.test.tsx`, `Items.test.tsx`, `errors.test.ts` | Modify | Updated expectations |
| `README.md` | Modify | Test count and coverage list |

---

### Task 1: `stock_movements` table, cost columns and `log_stock_movement()`

**Files:**
- Create: `supabase/migrations/0016_stock_movements.sql`
- Create: `tests/stock_movements.test.mjs`
- Modify: `tests/run.mjs` (add one import after `import "./replace_bill_lines.test.mjs";`)

**Interfaces:**
- Consumes: `current_vendor_id()`, `current_user_role()` from `0002_rls.sql`; `seedTwoVendors()` from `tests/seed.mjs` whose vendor objects expose `vendorId, adminId, recorderId, billerId, itemId, clients.{admin,recorder,biller}`; the seeded item has `stock_kg = 100`.
- Produces: table `stock_movements(id, vendor_id, item_id, kind, qty_kg, unit_cost, note, created_by, created_at)`; columns `items.last_cost numeric(10,2) null`, `bill_items.unit_cost numeric(10,2) null`; function `log_stock_movement(p_item_id uuid, p_kind text, p_qty_kg numeric, p_unit_cost numeric default null, p_note text default '') returns stock_movements`.

- [ ] **Step 1: Write the failing tests**

Create `tests/stock_movements.test.mjs`:

```js
import { test, assert, assertDenied, assertInvisible, assertEqual, once } from "./framework.mjs";
import { sql, newClient } from "./fixtures.mjs";
import { seedTwoVendors } from "./seed.mjs";

// Not seeded at import time: run.mjs imports every file before bootstrap() rebuilds the
// schema. once() defers the seed to the first test that needs it.
const getWorld = once(seedTwoVendors);

// A fresh item per case, so stock arithmetic never sees another case's movements.
async function freshItem(vendorId, stockKg = 20) {
  const { rows: [i] } = await sql(
    `insert into items (vendor_id, name_en, name_hi, name_mr, price, stock_kg)
     values ($1,'Tomato','टमाटर','टोमॅटो',40,$2) returning id`, [vendorId, stockKg]);
  return i.id;
}
const itemRow = async (id) =>
  (await sql(`select stock_kg, last_cost from items where id = $1`, [id])).rows[0];
const movementCount = async (itemId) =>
  Number((await sql(`select count(*)::int as n from stock_movements where item_id = $1`, [itemId])).rows[0].n);

const log = (client, args) => client.rpc("log_stock_movement", {
  p_item_id: args.itemId, p_kind: args.kind, p_qty_kg: args.qty,
  ...(args.cost !== undefined ? { p_unit_cost: args.cost } : {}),
  ...(args.note !== undefined ? { p_note: args.note } : {}),
});

test("a recorder's purchase adds stock and sets last_cost", async () => {
  const w = await getWorld();
  const id = await freshItem(w.a.vendorId, 20);
  const { data, error } = await log(w.a.clients.recorder, { itemId: id, kind: "purchase", qty: 15, cost: 22.5, note: "mandi" });
  assert(!error, `purchase refused: ${error?.message}`);
  assertEqual(data.kind, "purchase", "returned row kind");
  assertEqual(data.created_by, w.a.recorderId, "created_by must be the caller");
  const it = await itemRow(id);
  assertEqual(Number(it.stock_kg), 35, "stock did not rise by 15");
  assertEqual(Number(it.last_cost), 22.5, "last_cost not set");
});

test("an admin may log a purchase", async () => {
  const w = await getWorld();
  const id = await freshItem(w.a.vendorId);
  const { error } = await log(w.a.clients.admin, { itemId: id, kind: "purchase", qty: 1, cost: 10 });
  assert(!error, `admin refused: ${error?.message}`);
});

test("a second purchase overwrites last_cost with the latest price", async () => {
  const w = await getWorld();
  const id = await freshItem(w.a.vendorId);
  await log(w.a.clients.recorder, { itemId: id, kind: "purchase", qty: 5, cost: 20 });
  await log(w.a.clients.recorder, { itemId: id, kind: "purchase", qty: 5, cost: 26 });
  assertEqual(Number((await itemRow(id)).last_cost), 26, "latest price must win");
});

test("wastage subtracts stock and leaves last_cost alone", async () => {
  const w = await getWorld();
  const id = await freshItem(w.a.vendorId, 20);
  await log(w.a.clients.recorder, { itemId: id, kind: "purchase", qty: 5, cost: 30 });
  const { data, error } = await log(w.a.clients.recorder, { itemId: id, kind: "wastage", qty: 4, note: "rotten" });
  assert(!error, `wastage refused: ${error?.message}`);
  assertEqual(data.unit_cost, null, "wastage carries no cost");
  const it = await itemRow(id);
  assertEqual(Number(it.stock_kg), 21, "20 + 5 - 4");
  assertEqual(Number(it.last_cost), 30, "wastage must not touch last_cost");
});

test("wastage larger than stock is refused and changes nothing", async () => {
  const w = await getWorld();
  const id = await freshItem(w.a.vendorId, 3);
  const { error } = await log(w.a.clients.recorder, { itemId: id, kind: "wastage", qty: 3.5 });
  assertDenied(error, "wastage over stock was accepted");
  assert(/wastage exceeds stock/.test(error.message), `unexpected message: ${error.message}`);
  assertEqual(Number((await itemRow(id)).stock_kg), 3, "stock moved on a refused wastage");
  assertEqual(await movementCount(id), 0, "a refused wastage left a row");
});

test("wastage equal to stock is allowed and empties it", async () => {
  const w = await getWorld();
  const id = await freshItem(w.a.vendorId, 3);
  const { error } = await log(w.a.clients.recorder, { itemId: id, kind: "wastage", qty: 3 });
  assert(!error, `exact wastage refused: ${error?.message}`);
  assertEqual(Number((await itemRow(id)).stock_kg), 0, "stock should be zero");
});

test("a biller may not log a movement", async () => {
  const w = await getWorld();
  const id = await freshItem(w.a.vendorId);
  const { error } = await log(w.a.clients.biller, { itemId: id, kind: "purchase", qty: 1, cost: 10 });
  assertDenied(error, "a biller logged a purchase");
  assertEqual(await movementCount(id), 0, "biller's refused call left a row");
});

test("a recorder may not log against another vendor's item", async () => {
  const w = await getWorld();
  const bItem = await freshItem(w.b.vendorId, 20);
  const { error } = await log(w.a.clients.recorder, { itemId: bItem, kind: "purchase", qty: 1, cost: 10 });
  assertDenied(error, "vendor A moved vendor B's stock");
  assertEqual(Number((await itemRow(bItem)).stock_kg), 20, "B's stock changed");
});

test("a purchase without a cost is refused", async () => {
  const w = await getWorld();
  const id = await freshItem(w.a.vendorId);
  const { error } = await log(w.a.clients.recorder, { itemId: id, kind: "purchase", qty: 1 });
  assertDenied(error, "a purchase with no cost was accepted");
});

test("a wastage with a cost is refused", async () => {
  const w = await getWorld();
  const id = await freshItem(w.a.vendorId);
  const { error } = await log(w.a.clients.recorder, { itemId: id, kind: "wastage", qty: 1, cost: 5 });
  assertDenied(error, "a wastage with a cost was accepted");
});

test("zero or negative quantity is refused", async () => {
  const w = await getWorld();
  const id = await freshItem(w.a.vendorId);
  for (const qty of [0, -2]) {
    const { error } = await log(w.a.clients.recorder, { itemId: id, kind: "purchase", qty, cost: 5 });
    assertDenied(error, `qty ${qty} was accepted`);
  }
});

test("an unknown kind is refused", async () => {
  const w = await getWorld();
  const id = await freshItem(w.a.vendorId);
  const { error } = await log(w.a.clients.recorder, { itemId: id, kind: "gift", qty: 1 });
  assertDenied(error, "an unknown kind was accepted");
});

test("no role may insert, update or delete stock_movements directly", async () => {
  const w = await getWorld();
  const id = await freshItem(w.a.vendorId);
  await log(w.a.clients.recorder, { itemId: id, kind: "purchase", qty: 2, cost: 9 });
  for (const role of ["admin", "recorder", "biller"]) {
    const c = w.a.clients[role];
    const ins = await c.from("stock_movements").insert({
      vendor_id: w.a.vendorId, item_id: id, kind: "purchase", qty_kg: 1, unit_cost: 1,
      created_by: w.a.adminId,
    });
    assertDenied(ins.error, `${role} inserted a movement directly`);
    const up = await c.from("stock_movements").update({ qty_kg: 99 }).eq("item_id", id).select("id");
    assert(!up.error && up.data.length === 0 || up.error, `${role} updated a movement`);
    const del = await c.from("stock_movements").delete().eq("item_id", id).select("id");
    assert(!del.error && del.data.length === 0 || del.error, `${role} deleted a movement`);
  }
  assertEqual(await movementCount(id), 1, "the one logged row must survive untouched");
  const { rows: [r] } = await sql(`select qty_kg from stock_movements where item_id = $1`, [id]);
  assertEqual(Number(r.qty_kg), 2, "the row's quantity changed");
});

test("staff see their own vendor's movements and none of another's", async () => {
  const w = await getWorld();
  const bItem = await freshItem(w.b.vendorId);
  await log(w.b.clients.recorder, { itemId: bItem, kind: "purchase", qty: 1, cost: 1 });
  const { data } = await w.a.clients.admin.from("stock_movements").select("id").eq("item_id", bItem);
  assertInvisible(data, "vendor A read vendor B's movement");
  const own = await w.b.clients.biller.from("stock_movements").select("id").eq("item_id", bItem);
  assertEqual(own.data.length, 1, "a biller should still read their own vendor's movements");
});

test("an anonymous client sees no movements", async () => {
  const anon = await newClient();
  const { data } = await anon.from("stock_movements").select("id");
  assertInvisible(data, "anon read stock_movements");
});
```

Add to `tests/run.mjs`, directly after `import "./replace_bill_lines.test.mjs";`:

```js
import "./stock_movements.test.mjs";
```

- [ ] **Step 2: Run the suite to verify the new tests fail**

Run: `npm test` (repo root)
Expected: the new cases FAIL with errors naming `log_stock_movement` or `stock_movements` as not existing. All 155 existing cases still pass.

- [ ] **Step 3: Write the migration's first part**

Create `supabase/migrations/0016_stock_movements.sql`:

```sql
-- Slice D: purchase cost, stock intake, wastage and margin.
-- Spec: docs/superpowers/specs/2026-09-18-purchase-cost-margin-design.md
--
-- Cost basis is the LATEST purchase price, copied onto each sold line when the bill is
-- completed (see complete_bill below). Copying rather than looking it up later is what
-- keeps last month's profit from moving when this morning's mandi price changes.

create table stock_movements (
  id         uuid primary key default gen_random_uuid(),
  vendor_id  uuid not null references vendors(id) on delete cascade,
  item_id    uuid not null references items(id),
  kind       text not null check (kind in ('purchase', 'wastage')),
  qty_kg     numeric(10,2) not null check (qty_kg > 0),
  unit_cost  numeric(10,2) check (unit_cost >= 0),
  note       text not null default '',
  -- No ON DELETE, like bills.recorder_id: a staff member with history cannot be deleted,
  -- and admin-delete-user already reports that 23503 as "has history".
  created_by uuid not null references app_users(id),
  created_at timestamptz not null default now(),
  constraint stock_movements_cost_matches_kind check (
    (kind = 'purchase' and unit_cost is not null)
    or (kind = 'wastage' and unit_cost is null)
  )
);
create index stock_movements_vendor_created_idx on stock_movements(vendor_id, created_at);
create index stock_movements_vendor_item_idx on stock_movements(vendor_id, item_id);

alter table stock_movements enable row level security;

-- Read for every role in the shop. Deliberately NO insert, update or delete policy: the
-- row and the stock change must commit together, so log_stock_movement() is the only
-- writer. A mistake is corrected by logging an opposite movement, never by editing one.
create policy stock_movements_read on stock_movements for select to authenticated
  using (vendor_id = current_vendor_id());

-- Null means "never purchased". It is never read as zero: a zero cost would report the
-- whole sale price as profit.
alter table items add column last_cost numeric(10,2) check (last_cost >= 0);

-- Stamped by complete_bill() from items.last_cost. Null on every bill completed before
-- this migration, and on lines for items never purchased.
alter table bill_items add column unit_cost numeric(10,2) check (unit_cost >= 0);

create function log_stock_movement(
  p_item_id   uuid,
  p_kind      text,
  p_qty_kg    numeric,
  p_unit_cost numeric default null,
  p_note      text default ''
) returns stock_movements
  language plpgsql security definer set search_path = public as $$
declare
  v_item items%rowtype;
  v_row  stock_movements%rowtype;
  v_qty  numeric := round(p_qty_kg, 2);
  v_cost numeric := round(p_unit_cost, 2);
begin
  -- A null vendor means no end-user session. Unlike complete_bill, that is refused here:
  -- created_by must be a real staff member and a service-role caller has no auth.uid().
  if current_vendor_id() is null or current_user_role() not in ('admin', 'recorder') then
    raise exception 'only an admin or recorder may log stock movements'
      using errcode = '42501';
  end if;

  select * into v_item from items where id = p_item_id for update;
  if not found or v_item.vendor_id <> current_vendor_id() then
    raise exception 'item % is not in your shop', p_item_id using errcode = '42501';
  end if;

  if p_kind is null or p_kind not in ('purchase', 'wastage') then
    raise exception 'unknown movement kind %', p_kind using errcode = '22023';
  end if;
  if v_qty is null or v_qty <= 0 then
    raise exception 'quantity must be above zero' using errcode = '22023';
  end if;
  if p_kind = 'purchase' and (v_cost is null or v_cost < 0) then
    raise exception 'a purchase needs a cost per kg' using errcode = '22023';
  end if;
  if p_kind = 'wastage' and v_cost is not null then
    raise exception 'a wastage has no cost' using errcode = '22023';
  end if;
  -- Refused, not clamped. complete_bill clamps because a customer is waiting; nobody is
  -- waiting on a wastage entry, and clamping would record waste that never happened.
  if p_kind = 'wastage' and v_qty > v_item.stock_kg then
    raise exception 'wastage exceeds stock'
      using errcode = 'P0001', detail = v_item.stock_kg::text;
  end if;

  insert into stock_movements (vendor_id, item_id, kind, qty_kg, unit_cost, note, created_by)
  values (v_item.vendor_id, v_item.id, p_kind, v_qty, v_cost, coalesce(btrim(p_note), ''), auth.uid())
  returning * into v_row;

  if p_kind = 'purchase' then
    update items set stock_kg = stock_kg + v_qty, last_cost = v_cost where id = v_item.id;
  else
    update items set stock_kg = stock_kg - v_qty where id = v_item.id;
  end if;

  return v_row;
end $$;

revoke all on function log_stock_movement(uuid, text, numeric, numeric, text) from public, anon;
grant execute on function log_stock_movement(uuid, text, numeric, numeric, text) to authenticated;
```

- [ ] **Step 4: Run the suite to verify it passes**

Run: `npm test` (repo root)
Expected: all cases pass, 155 existing plus 15 new = 170, exit 0.

If the direct update/delete assertions fail because the client returns an error shape different from the one assumed, check `tests/client.mjs`: a policy-filtered update or delete returns zero rows and no error; either outcome satisfies the assertion, and the final row-count and quantity checks are the real guard.

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/0016_stock_movements.sql tests/stock_movements.test.mjs tests/run.mjs
git commit -m "feat: log purchases and wastage as stock movements

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 2: `complete_bill()` stamps cost; `clear_vendor_data()` clears movements

**Files:**
- Modify: `supabase/migrations/0016_stock_movements.sql` (append)
- Create: `tests/cost_snapshot.test.mjs`
- Modify: `tests/run.mjs` (one import)

**Interfaces:**
- Consumes: `log_stock_movement` and the cost columns from Task 1; `complete_bill(p_bill_id uuid, p_biller_id uuid default null, p_redeem_points integer default 0)` as defined in `supabase/migrations/0010_points_redemption.sql` lines 20-164; `clear_vendor_data()` as defined in `supabase/migrations/0009_clear_vendor_data.sql`.
- Produces: `bill_items.unit_cost` is non-null after completion whenever the item had a `last_cost`; `clear_vendor_data()` also empties `stock_movements` for the caller's vendor. Signatures unchanged.

- [ ] **Step 1: Write the failing tests**

Create `tests/cost_snapshot.test.mjs`:

```js
import { test, assert, assertEqual, once } from "./framework.mjs";
import { sql } from "./fixtures.mjs";
import { seedTwoVendors } from "./seed.mjs";

const getWorld = once(seedTwoVendors);

// A billed bill for a fresh item in vendor A. lastCost null means the item has never
// been purchased. Set directly in SQL: this file tests complete_bill, not the intake.
async function billedLine(w, { lastCost, qty = 2 }) {
  const { rows: [i] } = await sql(
    `insert into items (vendor_id, name_en, price, stock_kg, last_cost)
     values ($1,'Carrot',50,100,$2) returning id`, [w.a.vendorId, lastCost]);
  const { rows: [b] } = await sql(
    `insert into bills (vendor_id, customer_id, total, status)
     values ($1,$2,0,'recording') returning id`, [w.a.vendorId, w.a.customerId]);
  await sql(`insert into bill_items (bill_id, vendor_id, item_id, qty_kg, unit_price, line_total)
             values ($1,$2,$3,$4,50,$5)`, [b.id, w.a.vendorId, i.id, qty, qty * 50]);
  await sql(`select issue_token($1)`, [b.id]);
  return { itemId: i.id, billId: b.id };
}
const lineCost = async (billId) =>
  (await sql(`select unit_cost from bill_items where bill_id = $1`, [billId])).rows[0].unit_cost;

test("complete_bill stamps each line with the item's last_cost", async () => {
  const w = await getWorld();
  const x = await billedLine(w, { lastCost: 31.25 });
  await sql(`select complete_bill($1)`, [x.billId]);
  assertEqual(Number(await lineCost(x.billId)), 31.25, "unit_cost was not stamped");
});

test("a never-purchased item leaves unit_cost null, not zero", async () => {
  const w = await getWorld();
  const x = await billedLine(w, { lastCost: null });
  await sql(`select complete_bill($1)`, [x.billId]);
  assertEqual(await lineCost(x.billId), null, "an unknown cost must stay null");
});

test("a purchase logged after completion does not change the stamped cost", async () => {
  const w = await getWorld();
  const x = await billedLine(w, { lastCost: 20 });
  await sql(`select complete_bill($1)`, [x.billId]);
  const { error } = await w.a.clients.recorder.rpc("log_stock_movement", {
    p_item_id: x.itemId, p_kind: "purchase", p_qty_kg: 5, p_unit_cost: 45,
  });
  assert(!error, `purchase refused: ${error?.message}`);
  assertEqual(Number(await lineCost(x.billId)), 20, "history moved with today's price");
});

test("a retried complete_bill does not restamp", async () => {
  const w = await getWorld();
  const x = await billedLine(w, { lastCost: 20 });
  await sql(`select complete_bill($1)`, [x.billId]);
  await sql(`update items set last_cost = 99 where id = $1`, [x.itemId]);
  await sql(`select complete_bill($1)`, [x.billId]);
  assertEqual(Number(await lineCost(x.billId)), 20, "the retry restamped a done bill");
});

test("stamping cost does not disturb stock or the stored total", async () => {
  const w = await getWorld();
  const x = await billedLine(w, { lastCost: 10, qty: 3 });
  await sql(`select complete_bill($1)`, [x.billId]);
  const { rows: [i] } = await sql(`select stock_kg from items where id = $1`, [x.itemId]);
  const { rows: [b] } = await sql(`select total from bills where id = $1`, [x.billId]);
  assertEqual(Number(i.stock_kg), 97, "stock decrement changed");
  assertEqual(Number(b.total), 150, "total changed");
});

test("clear_vendor_data removes the vendor's movements and keeps the other vendor's", async () => {
  const w = await seedTwoVendors();   // its own world: clearing would wreck the shared one
  const log = (c, itemId) => c.rpc("log_stock_movement", {
    p_item_id: itemId, p_kind: "purchase", p_qty_kg: 1, p_unit_cost: 5,
  });
  await log(w.a.clients.recorder, w.a.itemId);
  await log(w.b.clients.recorder, w.b.itemId);
  const { error } = await w.a.clients.admin.rpc("clear_vendor_data");
  assert(!error, `clear refused: ${error?.message}`);
  const count = async (v) =>
    Number((await sql(`select count(*)::int n from stock_movements where vendor_id = $1`, [v])).rows[0].n);
  assertEqual(await count(w.a.vendorId), 0, "A's movements survived clearing");
  assertEqual(await count(w.b.vendorId), 1, "clearing A touched B");
});
```

Add to `tests/run.mjs`, after `import "./stock_movements.test.mjs";`:

```js
import "./cost_snapshot.test.mjs";
```

- [ ] **Step 2: Run to verify the new tests fail**

Run: `npm test`
Expected: the stamping cases FAIL with `unit_cost` null where a number was expected; the clear case FAILs with A's count at 1. Everything else passes.

- [ ] **Step 3: Append to the migration**

Append to `supabase/migrations/0016_stock_movements.sql`.

First the `complete_bill` replacement. Same signature as 0010, so `create or replace` is correct here and no overload is created. **Copy the whole function from `supabase/migrations/0010_points_redemption.sql` lines 20-164 verbatim**, change its first line from `create function complete_bill(` to `create or replace function complete_bill(`, and insert exactly this block immediately **before** the line `  -- Stock (#3). greatest(...,0) keeps the non-negative check from turning an`:

```sql
  -- Slice D: copy today's cost onto each line. After the idempotency guard above, so a
  -- retry of a done bill returns before reaching here and never restamps. A null
  -- last_cost stays null: an unknown cost is reported as unknown, never as free.
  update bill_items bi
     set unit_cost = i.last_cost
    from items i
   where bi.bill_id = p_bill_id
     and i.id = bi.item_id;

```

Then re-issue the grants exactly as 0010 does:

```sql
revoke all on function complete_bill(uuid, uuid, integer) from public, anon;
grant execute on function complete_bill(uuid, uuid, integer) to authenticated;
```

Then `clear_vendor_data`. **Copy the whole function from `supabase/migrations/0009_clear_vendor_data.sql`** (from `create function clear_vendor_data()` to its closing `end $$;`), change `create function` to `create or replace function`, and insert this line immediately after `delete from stock_requests where vendor_id = v_vendor;`:

```sql
  delete from stock_movements where vendor_id = v_vendor;
```

Keep its existing `revoke`/`grant` lines from 0009 after it, copied verbatim.

- [ ] **Step 4: Run to verify**

Run: `npm test`
Expected: all pass, 170 + 6 = 176. In particular every case in `complete_bill.test.mjs`, `redemption.test.mjs` and `clear_vendor_data.test.mjs` still passes, which is the check that the verbatim copy lost nothing.

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/0016_stock_movements.sql tests/cost_snapshot.test.mjs tests/run.mjs
git commit -m "feat: stamp purchase cost onto sold lines at completion

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 3: Analytics return cost, profit and margin; `stock_movements_between()`

**Files:**
- Modify: `supabase/migrations/0016_stock_movements.sql` (append)
- Create: `tests/analytics_cost.test.mjs`
- Modify: `tests/run.mjs` (one import)

**Interfaces:**
- Consumes: `bill_items.unit_cost` from Task 1, stamped by Task 2; existing `collected_between` and `top_items_between` from `0007_analytics_by_date.sql`.
- Produces:
  - `collected_between(p_from timestamptz, p_to timestamptz) returns table (total numeric, bill_count bigint, cost numeric, profit numeric, uncosted_lines bigint)`
  - `top_items_between(p_from timestamptz, p_to timestamptz) returns table (item_id uuid, name_en text, name_hi text, name_mr text, total_qty_kg numeric, total_revenue numeric, total_cost numeric, margin numeric, uncosted_lines bigint)`
  - `stock_movements_between(p_from timestamptz, p_to timestamptz) returns table (id uuid, item_id uuid, name_en text, name_hi text, name_mr text, kind text, qty_kg numeric, unit_cost numeric, note text, created_by_name text, created_at timestamptz)`

- [ ] **Step 1: Write the failing tests**

Create `tests/analytics_cost.test.mjs`. It builds the costed bills inside a seeded world's vendor A and queries through A's admin client. It must NOT use the raw `sql()` helper to call the analytics functions: that helper runs as the table owner, which bypasses RLS, so the functions would aggregate every vendor in the test database.

```js
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
```

Add to `tests/run.mjs`, after `import "./cost_snapshot.test.mjs";`:

```js
import "./analytics_cost.test.mjs";
```

- [ ] **Step 2: Run to verify the new tests fail**

Run: `npm test`
Expected: new cases FAIL on missing columns `cost`, `total_cost` and missing function `stock_movements_between`.

- [ ] **Step 3: Append to the migration**

```sql
-- Analytics: cost and profit beside revenue. DROP then CREATE because the return types
-- change and CREATE OR REPLACE cannot do that. Argument lists are unchanged, so the
-- PostgREST overload ambiguity 0010 warns about does not arise.
--
-- Cost sums only lines with a known unit_cost. uncosted_lines says how many were left
-- out, so the screen can say the profit figure is incomplete rather than silently high.

drop function if exists collected_between(timestamptz, timestamptz);

create function collected_between(p_from timestamptz, p_to timestamptz)
  returns table (total numeric, bill_count bigint, cost numeric, profit numeric, uncosted_lines bigint)
  language sql stable as $$
  with done as (
    select b.id, b.total
      from bills b
     where b.status = 'done'
       and b.completed_at >= p_from
       and b.completed_at <  p_to
  ), lines as (
    select coalesce(sum(bi.qty_kg * bi.unit_cost), 0)            as cost,
           count(*) filter (where bi.unit_cost is null)          as uncosted
      from bill_items bi
      join done d on d.id = bi.bill_id
  )
  select coalesce((select sum(total) from done), 0)                       as total,
         (select count(*) from done)                                      as bill_count,
         round(l.cost, 2)                                                 as cost,
         round(coalesce((select sum(total) from done), 0) - l.cost, 2)    as profit,
         l.uncosted                                                       as uncosted_lines
    from lines l;
$$;

revoke all on function collected_between(timestamptz, timestamptz) from public, anon;
grant execute on function collected_between(timestamptz, timestamptz) to authenticated, service_role;

drop function if exists top_items_between(timestamptz, timestamptz);

create function top_items_between(p_from timestamptz, p_to timestamptz)
  returns table (
    item_id        uuid,
    name_en        text,
    name_hi        text,
    name_mr        text,
    total_qty_kg   numeric,
    total_revenue  numeric,
    total_cost     numeric,
    margin         numeric,
    uncosted_lines bigint
  )
  language sql stable as $$
  select bi.item_id, i.name_en, i.name_hi, i.name_mr,
         sum(bi.qty_kg)                                   as total_qty_kg,
         sum(bi.line_total)                               as total_revenue,
         -- sum() over all-null input is null, which is what "cost unknown" should be.
         round(sum(bi.qty_kg * bi.unit_cost), 2)          as total_cost,
         -- Margin over the COSTED lines only. Subtracting a partial cost from the full
         -- revenue would overstate margin for a half-costed item.
         round(sum(bi.line_total) filter (where bi.unit_cost is not null)
               - sum(bi.qty_kg * bi.unit_cost), 2)        as margin,
         count(*) filter (where bi.unit_cost is null)     as uncosted_lines
    from bill_items bi
    join bills b on b.id = bi.bill_id
                and b.status = 'done'
                and b.completed_at >= p_from
                and b.completed_at <  p_to
    join items i on i.id = bi.item_id
   group by bi.item_id, i.name_en, i.name_hi, i.name_mr
   order by sum(bi.qty_kg) desc, bi.item_id
   limit 10;
$$;

revoke all on function top_items_between(timestamptz, timestamptz) from public, anon;
grant execute on function top_items_between(timestamptz, timestamptz) to authenticated, service_role;

-- The /stock screen's list. Plain language sql with no security definer, so RLS on
-- stock_movements, items and app_users scopes it to the caller's shop.
create function stock_movements_between(p_from timestamptz, p_to timestamptz)
  returns table (
    id              uuid,
    item_id         uuid,
    name_en         text,
    name_hi         text,
    name_mr         text,
    kind            text,
    qty_kg          numeric,
    unit_cost       numeric,
    note            text,
    created_by_name text,
    created_at      timestamptz
  )
  language sql stable as $$
  select m.id, m.item_id, i.name_en, i.name_hi, i.name_mr,
         m.kind, m.qty_kg, m.unit_cost, m.note, u.name, m.created_at
    from stock_movements m
    join items i on i.id = m.item_id
    left join app_users u on u.id = m.created_by
   where m.created_at >= p_from
     and m.created_at <  p_to
   order by m.created_at desc, m.id desc
   limit 500;
$$;

revoke all on function stock_movements_between(timestamptz, timestamptz) from public, anon;
grant execute on function stock_movements_between(timestamptz, timestamptz) to authenticated, service_role;
```

Note on the margin: the Onion test expects margin 100 (revenue 300 minus cost 200), and both onion lines are costed, so the filtered and unfiltered revenue agree there. The filter matters only for a partly costed item.

- [ ] **Step 4: Run to verify**

Run: `npm test`
Expected: all pass, 176 + 8 = 184. The existing `analytics.test.mjs` cases for `collected_between` and `top_items_between` must still pass unchanged, since the old columns keep their names and meanings.

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/0016_stock_movements.sql tests/analytics_cost.test.mjs tests/run.mjs
git commit -m "feat: report cost, profit and margin in the analytics functions

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 4: Web data layer and validation for stock movements

**Files:**
- Create: `web/src/stockRules.ts`
- Create: `web/src/stock.ts`
- Create: `web/src/__tests__/stockRules.test.ts`
- Create: `web/src/__tests__/stock.test.ts`

**Interfaces:**
- Consumes: SQL functions `log_stock_movement` and `stock_movements_between` from Tasks 1 and 3; `toBounds(range)` and `Range` — check `web/src/history.ts` and `web/src/dateRange.ts` for where `toBounds` is defined and whether it is exported; if it is not exported, export it from its defining file without changing its behaviour.
- Produces:
  - `stockRules.ts`: `type MovementKind = "purchase" | "wastage"`; `type MovementInput = { itemId: string; kind: MovementKind; qtyKg: string; unitCost: string; note: string }`; `type MovementField = "itemId" | "qtyKg" | "unitCost"`; `validateMovement(input: MovementInput): { ok: true; value: { itemId: string; kind: MovementKind; qtyKg: number; unitCost: number | null; note: string } } | { ok: false; errors: Partial<Record<MovementField, string>> }` where error values are i18n keys; `signedKg(kind: MovementKind, qty: number | string): string`.
  - `stock.ts`: `type Movement = { id: string; item_id: string; name_en: string; name_hi: string; name_mr: string; kind: MovementKind; qty_kg: string | number; unit_cost: string | number | null; note: string; created_by_name: string | null; created_at: string }`; `logMovement(v: { itemId: string; kind: MovementKind; qtyKg: number; unitCost: number | null; note: string })`; `movementsBetween(range: Range)`.

- [ ] **Step 1: Write the failing tests**

`web/src/__tests__/stockRules.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { validateMovement, signedKg, type MovementInput } from "../stockRules";

const base: MovementInput = { itemId: "i1", kind: "purchase", qtyKg: "5", unitCost: "22.50", note: "" };

describe("validateMovement", () => {
  it("accepts a purchase with kg and cost", () => {
    const r = validateMovement(base);
    expect(r).toEqual({ ok: true, value: { itemId: "i1", kind: "purchase", qtyKg: 5, unitCost: 22.5, note: "" } });
  });

  it("requires an item", () => {
    const r = validateMovement({ ...base, itemId: "" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.itemId).toBe("stock.needItem");
  });

  it.each(["", "0", "-1", "abc", "1.234"])("refuses kg %j", (qtyKg) => {
    const r = validateMovement({ ...base, qtyKg });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.qtyKg).toBe("stock.badKg");
  });

  it.each(["", "-1", "x", "1.001"])("refuses purchase cost %j", (unitCost) => {
    const r = validateMovement({ ...base, unitCost });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.unitCost).toBe("stock.badCost");
  });

  it("accepts a zero cost purchase, which is a gift from the supplier", () => {
    const r = validateMovement({ ...base, unitCost: "0" });
    expect(r.ok).toBe(true);
  });

  it("ignores any cost typed for a wastage and sends null", () => {
    const r = validateMovement({ ...base, kind: "wastage", unitCost: "garbage" });
    expect(r).toEqual({ ok: true, value: { itemId: "i1", kind: "wastage", qtyKg: 5, unitCost: null, note: "" } });
  });

  it("trims the note", () => {
    const r = validateMovement({ ...base, note: "  vashi  " });
    expect(r.ok && r.value.note).toBe("vashi");
  });
});

describe("signedKg", () => {
  it("prefixes a purchase with a plus", () => {
    expect(signedKg("purchase", 5)).toBe("+5 kg");
  });
  it("prefixes a wastage with a minus sign", () => {
    expect(signedKg("wastage", "2.50")).toBe("−2.5 kg");
  });
});
```

`web/src/__tests__/stock.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";

const rpc = vi.fn(async (..._a: unknown[]) => ({ data: null, error: null }));
vi.mock("../supabase", () => ({ supabase: { rpc: (...a: unknown[]) => rpc(...a) } }));

const { logMovement, movementsBetween } = await import("../stock");

beforeEach(() => vi.clearAllMocks());

describe("logMovement", () => {
  it("calls log_stock_movement with the exact SQL parameter names", async () => {
    await logMovement({ itemId: "i1", kind: "purchase", qtyKg: 5, unitCost: 22.5, note: "vashi" });
    expect(rpc).toHaveBeenCalledWith("log_stock_movement", {
      p_item_id: "i1", p_kind: "purchase", p_qty_kg: 5, p_unit_cost: 22.5, p_note: "vashi",
    });
  });

  it("omits p_unit_cost for a wastage so the SQL default of null applies", async () => {
    await logMovement({ itemId: "i1", kind: "wastage", qtyKg: 2, unitCost: null, note: "" });
    expect(rpc).toHaveBeenCalledWith("log_stock_movement", {
      p_item_id: "i1", p_kind: "wastage", p_qty_kg: 2, p_note: "",
    });
  });
});

describe("movementsBetween", () => {
  it("calls stock_movements_between with p_from and p_to", async () => {
    await movementsBetween({ from: "2026-09-01", to: "2026-09-30" } as never);
    expect(rpc).toHaveBeenCalledTimes(1);
    const [fn, args] = rpc.mock.calls[0] as [string, Record<string, string>];
    expect(fn).toBe("stock_movements_between");
    expect(Object.keys(args).sort()).toEqual(["p_from", "p_to"]);
  });
});
```

If `Range` in `web/src/dateRange.ts` has a different shape than `{ from, to }`, build the argument with `presetRange("today", new Date())` from `../dateRange` instead of the literal, and drop the `as never`.

- [ ] **Step 2: Run to verify they fail**

Run: `npm test -- stockRules stock.test` in `web/`
Expected: FAIL, cannot resolve `../stockRules` and `../stock`.

- [ ] **Step 3: Implement**

`web/src/stockRules.ts`:

```ts
/**
 * Validation for the /stock intake form. Pure, so it is tested without a screen.
 *
 * The database checks all of this again inside log_stock_movement (0016). These rules
 * exist to say what is wrong in the staff member's language before a round trip, not to
 * protect anything.
 */
export type MovementKind = "purchase" | "wastage";
export type MovementInput = { itemId: string; kind: MovementKind; qtyKg: string; unitCost: string; note: string };
export type MovementField = "itemId" | "qtyKg" | "unitCost";
export type MovementValue = { itemId: string; kind: MovementKind; qtyKg: number; unitCost: number | null; note: string };

// At most two decimals: the columns are numeric(10,2), and a third decimal would be
// rounded silently by the database into a number the staff member never typed.
const TWO_DP = /^\d+(\.\d{1,2})?$/;

export function validateMovement(
  input: MovementInput,
): { ok: true; value: MovementValue } | { ok: false; errors: Partial<Record<MovementField, string>> } {
  const errors: Partial<Record<MovementField, string>> = {};
  if (input.itemId === "") errors.itemId = "stock.needItem";

  const qtyRaw = input.qtyKg.trim();
  const qty = Number(qtyRaw);
  if (!TWO_DP.test(qtyRaw) || !(qty > 0)) errors.qtyKg = "stock.badKg";

  let cost: number | null = null;
  if (input.kind === "purchase") {
    const costRaw = input.unitCost.trim();
    cost = Number(costRaw);
    if (!TWO_DP.test(costRaw)) errors.unitCost = "stock.badCost";
  }

  if (Object.keys(errors).length > 0) return { ok: false, errors };
  return { ok: true, value: { itemId: input.itemId, kind: input.kind, qtyKg: qty, unitCost: cost, note: input.note.trim() } };
}

/** "+5 kg" for a purchase, "−2.5 kg" for a wastage. The minus is U+2212, which lines up
 *  with the plus in a list; a hyphen sits visibly lower. */
export function signedKg(kind: MovementKind, qty: number | string): string {
  return `${kind === "purchase" ? "+" : "−"}${Number(qty)} kg`;
}
```

`web/src/stock.ts`:

```ts
import { supabase } from "./supabase";
import type { Range } from "./dateRange";
import { toBounds } from "./history";   // adjust the import to wherever toBounds is defined
import type { MovementKind } from "./stockRules";

/** One row of stock_movements_between (0016). Numeric columns arrive as strings from
 *  PostgREST; Number() them before arithmetic or display. */
export type Movement = {
  id: string;
  item_id: string;
  name_en: string;
  name_hi: string;
  name_mr: string;
  kind: MovementKind;
  qty_kg: string | number;
  unit_cost: string | number | null;
  note: string;
  created_by_name: string | null;
  created_at: string;
};

/**
 * Every PostgREST call for stock movements. No vendor_id is sent: log_stock_movement
 * reads the vendor off the item and refuses one that is not the caller's, and the read
 * is scoped by RLS.
 *
 * Parameter names must match 0016_stock_movements.sql exactly; PostgREST resolves the
 * function by argument name and a mismatch reads as "function not found".
 */
export async function logMovement(v: {
  itemId: string; kind: MovementKind; qtyKg: number; unitCost: number | null; note: string;
}) {
  const args: Record<string, unknown> = {
    p_item_id: v.itemId, p_kind: v.kind, p_qty_kg: v.qtyKg, p_note: v.note,
  };
  // Omitted rather than sent as null for a wastage: the SQL default is null, and not
  // sending it keeps the call identical to what the function documents.
  if (v.unitCost !== null) args.p_unit_cost = v.unitCost;
  return supabase.rpc("log_stock_movement", args);
}

export async function movementsBetween(range: Range) {
  const { fromTs, toTs } = toBounds(range);
  return supabase.rpc("stock_movements_between", { p_from: fromTs, p_to: toTs });
}
```

- [ ] **Step 4: Run to verify**

Run in `web/`: `npm test` then `npm run build`
Expected: all web tests pass (378 existing + 17 new); `tsc` reports no errors.

- [ ] **Step 5: Commit**

```bash
git add web/src/stockRules.ts web/src/stock.ts web/src/__tests__/stockRules.test.ts web/src/__tests__/stock.test.ts web/src/history.ts web/src/dateRange.ts
git commit -m "feat: web data layer and validation for stock movements

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

(`git add` of an unchanged file is a no-op, so listing `history.ts` and `dateRange.ts` is safe whether or not `toBounds` needed exporting.)

---

### Task 5: The `/stock` screen, its route, error mapping and translations

**Files:**
- Create: `web/src/screens/Stock.tsx`
- Create: `web/src/__tests__/Stock.test.tsx`
- Modify: `web/src/routes.ts` (BY_ROLE)
- Modify: `web/src/__tests__/routes.test.ts`
- Modify: `web/src/App.tsx` (import and `<Route>` next to `/requests` at line 110)
- Modify: `web/src/errors.ts` and `web/src/__tests__/errors.test.ts`
- Modify: `web/src/i18n/en.json`, `hi.json`, `mr.json`

**Interfaces:**
- Consumes: `validateMovement`, `signedKg`, `MovementKind` from `stockRules.ts`; `logMovement`, `movementsBetween`, `Movement` from `stock.ts`; `listItems()` from `data.ts` (active items with `id, name_en, name_hi, name_mr, price, stock_kg`); `itemName(item, lang)` and `Lang` from `i18n/locales.ts`; `DateFilter` component and `presetRange` as `Dashboards.tsx` uses them; `describeError(error)` from `errors.ts` returning `{ key, detail } | null`; `rupees()` from `money.ts`.
- Produces: route `/stock` for admin and recorder; i18n keys under `stock.*` and `nav.stock`; `describeError` maps a message containing `wastage exceeds stock` to key `stock.overStock`.

- [ ] **Step 1: Read `web/src/errors.ts` and its test**

Read both files fully. Note how `describeError` picks a key from an error's `code` and `message`, and how existing tests assert it. The new mapping follows that exact pattern.

- [ ] **Step 2: Write the failing tests**

In `web/src/__tests__/routes.test.ts`, change the recorder expectation to:

```ts
    expect(routesForRole("recorder").map((r) => r.path)).toEqual(["/bill", "/customers", "/requests", "/stock"]);
```

change the admin expectation to insert `"/stock"` directly after `"/requests"`:

```ts
    expect(routesForRole("admin").map((r) => r.path)).toEqual([
      "/bill",
      "/pending",
      "/completed",
      "/items",
      "/customers",
      "/requests",
      "/stock",
      "/settings",
      "/dashboards",
    ]);
```

and add:

```ts
  it("keeps stock intake away from billers", () => {
    expect(canAccess("biller", "/stock")).toBe(false);
    expect(canAccess("recorder", "/stock")).toBe(true);
    expect(canAccess("admin", "/stock")).toBe(true);
  });
```

In `web/src/__tests__/errors.test.ts`, add a case in the existing style:

```ts
  it("names an over-stock wastage in the staff member's terms", () => {
    const r = describeError({ code: "P0001", message: "wastage exceeds stock" });
    expect(r?.key).toBe("stock.overStock");
  });
```

Create `web/src/__tests__/Stock.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import type { Movement } from "../stock";

vi.mock("../components/SessionProvider", () => ({
  useSession: () => ({ kind: "ready", userId: "u1", vendorId: "v1", vendorName: "V", name: "R", role: "recorder" }),
}));

const items = [
  { id: "i1", name_en: "Onion", name_hi: "प्याज", name_mr: "कांदा", price: 40, stock_kg: 12, is_active: true },
];
const listItems = vi.fn(async () => ({ data: items, error: null }));
vi.mock("../data", () => ({ listItems: () => listItems() }));

const rows: Movement[] = [{
  id: "m1", item_id: "i1", name_en: "Onion", name_hi: "प्याज", name_mr: "कांदा",
  kind: "wastage", qty_kg: "2.50", unit_cost: null, note: "rotten",
  created_by_name: "Recorder A", created_at: "2026-09-18T04:00:00Z",
}];
const movementsBetween = vi.fn(async (..._a: unknown[]) => ({ data: rows, error: null }));
const logMovement = vi.fn(async (..._a: unknown[]): Promise<{
  data: unknown; error: { code?: string; message?: string } | null;
}> => ({ data: {}, error: null }));
vi.mock("../stock", () => ({
  movementsBetween: (...a: unknown[]) => movementsBetween(...a),
  logMovement: (...a: unknown[]) => logMovement(...a),
}));

const { default: Stock } = await import("../screens/Stock");

beforeEach(() => vi.clearAllMocks());

describe("the stock screen", () => {
  it("lists movements with a signed quantity", async () => {
    render(<Stock />);
    const row = await screen.findByTestId("stock-row-m1");
    expect(row.textContent).toContain("−2.5 kg");
    expect(row.textContent).toContain("rotten");
    expect(row.textContent).toContain("Recorder A");
  });

  it("logs a purchase with the parsed numbers and reloads the list", async () => {
    render(<Stock />);
    await screen.findByTestId("stock-row-m1");
    fireEvent.change(screen.getByTestId("stock-item"), { target: { value: "i1" } });
    fireEvent.change(screen.getByTestId("stock-kg"), { target: { value: "5" } });
    fireEvent.change(screen.getByTestId("stock-cost"), { target: { value: "22.50" } });
    fireEvent.click(screen.getByTestId("stock-submit"));
    await waitFor(() => expect(logMovement).toHaveBeenCalledWith({
      itemId: "i1", kind: "purchase", qtyKg: 5, unitCost: 22.5, note: "",
    }));
    await waitFor(() => expect(movementsBetween).toHaveBeenCalledTimes(2));
  });

  it("hides the cost field for a wastage", async () => {
    render(<Stock />);
    await screen.findByTestId("stock-row-m1");
    fireEvent.click(screen.getByTestId("stock-kind-wastage"));
    expect(screen.queryByTestId("stock-cost")).toBeNull();
  });

  it("shows a field error and does not call the server for a bad kg", async () => {
    render(<Stock />);
    await screen.findByTestId("stock-row-m1");
    fireEvent.change(screen.getByTestId("stock-item"), { target: { value: "i1" } });
    fireEvent.change(screen.getByTestId("stock-kg"), { target: { value: "0" } });
    fireEvent.change(screen.getByTestId("stock-cost"), { target: { value: "10" } });
    fireEvent.click(screen.getByTestId("stock-submit"));
    expect(await screen.findByTestId("stock-err-qtyKg")).toBeTruthy();
    expect(logMovement).not.toHaveBeenCalled();
  });

  it("explains an over-stock wastage and shows the current stock", async () => {
    logMovement.mockResolvedValueOnce({ data: null, error: { code: "P0001", message: "wastage exceeds stock" } });
    render(<Stock />);
    await screen.findByTestId("stock-row-m1");
    fireEvent.click(screen.getByTestId("stock-kind-wastage"));
    fireEvent.change(screen.getByTestId("stock-item"), { target: { value: "i1" } });
    fireEvent.change(screen.getByTestId("stock-kg"), { target: { value: "50" } });
    fireEvent.click(screen.getByTestId("stock-submit"));
    const p = await screen.findByTestId("stock-problem");
    expect(p.textContent).toContain("12");
  });
});
```

- [ ] **Step 3: Run to verify they fail**

Run in `web/`: `npm test -- routes errors Stock`
Expected: FAIL: routes lack `/stock`, `describeError` does not know the message, `../screens/Stock` does not exist.

- [ ] **Step 4: Implement**

`web/src/routes.ts`: add `{ path: "/stock", labelKey: "nav.stock" }` to `recorder` after `/requests`, and to `admin` after `/requests`.

`web/src/App.tsx`: add `import Stock from "./screens/Stock";` beside `import Requests from "./screens/Requests";`, and `<Route path="/stock" element={<Stock />} />` directly after the `/requests` route.

`web/src/errors.ts`: add the mapping so that an error whose `message` includes `wastage exceeds stock` returns `{ key: "stock.overStock", detail: <message> }`, checked **before** any generic `P0001` handling, following the file's existing structure.

i18n: add `"stock": "Stock in/out"` inside the existing `nav` object of `en.json`, and add a new top-level `stock` object. English:

```json
"stock": {
  "title": "Stock in and out",
  "hint": "Log what came in from the mandi and what was thrown away. Stock updates straight away.",
  "item": "Item",
  "pickItem": "Choose an item",
  "purchase": "Purchase",
  "wastage": "Wastage",
  "kg": "Kg",
  "cost": "Cost per kg (₹)",
  "note": "Note (optional)",
  "submit": "Save",
  "loading": "Loading…",
  "empty": "Nothing logged in this period.",
  "needItem": "Choose an item.",
  "badKg": "Enter kg above zero, at most two decimals.",
  "badCost": "Enter the cost per kg, at most two decimals.",
  "overStock": "That is more than the {{kg}} kg in stock.",
  "by": "by {{name}}",
  "lastCost": "Cost {{amount}}",
  "noCost": "No cost yet"
}
```

Hindi (`hi.json`), `nav.stock`: `"स्टॉक आवक/जावक"`, and:

```json
"stock": {
  "title": "स्टॉक आवक और जावक",
  "hint": "मंडी से आया माल और खराब हुआ माल यहाँ दर्ज करें। स्टॉक तुरंत बदल जाएगा।",
  "item": "सामान",
  "pickItem": "सामान चुनें",
  "purchase": "खरीद",
  "wastage": "खराब माल",
  "kg": "किलो",
  "cost": "प्रति किलो लागत (₹)",
  "note": "टिप्पणी (वैकल्पिक)",
  "submit": "सहेजें",
  "loading": "लोड हो रहा है…",
  "empty": "इस अवधि में कुछ दर्ज नहीं हुआ।",
  "needItem": "सामान चुनें।",
  "badKg": "शून्य से अधिक किलो दर्ज करें, अधिकतम दो दशमलव।",
  "badCost": "प्रति किलो लागत दर्ज करें, अधिकतम दो दशमलव।",
  "overStock": "यह स्टॉक में मौजूद {{kg}} किलो से अधिक है।",
  "by": "{{name}} द्वारा",
  "lastCost": "लागत {{amount}}",
  "noCost": "अभी लागत नहीं"
}
```

Marathi (`mr.json`), `nav.stock`: `"स्टॉक आवक/जावक"`, and:

```json
"stock": {
  "title": "स्टॉक आवक आणि जावक",
  "hint": "मंडईतून आलेला माल आणि खराब झालेला माल येथे नोंदवा. स्टॉक लगेच बदलेल.",
  "item": "वस्तू",
  "pickItem": "वस्तू निवडा",
  "purchase": "खरेदी",
  "wastage": "खराब माल",
  "kg": "किलो",
  "cost": "प्रति किलो खर्च (₹)",
  "note": "टीप (ऐच्छिक)",
  "submit": "जतन करा",
  "loading": "लोड होत आहे…",
  "empty": "या कालावधीत काहीही नोंदलेले नाही.",
  "needItem": "वस्तू निवडा.",
  "badKg": "शून्यापेक्षा जास्त किलो भरा, जास्तीत जास्त दोन दशांश.",
  "badCost": "प्रति किलो खर्च भरा, जास्तीत जास्त दोन दशांश.",
  "overStock": "हे स्टॉकमधील {{kg}} किलोपेक्षा जास्त आहे.",
  "by": "{{name}} यांनी",
  "lastCost": "खर्च {{amount}}",
  "noCost": "अजून खर्च नाही"
}
```

Before adding the Marathi strings, check how existing `mr.json` values end sentences (full stop or `।`) and match the file's convention; the memory notes this terminator is an open question, so copy whatever the file currently does.

`web/src/screens/Stock.tsx`:

```tsx
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { listItems, type Item } from "../data";
import { logMovement, movementsBetween, type Movement } from "../stock";
import { validateMovement, signedKg, type MovementField, type MovementKind } from "../stockRules";
import { presetRange, type Range } from "../dateRange";
import { DateFilter } from "../components/DateFilter";
import { itemName, type Lang } from "../i18n/locales";
import { rupees } from "../money";
import { describeError } from "../errors";
import "../i18n";

export default function Stock() {
  const { t, i18n } = useTranslation();
  const lang = i18n.language as Lang;
  const [items, setItems] = useState<Item[]>([]);
  const [rows, setRows] = useState<Movement[]>([]);
  const [range, setRange] = useState<Range>(() => presetRange("today", new Date()));
  const [itemId, setItemId] = useState("");
  const [kind, setKind] = useState<MovementKind>("purchase");
  const [qtyKg, setQtyKg] = useState("");
  const [unitCost, setUnitCost] = useState("");
  const [note, setNote] = useState("");
  const [fieldErrors, setFieldErrors] = useState<Partial<Record<MovementField, string>>>({});
  const [busy, setBusy] = useState(true);
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<{ key: string; detail: string } | null>(null);
  // Same stale-response guard as Dashboards.tsx: two quick range taps must not let the
  // slower, older fetch paint last.
  const wanted = useRef("");

  const load = useCallback(async (r: Range) => {
    const key = `${r.from}..${r.to}`;
    wanted.current = key;
    setBusy(true);
    const { data, error } = await movementsBetween(r);
    if (wanted.current !== key) return;
    setBusy(false);
    if (error) setProblem(describeError(error));
    setRows((data ?? []) as Movement[]);
  }, []);

  useEffect(() => {
    void (async () => {
      const { data } = await listItems();
      setItems((data ?? []) as Item[]);
    })();
  }, []);
  useEffect(() => { void load(range); }, [range, load]);

  async function submit() {
    const r = validateMovement({ itemId, kind, qtyKg, unitCost, note });
    if (!r.ok) { setFieldErrors(r.errors); return; }
    setFieldErrors({});
    setSaving(true);
    const { error } = await logMovement(r.value);
    setSaving(false);
    if (error) { setProblem(describeError(error)); return; }
    setProblem(null);
    setQtyKg(""); setUnitCost(""); setNote("");
    // Refresh the item list too: its stock_kg is what the over-stock message quotes.
    const fresh = await listItems();
    setItems((fresh.data ?? []) as Item[]);
    await load(range);
  }

  const chosen = items.find((i) => i.id === itemId);
  const input = "border border-slate-300 rounded-lg px-3 min-h-[44px] w-full";

  return (
    <div className="space-y-4">
      <div>
        <h2 className="font-semibold text-slate-800">{t("stock.title")}</h2>
        <p className="text-xs text-slate-500">{t("stock.hint")}</p>
      </div>

      <section className="bg-white border border-slate-200 rounded-xl p-4 space-y-3">
        <div className="flex gap-2" role="radiogroup">
          {(["purchase", "wastage"] as const).map((k) => (
            <button key={k} type="button" role="radio" aria-checked={kind === k}
                    data-testid={`stock-kind-${k}`} onClick={() => setKind(k)}
                    className={`flex-1 rounded-lg min-h-[44px] border ${kind === k
                      ? "bg-green-600 text-white border-green-600" : "border-slate-300 text-slate-700"}`}>
              {t(`stock.${k}`)}
            </button>
          ))}
        </div>

        <label className="block text-sm text-slate-600">
          {t("stock.item")}
          <select value={itemId} onChange={(e) => setItemId(e.target.value)}
                  data-testid="stock-item" className={input}>
            <option value="">{t("stock.pickItem")}</option>
            {items.map((i) => (
              <option key={i.id} value={i.id}>{itemName(i, lang)} ({Number(i.stock_kg)} kg)</option>
            ))}
          </select>
          {fieldErrors.itemId && <span data-testid="stock-err-itemId" className="text-xs text-red-600">{t(fieldErrors.itemId)}</span>}
        </label>

        <div className="grid grid-cols-2 gap-2">
          <label className="block text-sm text-slate-600">
            {t("stock.kg")}
            <input inputMode="decimal" value={qtyKg} onChange={(e) => setQtyKg(e.target.value)}
                   data-testid="stock-kg" className={input} />
            {fieldErrors.qtyKg && <span data-testid="stock-err-qtyKg" className="text-xs text-red-600">{t(fieldErrors.qtyKg)}</span>}
          </label>
          {kind === "purchase" && (
            <label className="block text-sm text-slate-600">
              {t("stock.cost")}
              <input inputMode="decimal" value={unitCost} onChange={(e) => setUnitCost(e.target.value)}
                     data-testid="stock-cost" className={input} />
              {fieldErrors.unitCost && <span data-testid="stock-err-unitCost" className="text-xs text-red-600">{t(fieldErrors.unitCost)}</span>}
            </label>
          )}
        </div>

        <label className="block text-sm text-slate-600">
          {t("stock.note")}
          <input value={note} onChange={(e) => setNote(e.target.value)} data-testid="stock-note" className={input} />
        </label>

        <button onClick={() => void submit()} disabled={saving} data-testid="stock-submit"
                className="w-full bg-green-600 text-white rounded-lg min-h-[44px] disabled:opacity-50">
          {t("stock.submit")}
        </button>
      </section>

      {problem && (
        <div data-testid="stock-problem" className="bg-red-50 border border-red-200 rounded-lg p-3">
          <p className="text-sm text-red-700">
            {t(problem.key, { kg: chosen ? Number(chosen.stock_kg) : "" })}
          </p>
          {problem.detail && (
            <p className="text-xs text-red-600 mt-1 break-words">{t("error.details")}: {problem.detail}</p>
          )}
        </div>
      )}

      <DateFilter value={range} onChange={setRange} />

      {busy && <p className="text-sm text-slate-500">{t("stock.loading")}</p>}
      {!busy && rows.length === 0 && <p className="text-sm text-slate-500">{t("stock.empty")}</p>}

      <ul className="space-y-2">
        {rows.map((m) => (
          <li key={m.id} data-testid={`stock-row-${m.id}`}
              className="bg-white border border-slate-200 rounded-xl p-3 text-sm">
            <div className="flex justify-between gap-3">
              <span className="text-slate-800">{itemName(m, lang)}</span>
              <span className={m.kind === "purchase" ? "text-green-700" : "text-red-700"}>
                {signedKg(m.kind, m.qty_kg)}
              </span>
            </div>
            <div className="flex justify-between gap-3 text-xs text-slate-500">
              <span>
                {new Date(m.created_at).toLocaleString()}
                {m.created_by_name ? ` · ${t("stock.by", { name: m.created_by_name })}` : ""}
                {m.note ? ` · ${m.note}` : ""}
              </span>
              {m.unit_cost !== null && <span>{rupees(Number(m.unit_cost))}/kg</span>}
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
```

If `presetRange` does not accept `"today"`, read `web/src/dateRange.ts` and use its name for the current day. If `Item` is not exported from `data.ts` under that name, it is: `export type Item` at `web/src/data.ts:7`.

- [ ] **Step 5: Run to verify**

Run in `web/`: `npm test` then `npm run build`
Expected: all pass, including the existing i18n parity tests (if a test compares key sets across the three locale files, it now passes because all three gained the same keys). `tsc` clean.

- [ ] **Step 6: Commit**

```bash
git add web/src/screens/Stock.tsx web/src/__tests__/Stock.test.tsx web/src/routes.ts web/src/__tests__/routes.test.ts web/src/App.tsx web/src/errors.ts web/src/__tests__/errors.test.ts web/src/i18n/en.json web/src/i18n/hi.json web/src/i18n/mr.json
git commit -m "feat: stock intake and wastage screen for admin and recorder

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 6: Cost, profit and margin on the dashboard; last cost on the items screen

**Files:**
- Modify: `web/src/history.ts` (types `TopItem` at line 35, `Collected` at line 66)
- Modify: `web/src/screens/Dashboards.tsx`
- Modify: `web/src/__tests__/Dashboards.test.tsx`
- Modify: `web/src/admin.ts` (`AdminItem`, `ITEM_COLS`)
- Modify: `web/src/screens/Items.tsx` (price cell near line 162)
- Modify: `web/src/__tests__/Items.test.tsx`
- Modify: `web/src/i18n/en.json`, `hi.json`, `mr.json` (`dash.*` additions)

**Interfaces:**
- Consumes: widened `collected_between` and `top_items_between` from Task 3; `items.last_cost` from Task 1; `stock.lastCost` and `stock.noCost` keys from Task 5.
- Produces: `Collected = { total: string | number; bill_count: number; cost: string | number; profit: string | number; uncosted_lines: string | number }`; `TopItem` gains `total_cost: string | number | null; margin: string | number | null; uncosted_lines: string | number`; `AdminItem` gains `last_cost: string | number | null`.

- [ ] **Step 1: Write the failing tests**

In `web/src/__tests__/Dashboards.test.tsx`:

Change the `collectedBetween` mock's type and default to:

```ts
const collectedBetween = vi.fn(async (..._a: unknown[]): Promise<{
  data: { total: string; bill_count: number; cost: string; profit: string; uncosted_lines: string }[] | null;
  error: { code?: string; message?: string } | null;
}> => ({ data: [{ total: "350.50", bill_count: 2, cost: "200.00", profit: "150.50", uncosted_lines: "0" }], error: null }));
```

Change the `topItemsBetween` default row to include the new fields:

```ts
    total_qty_kg: 12, total_revenue: 480, total_cost: "300.00", margin: "180.00", uncosted_lines: "0",
```

Update the existing empty-range stub at line 98 to `{ total: "0", bill_count: 0, cost: "0", profit: "0", uncosted_lines: "0" }`.

Add cases:

```ts
  it("shows cost and profit through rupees()", async () => {
    render(<Dashboards />);
    expect((await screen.findByTestId("dash-cost")).textContent).toContain("₹200.00");
    expect((await screen.findByTestId("dash-profit")).textContent).toContain("₹150.50");
  });

  it("says how many lines had no purchase cost", async () => {
    collectedBetween.mockResolvedValueOnce({
      data: [{ total: "100", bill_count: 1, cost: "0", profit: "100", uncosted_lines: "3" }], error: null });
    render(<Dashboards />);
    expect((await screen.findByTestId("dash-uncosted")).textContent).toContain("3");
  });

  it("hides the uncosted note when every line had a cost", async () => {
    render(<Dashboards />);
    await screen.findByTestId("dash-profit");
    expect(screen.queryByTestId("dash-uncosted")).toBeNull();
  });

  it("shows each top item's margin", async () => {
    render(<Dashboards />);
    const row = await screen.findByTestId("dash-top-i1");
    expect(row.textContent).toContain("₹180.00");
  });

  it("shows a dash for a top item whose margin is unknown", async () => {
    topItemsBetween.mockResolvedValueOnce({
      data: [{ item_id: "i1", name_en: "Onion", name_hi: "प्याज", name_mr: "कांदा",
               total_qty_kg: 12, total_revenue: 480, total_cost: null, margin: null, uncosted_lines: "4" }],
      error: null });
    render(<Dashboards />);
    const margin = await screen.findByTestId("dash-top-margin-i1");
    expect(margin.textContent).toBe("—");
  });
```

In `web/src/__tests__/Items.test.tsx`, read the file first to find how items are stubbed, add `last_cost: "31.25"` to one stubbed item and `last_cost: null` to another, and add:

```ts
  it("shows the last purchase cost, or says there is none", async () => {
    // render as the file's existing cases do, then:
    expect((await screen.findByTestId("item-cost-<id of the costed item>")).textContent).toContain("₹31.25");
    expect((await screen.findByTestId("item-cost-<id of the uncosted item>")).textContent).toContain("No cost yet");
  });
```

replacing the two `<id ...>` markers with the ids used in that file's stub data.

- [ ] **Step 2: Run to verify they fail**

Run in `web/`: `npm test -- Dashboards Items`
Expected: new cases FAIL (no `dash-cost`, `dash-profit`, `dash-uncosted`, `dash-top-margin-*`, `item-cost-*`). `tsc` may also flag the mock's new fields until the types change.

- [ ] **Step 3: Implement**

`web/src/history.ts`:

```ts
export type TopItem = {
  item_id: string;
  name_en: string;
  name_hi: string;
  name_mr: string;
  total_qty_kg: number;
  total_revenue: number;
  /** Null when no line of this item had a purchase cost. Never read null as zero. */
  total_cost: string | number | null;
  margin: string | number | null;
  uncosted_lines: string | number;
};
```

```ts
export type Collected = {
  total: string | number;
  bill_count: number;
  cost: string | number;
  profit: string | number;
  uncosted_lines: string | number;
};
```

`web/src/screens/Dashboards.tsx`:
- Add state: `const [cost, setCost] = useState(0); const [profit, setProfit] = useState(0); const [uncosted, setUncosted] = useState(0);`
- In `load`, after `setBillCount(...)`:

```ts
    setCost(Number(row?.cost ?? 0));
    setProfit(Number(row?.profit ?? 0));
    setUncosted(Number(row?.uncosted_lines ?? 0));
```

- Replace the collected card with one that carries the new rows:

```tsx
        <Card title={t("dash.collected")}>
          <p className="text-2xl font-semibold text-slate-800">{rupees(collected)}</p>
          <dl className="mt-2 text-sm grid grid-cols-2 gap-y-1">
            <dt className="text-slate-500">{t("dash.cost")}</dt>
            <dd data-testid="dash-cost" className="text-right text-slate-700">{rupees(cost)}</dd>
            <dt className="text-slate-500">{t("dash.profit")}</dt>
            <dd data-testid="dash-profit" className="text-right font-semibold text-slate-800">{rupees(profit)}</dd>
          </dl>
          {uncosted > 0 && (
            <p data-testid="dash-uncosted" className="mt-2 text-xs text-amber-700">
              {t("dash.uncosted", { n: uncosted })}
            </p>
          )}
        </Card>
```

- In the top-items row, replace the right-hand `<span>` with:

```tsx
                <span className="text-slate-600">
                  {t("dash.kg", { kg: i.total_qty_kg })} · {rupees(Number(i.total_revenue))}
                  {" · "}
                  <span data-testid={`dash-top-margin-${i.item_id}`}
                        title={t("dash.margin")}
                        className="text-green-700">
                    {i.margin === null ? "—" : rupees(Number(i.margin))}
                  </span>
                </span>
```

- Change the top-items card subtitle to explain the third figure: keep `subtitle={t("dash.topItemsSub")}` and update that key's text in the three locale files as below.

i18n `dash` additions.

English: `"cost": "Cost"`, `"profit": "Profit"`, `"margin": "Margin"`, `"uncosted": "{{n}} sold lines had no purchase cost, so profit is shown too high."` and change `topItemsSub` to append ` Kg · sales · margin.` to its current text.

Hindi: `"cost": "लागत"`, `"profit": "मुनाफ़ा"`, `"margin": "मार्जिन"`, `"uncosted": "{{n}} बिकी लाइनों की खरीद लागत नहीं थी, इसलिए मुनाफ़ा ज़्यादा दिख रहा है।"`, and append ` किलो · बिक्री · मार्जिन।` to `topItemsSub`.

Marathi: `"cost": "खर्च"`, `"profit": "नफा"`, `"margin": "मार्जिन"`, `"uncosted": "{{n}} विकलेल्या ओळींचा खरेदी खर्च नव्हता, म्हणून नफा जास्त दिसत आहे."`, and append ` किलो · विक्री · मार्जिन.` to `topItemsSub`. Match `mr.json`'s existing sentence terminator as in Task 5.

`web/src/admin.ts`: add `last_cost: string | number | null;` to `AdminItem` with a one-line comment that null means never purchased, and change `ITEM_COLS` to `"id, name_en, name_hi, name_mr, price, stock_kg, is_active, last_cost"`.

`web/src/screens/Items.tsx`: read lines 140-175 first. Directly after the element that renders `{rupees(it.price)}`, add:

```tsx
                    <span data-testid={`item-cost-${it.id}`} className="block text-xs text-slate-500">
                      {it.last_cost === null
                        ? t("stock.noCost")
                        : t("stock.lastCost", { amount: rupees(Number(it.last_cost)) })}
                    </span>
```

If the editing form in `Items.tsx` builds its initial value by spreading an `AdminItem`, confirm `last_cost` does not leak into `updateItem`'s payload: `updateItem(id, value: ItemValue)` takes `ItemValue`, which has no `last_cost`, so `tsc` will catch a leak.

- [ ] **Step 4: Run to verify**

Run in `web/`: `npm test` then `npm run build`
Expected: all web tests pass; `tsc` clean.

- [ ] **Step 5: Commit**

```bash
git add web/src/history.ts web/src/screens/Dashboards.tsx web/src/__tests__/Dashboards.test.tsx web/src/admin.ts web/src/screens/Items.tsx web/src/__tests__/Items.test.tsx web/src/i18n/en.json web/src/i18n/hi.json web/src/i18n/mr.json
git commit -m "feat: show cost, profit and margin on the dashboard

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 7: README and full verification

**Files:**
- Modify: `README.md`

**Interfaces:**
- Consumes: everything above.
- Produces: an accurate README; a verified green state on both suites.

- [ ] **Step 1: Run both suites and the build from clean**

```bash
npm test
cd web && npm test && npm run build
```

Record the exact case counts from the output. Expected: DB suite exit 0 with 184 cases, web suite green, `tsc` clean. If any count differs from the plan's arithmetic, use the real number; the plan's counts are estimates.

- [ ] **Step 2: Update README**

In `README.md`:
- Change the heading `## ✅ Verified: 142 cases, 0 failures` and the sentence under it to the real DB case count, and "all thirteen migrations" to "all sixteen migrations". Check first: the README already lags (it says 142 and thirteen while the suite ran 155 over fifteen); correct it to the real current numbers.
- Add a bullet to the "Covered" list:

```markdown
- **Stock movements and cost.** `log_stock_movement()` admits admin and recorder and
  refuses biller and cross-tenant items; a purchase adds stock and sets `last_cost`, a
  wastage subtracts and is refused beyond current stock; nobody can write
  `stock_movements` directly. `complete_bill()` stamps each line's `unit_cost` once and a
  later purchase does not move it. `collected_between` and `top_items_between` report
  cost, profit and margin over costed lines only, with unknown cost kept null.
```

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs: record stock movement and cost coverage

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## After the plan: deployment (not a task, needs the owner)

1. Apply `supabase/migrations/0016_stock_movements.sql` to the Cloud project by hand in the SQL editor, confirming the editor is on the production project first, and record it in the migrations tracking table as 0013-0015 were.
2. `git push`, then confirm CI is green on Linux.
3. Existing done bills have null `unit_cost`, so the dashboard will show the uncosted note until the first purchases are logged and new bills complete. That is expected.
