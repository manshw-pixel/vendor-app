# Item Units (kg, piece, bunch, dozen) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let each item be sold in one of kg, piece, bunch or dozen, with whole-number quantities for non-kg units, a per-item low-stock threshold, and every screen naming the unit.

**Architecture:** Migration `0018_item_units.sql` adds `items.unit` and `items.low_stock_at`, a trigger enforcing whole stock and a unit lock after the first sale, a helper `assert_whole_qty()` called from `replace_bill_lines` and `log_stock_movement`, and recreates `v_low_stock`, `v_in_stock`, `top_items_between` (ranked by revenue, returns unit) and `stock_movements_between` (returns unit). Quantity columns keep their `_kg` names and now mean "quantity in the item's unit". The web gains a `units.ts` module and every quantity or price label follows the item's unit.

**Tech Stack:** Postgres 17 / plpgsql; Node test runner in `tests/` (`npm test` at repo root, native Postgres, pooled RLS-scoped clients whose `.rpc()` unwraps non-set results and whose `.maybeSingle()` errors on >1 rows); React + TS + Vite + vitest + react-i18next in `web/` (`npm test`, `npm run build`).

**Spec:** `docs/superpowers/specs/2026-09-18-item-units-design.md`

## Global Constraints

- Unit set is exactly `kg`, `piece`, `bunch`, `dozen`; column `items.unit text not null default 'kg'`.
- `items.low_stock_at numeric(10,2) not null default 10 check (>= 0)`; every "low stock" decision in SQL and web reads it instead of the literal 10.
- Non-kg quantities are whole numbers, enforced server-side in three places: the `items` trigger (stock), `replace_bill_lines` (bill lines), `log_stock_movement` (movements); error sqlstate `22023`. kg keeps two decimals.
- Unit is locked once any `bill_items` row references the item: trigger raises `P0001` with message exactly `unit is locked once the item has been sold`.
- Quantity columns keep their names (`stock_kg`, `qty_kg`); a `comment on column` records the new meaning. No column renames.
- `top_items_between` orders by `sum(line_total) desc, item_id` and returns `unit`; all other columns unchanged. `stock_movements_between` returns `unit`.
- `complete_bill`, `void_bill`, `issue_token`, `collected_between`, `bought_together_between` are not touched.
- Web never hardcodes "kg" in a label again: all quantity/price text goes through `qtyText()` / `perUnit()` in `web/src/units.ts`.
- PostgREST serialises numeric as strings; `Number()` every numeric.
- New i18n keys in all three of `en.json`, `hi.json`, `mr.json` with identical key sets; hi sentences end `।`, mr `.`.
- Commit messages end with a blank line then a `Co-Authored-By:` trailer naming the model that wrote the commit.
- Do not change any database server setting. Deployment is the owner's step after the plan.

## File Structure

| File | Change | Responsibility |
|---|---|---|
| `supabase/migrations/0018_item_units.sql` | Create | columns, comments, trigger, helper, function/view recreations |
| `tests/item_units.test.mjs` | Create | schema, trigger, views |
| `tests/item_units_functions.test.mjs` | Create | whole-qty guards, analytics unit/ordering |
| `tests/run.mjs` | Modify | two imports |
| `web/src/units.ts` | Create | `Unit`, `UNITS`, `isWholeUnit`, `validateQty`, `qtyText`, `perUnit` |
| `web/src/billing.ts` | Modify | `Draft.unit`; `validateWeight` stays for kg (used by `validateQty`) |
| `web/src/data.ts`, `admin.ts`, `history.ts`, `receipt.ts`, `stock.ts` | Modify | types and selects gain `unit` (+ `low_stock_at`, `sold`) |
| `web/src/adminRules.ts` | Modify | `ItemInput`/`ItemValue` gain `unit`, `low_stock_at`; whole-stock rule; `stockLevel(kg, lowAt)` |
| `web/src/stockRules.ts` | Modify | `validateMovement` takes the unit; whole rule |
| `web/src/screens/Items.tsx`, `bill/ItemGrid.tsx`, `bill/Basket.tsx`, `Completed.tsx`, `Receipt.tsx`, `Stock.tsx`, `Dashboards.tsx` | Modify | unit-aware labels/inputs |
| `web/src/i18n/{en,hi,mr}.json` | Modify | `unit.*` block; reworded kg keys |
| `web/src/__tests__/*` | Create/Modify | `units.test.ts`; updated screen and rules tests |
| `README.md` | Modify | count and coverage |

---

### Task 1: Schema, trigger and views

**Files:**
- Create: `supabase/migrations/0018_item_units.sql`
- Create: `tests/item_units.test.mjs`
- Modify: `tests/run.mjs` (after `import "./void_analytics.test.mjs";`)

**Interfaces:**
- Consumes: `items`, `bill_items`, `stock_movements` from 0001/0016; `v_low_stock`, `v_in_stock` from 0004; `seedTwoVendors()` (vendor exposes `vendorId, itemId, customerId, recorderId, clients.{admin,recorder,biller}`; seeded item is kg with stock 100).
- Produces: `items.unit`, `items.low_stock_at`; trigger `items_unit_rules`; `v_low_stock(id, vendor_id, name_en, name_hi, name_mr, stock_kg, unit, low_stock_at)`; `v_in_stock(..., unit)`.

- [ ] **Step 1: Failing tests** — `tests/item_units.test.mjs`:

```js
import { test, assert, assertEqual, once } from "./framework.mjs";
import { sql } from "./fixtures.mjs";
import { seedTwoVendors } from "./seed.mjs";

const getWorld = once(seedTwoVendors);

const newItem = async (vendorId, { unit = "kg", stock = 10, lowAt = null } = {}) => {
  const { rows: [i] } = await sql(
    `insert into items (vendor_id, name_en, price, stock_kg, unit${lowAt !== null ? ", low_stock_at" : ""})
     values ($1,'U-'||$2,20,$3,$2${lowAt !== null ? ",$4" : ""}) returning id, unit, low_stock_at`,
    lowAt !== null ? [vendorId, unit, stock, lowAt] : [vendorId, unit, stock]);
  return i;
};
const expectFail = async (fn, re, msg) => {
  let err = null;
  try { await fn(); } catch (e) { err = e; }
  assert(err, msg);
  assert(re.test(err.message), `${msg}: unexpected message ${err.message}`);
};

test("existing and new items default to kg with a low-stock threshold of 10", async () => {
  const w = await getWorld();
  const { rows: [seeded] } = await sql(`select unit, low_stock_at from items where id=$1`, [w.a.itemId]);
  assertEqual(seeded.unit, "kg", "seeded unit");
  assertEqual(Number(seeded.low_stock_at), 10, "seeded threshold");
  const i = await newItem(w.a.vendorId);
  assertEqual(i.unit, "kg", "default unit");
  assertEqual(Number(i.low_stock_at), 10, "default threshold");
});

test("only the four units are accepted", async () => {
  const w = await getWorld();
  for (const u of ["piece", "bunch", "dozen"]) assertEqual((await newItem(w.a.vendorId, { unit: u })).unit, u, u);
  await expectFail(() => newItem(w.a.vendorId, { unit: "gram" }), /items_unit_check|check constraint/i, "gram accepted");
});

test("a piece item refuses fractional stock and accepts whole stock", async () => {
  const w = await getWorld();
  await expectFail(() => newItem(w.a.vendorId, { unit: "piece", stock: 2.5 }), /whole number/i, "2.5 pieces accepted");
  const i = await newItem(w.a.vendorId, { unit: "piece", stock: 3 });
  await expectFail(() => sql(`update items set stock_kg = 3.25 where id=$1`, [i.id]), /whole number/i, "update to 3.25 accepted");
  await sql(`update items set stock_kg = 7 where id=$1`, [i.id]);
});

test("a kg item still accepts fractional stock", async () => {
  const w = await getWorld();
  const i = await newItem(w.a.vendorId, { unit: "kg", stock: 2.5 });
  await sql(`update items set stock_kg = 3.75 where id=$1`, [i.id]);
});

test("unit can change before a sale and is locked after one", async () => {
  const w = await getWorld();
  const i = await newItem(w.a.vendorId, { unit: "piece", stock: 5 });
  await sql(`update items set unit='bunch' where id=$1`, [i.id]);
  const { rows: [b] } = await sql(
    `insert into bills (vendor_id, customer_id, total, status) values ($1,$2,0,'recording') returning id`,
    [w.a.vendorId, w.a.customerId]);
  await sql(`insert into bill_items (bill_id, vendor_id, item_id, qty_kg, unit_price, line_total) values ($1,$2,$3,1,20,20)`,
    [b.id, w.a.vendorId, i.id]);
  await expectFail(() => sql(`update items set unit='dozen' where id=$1`, [i.id]), /unit is locked once the item has been sold/, "unit changed after a sale");
  // Other columns still editable after a sale.
  await sql(`update items set price = 25 where id=$1`, [i.id]);
});

test("v_low_stock honours the per-item threshold", async () => {
  const w = await getWorld();
  const tight = await newItem(w.a.vendorId, { unit: "dozen", stock: 8, lowAt: 3 });   // not low
  const loose = await newItem(w.a.vendorId, { unit: "kg", stock: 40, lowAt: 50 });    // low
  const { data } = await w.a.clients.admin.from("v_low_stock").select("id, unit, low_stock_at");
  const ids = data.map((r) => r.id);
  assert(!ids.includes(tight.id), "8 dozen with threshold 3 flagged low");
  assert(ids.includes(loose.id), "40 kg with threshold 50 not flagged");
  const row = data.find((r) => r.id === loose.id);
  assertEqual(row.unit, "kg", "view returns unit");
  assertEqual(Number(row.low_stock_at), 50, "view returns threshold");
});

test("v_in_stock returns the unit", async () => {
  const w = await getWorld();
  const i = await newItem(w.a.vendorId, { unit: "bunch", stock: 2 });
  const { data } = await w.a.clients.recorder.from("v_in_stock").select("id, unit").eq("id", i.id);
  assertEqual(data[0].unit, "bunch", "unit missing from v_in_stock");
});

test("the low-stock threshold cannot be negative", async () => {
  const w = await getWorld();
  await expectFail(() => newItem(w.a.vendorId, { lowAt: -1 }), /check constraint|low_stock_at/i, "negative threshold accepted");
});
```

Add `import "./item_units.test.mjs";` to `tests/run.mjs` after the void_analytics import.

- [ ] **Step 2: Run** `npm test` — new cases fail (no column `unit`); 211 existing pass.

- [ ] **Step 3: Migration**

```sql
-- Items sold by piece, bunch or dozen.
-- Spec: docs/superpowers/specs/2026-09-18-item-units-design.md
--
-- The quantity columns keep their _kg names. Renaming them would mean recreating every
-- function from 0003 to 0017 for no behavioural gain; the comments below record the new
-- meaning instead.

alter table items
  add column unit text not null default 'kg'
    constraint items_unit_check check (unit in ('kg', 'piece', 'bunch', 'dozen')),
  add column low_stock_at numeric(10,2) not null default 10
    constraint items_low_stock_at_check check (low_stock_at >= 0);

comment on column items.unit is 'Selling unit: kg, piece, bunch or dozen. One per item; locked once sold.';
comment on column items.low_stock_at is 'The low-stock bell rings below this many of items.unit. Default 10 (requirement #9).';
comment on column items.stock_kg is 'Quantity in the item''s unit (items.unit). The _kg suffix is historical.';
comment on column bill_items.qty_kg is 'Quantity in the item''s unit (items.unit). The _kg suffix is historical.';
comment on column stock_movements.qty_kg is 'Quantity in the item''s unit (items.unit). The _kg suffix is historical.';

-- Whole numbers for anything you cannot cut in half; and a unit that cannot change once
-- a sale has recorded a quantity in it, because the history would silently change meaning.
create function items_unit_rules() returns trigger language plpgsql as $$
begin
  if new.unit <> 'kg' and new.stock_kg <> floor(new.stock_kg) then
    raise exception 'stock must be a whole number for this unit' using errcode = '22023';
  end if;
  if tg_op = 'UPDATE' and new.unit <> old.unit
     and exists (select 1 from bill_items where item_id = new.id) then
    raise exception 'unit is locked once the item has been sold' using errcode = 'P0001';
  end if;
  return new;
end $$;

create trigger items_unit_rules before insert or update on items
  for each row execute function items_unit_rules();

-- #9 with a per-item threshold. security_invoker as in 0004, so RLS scopes it.
drop view if exists v_low_stock;
create view v_low_stock with (security_invoker = true) as
  select id, vendor_id, name_en, name_hi, name_mr, stock_kg, unit, low_stock_at
    from items where is_active and stock_kg < low_stock_at;

drop view if exists v_in_stock;
create view v_in_stock with (security_invoker = true) as
  select id, vendor_id, name_en, name_hi, name_mr, stock_kg, unit
    from items where is_active and stock_kg > 0;
```

Check 0004 for `grant select on v_low_stock / v_in_stock` lines; if present, re-issue the same grants after the recreation.

- [ ] **Step 4: Run** `npm test` — 211 + 8 = 219. `views.test.mjs` must still pass.
- [ ] **Step 5: Commit** `feat: items carry a selling unit and a per-item low-stock threshold`.

---

### Task 2: Whole-quantity guards and unit-aware analytics

**Files:**
- Modify: `supabase/migrations/0018_item_units.sql` (append)
- Create: `tests/item_units_functions.test.mjs`
- Modify: `tests/run.mjs`

**Interfaces:**
- Consumes: `replace_bill_lines(p_bill_id uuid, p_lines jsonb)` exactly as in 0015 lines 17-80; `log_stock_movement(p_item_id, p_kind, p_qty_kg, p_unit_cost default null, p_note default '')` as it stands in 0016 lines 44-102 (the final fix-wave form with the vendor-filtered `for update` and `detail` on over-stock); `top_items_between` and `stock_movements_between` as in 0016 lines 371-445.
- Produces: `assert_whole_qty(p_item_id uuid, p_qty numeric) returns void`; `top_items_between(...)` returns the 0016 columns plus `unit text`, ordered by revenue; `stock_movements_between(...)` returns the 0016 columns plus `unit text`.

- [ ] **Step 1: Failing tests** — `tests/item_units_functions.test.mjs`:

```js
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
  // Coconuts: 3 pieces for 90. Onion: 5 kg for 200. Revenue puts onion first even though
  // 5 < 3 would be false by quantity... make quantity favour coconuts: 10 pieces for 300 vs 5 kg for 200.
  const done = async (itemId, qty, price) => {
    const b = await recordingBill(w);
    await sql(`insert into bill_items (bill_id, vendor_id, item_id, qty_kg, unit_price, line_total) values ($1,$2,$3,$4,$5,$6)`,
      [b, w.a.vendorId, itemId, qty, price, qty * price]);
    await sql(`select issue_token($1)`, [b]);
    await sql(`select complete_bill($1)`, [b]);
  };
  await done(w.coconut, 10, 30);   // 300
  await done(w.onion, 5, 40);      // 200
  const now = Date.now();
  const { data, error } = await w.a.clients.admin.rpc("top_items_between", {
    p_from: new Date(now - 3600e3).toISOString(), p_to: new Date(now + 3600e3).toISOString() });
  assert(!error, error?.message);
  const ours = data.filter((r) => r.item_id === w.coconut || r.item_id === w.onion);
  assertEqual(ours[0].item_id, w.coconut, "300 of coconuts must outrank 200 of onion");
  assertEqual(ours[0].unit, "piece", "unit missing");
  assertEqual(Number(ours[0].total_qty_kg), 10, "quantity in pieces");
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
```

Fix the misleading comment in the ranking test before committing: it should read "Coconuts: 10 pieces for 300; onion: 5 kg for 200. By quantity onion's 5 < coconut's 10 either way, so also assert the unit and that ordering follows revenue when a later kg bill of 6 kg for 120 does not overtake." Then add that third bill (`await done(w.onion, 6, 20)` → onion revenue 320 total, quantity 11) and assert onion is now first with `total_revenue` 320 — that is the case where quantity and revenue disagree with the old ordering by kg (11 kg vs 10 pieces would also put onion first by quantity, so instead make the coconut bill 12 pieces for 360: coconut revenue 360 > onion 320 while onion quantity 11 < coconut 12; the discriminating case is: coconut 12 pcs/360 vs onion 11 kg/320 → revenue and quantity agree). Use this final fixture, which discriminates: **coconut 4 pieces at 100 = 400; onion 9 kg at 40 = 360.** By quantity onion (9) > coconut (4); by revenue coconut (400) > onion (360). Assert coconut first. Replace the two `done(...)` calls with `await done(w.coconut, 4, 100); await done(w.onion, 9, 40);` and the quantity assertion with `assertEqual(Number(ours[0].total_qty_kg), 4, ...)`. Delete the wrong inline comment.

Add `import "./item_units_functions.test.mjs";` to `tests/run.mjs`.

- [ ] **Step 2: Run** — fractional cases fail (accepted), unit columns missing, ordering by qty puts onion first.

- [ ] **Step 3: Append to 0018**

```sql
-- Whole-number guard shared by the two write paths. Invoker rights: it only reads items,
-- which RLS already scopes, and both callers are security definer anyway.
create function assert_whole_qty(p_item_id uuid, p_qty numeric) returns void
  language plpgsql stable as $$
declare v_unit text;
begin
  select unit into v_unit from items where id = p_item_id;
  if v_unit is not null and v_unit <> 'kg' and p_qty <> floor(p_qty) then
    raise exception 'quantity must be a whole number for this unit' using errcode = '22023';
  end if;
end $$;
```

Then `create or replace function replace_bill_lines(p_bill_id uuid, p_lines jsonb)`: copy the body from 0015 lines 17-80 verbatim and insert, immediately before `delete from bill_items where bill_id = p_bill_id;`:

```sql
  -- Whole numbers for piece/bunch/dozen items (0018). Checked before the delete so a
  -- refused basket leaves the existing lines untouched.
  perform assert_whole_qty(l.item_id, l.qty_kg)
    from jsonb_to_recordset(p_lines) as l(item_id uuid, qty_kg numeric);
```

Re-issue 0015's revoke/grant lines.

Then `create or replace function log_stock_movement(...)`: copy the body from 0016 lines 44-102 verbatim (the current file content, which includes the fix-wave changes) and insert, immediately after the `if not found or v_item.vendor_id <> current_vendor_id() then ... end if;` block:

```sql
  perform assert_whole_qty(v_item.id, v_qty);
```

Re-issue 0016's revoke/grant for it.

Then the two analytics functions, `drop function if exists` + `create function`, copying 0016's definitions and adding `unit`:

- `top_items_between`: add `unit text` to the return table after `name_mr`; select `i.unit` after `i.name_mr`; add `i.unit` to `group by`; change the `order by` to `sum(bi.line_total) desc, bi.item_id` and update the comment: ranking is by sales value because quantities in different units are not comparable.
- `stock_movements_between`: add `unit text` after `name_mr` in the return table and `i.unit` in the select.

Re-issue both functions' revoke/grant lines.

- [ ] **Step 4: Run** `npm test` — 219 + 6 = 225; `analytics.test.mjs`, `analytics_cost.test.mjs`, `stock_movements.test.mjs`, `replace_bill_lines.test.mjs` all still green.
- [ ] **Step 5: Commit** `feat: whole-number quantities for piece items; analytics ranked by revenue and unit-aware`.

---

### Task 3: `units.ts`, validation and the data layer

**Files:**
- Create: `web/src/units.ts`, `web/src/__tests__/units.test.ts`
- Modify: `web/src/billing.ts` (`Draft.unit`), `web/src/adminRules.ts`, `web/src/stockRules.ts`, `web/src/data.ts`, `web/src/admin.ts`, `web/src/history.ts`, `web/src/receipt.ts`, `web/src/stock.ts`
- Modify tests: `adminRules.test.ts`, `stockRules.test.ts`, `admin.test.ts`, `data.test.ts`, `receipt.test.ts`, `stock.test.ts`, `billing.test.ts` as needed for the new fields

**Interfaces (produced):**
```ts
// units.ts
export type Unit = "kg" | "piece" | "bunch" | "dozen";
export const UNITS: readonly Unit[] = ["kg", "piece", "bunch", "dozen"];
export function isUnit(v: unknown): v is Unit;
export function isWholeUnit(unit: Unit): boolean;            // unit !== "kg"
export type QtyReason = "empty" | "notANumber" | "notPositive" | "tooPrecise" | "notWhole";
export function validateQty(raw: string, unit: Unit): { ok: true; value: number } | { ok: false; reason: QtyReason };
export function qtyText(qty: number | string, unit: Unit, t: (k: string, o?: object) => string): string; // t(`unit.qty.${unit}`, { n: Number(qty) })
export function perUnit(unit: Unit, t: (k: string) => string): string;                                 // t(`unit.per.${unit}`)
```
- `validateQty("1.5","kg")` ok 1.5; `("1.5","piece")` → `notWhole`; `("3","piece")` ok 3; `("0","bunch")` → `notPositive`; `("","dozen")` → `empty`; `("2.0","piece")` → `notWhole` (digits only for whole units: regex `^\d+$`).
- `Draft` gains `unit: Unit`. `Item` (data.ts) gains `unit: Unit; low_stock_at: number` and `listItems` selects them. `AdminItem` gains `unit: Unit; low_stock_at: number; sold: boolean`; `ITEM_COLS` becomes `"id, name_en, name_hi, name_mr, price, stock_kg, is_active, last_cost, unit, low_stock_at, bill_items(count)"` and `listAllItems` maps each row to `sold: (row.bill_items?.[0]?.count ?? 0) > 0` and drops the embed. `ItemInput` gains `unit: Unit; low_stock_at: string`; `ItemValue` gains `unit: Unit; low_stock_at: number`; `validateItem` refuses a fractional `stock_kg` for a whole unit with key `items.badWholeStock`, and a bad threshold with `items.badLowAt`; `stockLevel(kg: number, lowAt: number)` uses `lowAt` and the `LOW_STOCK_KG` constant is deleted (grep for its two users and update them). `createItem`/`updateItem` send `unit` and `low_stock_at`. `validateMovement(input, unit)` refuses a fractional kg for a whole unit with `stock.badWhole`. `BillLine.items`, `ReceiptLine.items` gain `unit: Unit` (select `items(name_en, name_hi, name_mr, unit)`). `Movement`, `TopItem` gain `unit: Unit`.
- i18n `unit` block (all three files):

en:
```json
"unit": {
  "name": { "kg": "Kilogram", "piece": "Piece", "bunch": "Bunch", "dozen": "Dozen" },
  "qty": { "kg": "{{n}} kg", "piece": "{{n}} pcs", "bunch": "{{n}} bunches", "dozen": "{{n}} dozen" },
  "per": { "kg": "per kg", "piece": "per piece", "bunch": "per bunch", "dozen": "per dozen" },
  "field": { "kg": "Weight (kg)", "piece": "Pieces", "bunch": "Bunches", "dozen": "Dozens" },
  "label": "Sold by",
  "lowAt": "Low-stock warning below",
  "lockedNote": "The unit cannot change after the item has been sold.",
  "notWhole": "Whole numbers only for this unit."
}
```
hi:
```json
"unit": {
  "name": { "kg": "किलो", "piece": "नग", "bunch": "गुच्छा", "dozen": "दर्जन" },
  "qty": { "kg": "{{n}} किलो", "piece": "{{n}} नग", "bunch": "{{n}} गुच्छे", "dozen": "{{n}} दर्जन" },
  "per": { "kg": "प्रति किलो", "piece": "प्रति नग", "bunch": "प्रति गुच्छा", "dozen": "प्रति दर्जन" },
  "field": { "kg": "वज़न (किलो)", "piece": "नग", "bunch": "गुच्छे", "dozen": "दर्जन" },
  "label": "बिकता है",
  "lowAt": "इससे कम पर कम-स्टॉक चेतावनी",
  "lockedNote": "सामान बिक जाने के बाद इकाई नहीं बदली जा सकती।",
  "notWhole": "इस इकाई के लिए केवल पूर्ण संख्या।"
}
```
mr:
```json
"unit": {
  "name": { "kg": "किलो", "piece": "नग", "bunch": "जुडी", "dozen": "डझन" },
  "qty": { "kg": "{{n}} किलो", "piece": "{{n}} नग", "bunch": "{{n}} जुड्या", "dozen": "{{n}} डझन" },
  "per": { "kg": "प्रति किलो", "piece": "प्रति नग", "bunch": "प्रति जुडी", "dozen": "प्रति डझन" },
  "field": { "kg": "वजन (किलो)", "piece": "नग", "bunch": "जुड्या", "dozen": "डझन" },
  "label": "विक्री एकक",
  "lowAt": "यापेक्षा कमी झाल्यास कमी-साठा इशारा",
  "lockedNote": "वस्तू विकल्यानंतर एकक बदलता येत नाही.",
  "notWhole": "या एककासाठी फक्त पूर्ण संख्या."
}
```
Also add `items.badWholeStock` ("Stock must be a whole number for this unit." / hi "इस इकाई के लिए स्टॉक पूर्ण संख्या होना चाहिए।" / mr "या एककासाठी साठा पूर्ण संख्या असावा."), `items.badLowAt` ("Enter a threshold of 0 or more." / "0 या अधिक की सीमा दर्ज करें।" / "0 किंवा अधिक मर्यादा भरा."), `stock.badWhole` (same three strings as `unit.notWhole`), and `bill.badWeight.notWhole` (same).

- [ ] **Step 1: Failing tests** — write `units.test.ts` covering every `validateQty` case above, `qtyText` and `perUnit` with a fake `t` that returns the key plus JSON of options; extend `adminRules.test.ts` (fractional stock for piece → `items.badWholeStock`; kg fractional ok; negative `low_stock_at` → `items.badLowAt`; value carries `unit` and `low_stock_at`), `stockRules.test.ts` (`validateMovement(input, "piece")` with kg "2.5" → `stock.badWhole`), `admin.test.ts` (ITEM_COLS contains `unit`, `low_stock_at`, `bill_items(count)`; `sold` derived true when count 2, false when embed empty), `data.test.ts` (listItems selects unit and low_stock_at), `receipt.test.ts`/`history` usage (embed string contains `unit`).
- [ ] **Step 2: Run** — fail.
- [ ] **Step 3: Implement.** `validateQty` for kg delegates to `validateWeight`; for whole units: trim; `""` → empty; `!/^\d+$/` → `notWhole` if it matches `^\d+\.\d+$` else `notANumber`; `0` → `notPositive`.
- [ ] **Step 4: Run** `npm test` and `npm run build` in `web/` — green. Screens still compile because every added field is optional at the type boundary only where the plan says (do NOT make `unit` optional; fix the compile errors in screens minimally by threading the field, without changing labels yet — that is Tasks 4-6). If a screen test breaks only because a stub lacks `unit`/`low_stock_at`, add `unit: "kg", low_stock_at: 10` to the stub.
- [ ] **Step 5: Commit** `feat: unit model, validation and data layer for item units`.

---

### Task 4: Items admin screen

**Files:** `web/src/screens/Items.tsx`, `web/src/__tests__/Items.test.tsx`, i18n (reword `items.price` → "Price {{per}}", `items.stock` → "Stock ({{unit}})", `items.inStock` removed in favour of `unit.qty.*`; hi/mr equivalents "भाव {{per}}" / "{{per}} भाव", "स्टॉक ({{unit}})" / "साठा ({{unit}})").

**Interfaces:** consumes Task 3. Produces testids `item-unit` (select), `item-low_stock_at` (input), `item-unit-locked` (note).

- [ ] **Step 1: Failing tests** (extend the existing stubs with `unit`, `low_stock_at`, `sold`):
  - the form shows a unit select with four options defaulting to kg for a new item;
  - choosing `piece` changes the price label to "Price per piece" and the stock label to "Stock (Pieces)";
  - saving a piece item with stock "2.5" shows `items.badWholeStock` and does not call `createItem`;
  - saving sends `unit: "piece", low_stock_at: 5` to `createItem`;
  - editing an item with `sold: true` renders the select disabled plus `item-unit-locked`;
  - a list row for `{ unit: "dozen", stock_kg: 4, low_stock_at: 6 }` shows "4 dozen" and the low colour; a kg row at 12.5 with threshold 10 is not low.
- [ ] **Step 2: Run** — fail.
- [ ] **Step 3: Implement.** `BLANK` gains `unit: "kg", low_stock_at: "10"`. Replace the `FIELDS` loop's price/stock entries with labels computed from `editing.input.unit` via `perUnit` and `t("unit.field.<unit>")`; add the select before price and the threshold input after stock. `toInput` copies `unit` and `String(low_stock_at)`. `stockLevel(it.stock_kg, it.low_stock_at)` in the list; quantity via `qtyText`.
- [ ] **Step 4: Run** — green, build clean.
- [ ] **Step 5: Commit** `feat: items admin chooses a unit and a low-stock threshold`.

---

### Task 5: Bill screen — unit-aware quantity entry and basket

**Files:** `web/src/screens/bill/ItemGrid.tsx`, `web/src/screens/bill/Basket.tsx`, `web/src/__tests__/Bill.test.tsx`, i18n (`bill.weightKg` replaced by `unit.field.*`; `bill.qtyLine` and `bill.stock` replaced by `unit.qty.*`; `bill.stock` → "{{qty}} in stock" with `qty` = `qtyText`).

**Interfaces:** consumes `validateQty`, `qtyText`, `isWholeUnit`, `Item.unit`, `Item.low_stock_at`, `Draft.unit`. Produces testids: `weight-input` stays for kg; `qty-input`, `qty-minus`, `qty-plus` for whole units.

- [ ] **Step 1: Failing tests** (Bill.test.tsx item stubs gain `unit`, `low_stock_at`):
  - a kg item shows `weight-input` labelled "Weight (kg)"; a piece item shows `qty-input` labelled "Pieces" with − and + that step by 1 and never below 1;
  - typing "1.5" for a piece item shows `bill.badWeight.notWhole` and adds nothing;
  - adding 3 pieces at ₹30 shows "3 pcs × ₹30.00" and ₹90.00 in the basket;
  - the option text and detail use `qtyText` ("12.5 kg in stock" / "4 pcs in stock");
  - low colouring on the detail uses the item's `low_stock_at` (a kg item at 12 with threshold 15 is amber).
- [ ] **Step 2: Run** — fail.
- [ ] **Step 3: Implement.** `stockClass(qty, lowAt)`; `stockText` via `qtyText`; branch the input on `isWholeUnit(selected.unit)`; `onAdd` includes `unit: selected.unit`; Basket uses `qtyText(l.qtyKg, l.unit, t)`.
- [ ] **Step 4: Run** — green, build clean.
- [ ] **Step 5: Commit** `feat: bill screen takes pieces, bunches and dozens as whole numbers`.

---

### Task 6: Completed, Receipt, Stock and Dashboards labels

**Files:** `web/src/screens/Completed.tsx`, `Receipt.tsx`, `Stock.tsx`, `Dashboards.tsx`; their tests; i18n (`completed.qtyLine` removed; `dash.kg` removed; `dash.topItemsSub` → en "By sales value. Shows quantity · sales · margin.", hi "बिक्री मूल्य के हिसाब से; मात्रा · बिक्री · मार्जिन दिखाता है।", mr "विक्री मूल्यानुसार; प्रमाण · विक्री · मार्जिन दाखवते."; `stock.kg` → "Quantity ({{unit}})", `stock.cost` → "Cost {{per}} (₹)", `stock.overStock` → "That is more than the {{qty}} in stock."; hi/mr equivalents).

- [ ] **Step 1: Failing tests:** Completed line "3 pcs"; Receipt line `3 pcs x 30.00` for a piece line and `1.5 kg x 40.00` for kg; Stock screen labels follow the chosen item's unit, the over-stock message quotes "7 pcs", the movements list shows "+3 pcs" and "/piece" on cost; Dashboards top row shows "4 pcs · ₹400.00 · margin".
- [ ] **Step 2: Run** — fail.
- [ ] **Step 3: Implement.** Stock.tsx: `validateMovement(input, chosen.unit)`; `signedKg` in `stockRules.ts` becomes `signedQty(kind, qty, unit, t)` using `qtyText`; problem `kg` field becomes `qty` text. Receipt: `${qtyText(l.qty_kg, l.items?.unit ?? "kg", t)} x ${...}`. Dashboards: `qtyText(i.total_qty_kg, i.unit, t)`.
- [ ] **Step 4: Run** — green, build clean; grep `web/src` (excluding tests and i18n) for the literal `" kg"` / `kg in stock` and confirm none remain outside `units.ts`.
- [ ] **Step 5: Commit** `feat: every quantity on screen names the item's unit`.

---

### Task 7: README and full verification

- [ ] Run `npm test` (root), `npm test` and `npm run build` in `web/`; record real counts.
- [ ] README: case count; "eighteen migrations"; Covered bullet:

```markdown
- **Item units.** Every item sells in one of kg, piece, bunch or dozen, with a per-item
  low-stock threshold that `v_low_stock` honours. Non-kg quantities must be whole numbers,
  enforced by the `items` trigger, `replace_bill_lines` and `log_stock_movement`; the unit is
  locked once the item has been sold. `top_items_between` ranks by sales value and returns
  the unit. Existing items default to kg with threshold 10, so nothing changes until an
  admin edits an item.
```

- [ ] Commit `docs: record item-unit coverage`.

## After the plan (owner)

Apply `0018_item_units.sql` on Cloud as one script on the vendor-app project (check `select jobname from cron.job` first), insert `('0018','item_units')` into `supabase_migrations.schema_migrations`, then merge and push.
