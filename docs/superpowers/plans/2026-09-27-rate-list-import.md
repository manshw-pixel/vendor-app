# Rate-List Photo Import Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An admin photographs the daily rate list; Gemini 2.5 Flash reads it; the app matches lines to items, converts "sold by" units, shows a review screen, applies price updates and new items in one transaction, and shows what changed.

**Architecture:** Migration `0026_rate_list_import.sql` adds `item_aliases`, `price_changes` and the `apply_price_list` RPC (reusing `create_item_with_cost`). Edge Function `read-rate-list` (wiring in `index.ts`, testable logic in `guards.ts`) calls Gemini with a JSON response schema. The web app adds pure modules `soldBy.ts` (unit rules) and `rateListMatch.ts` (matching/review model), an API module `rateListApi.ts`, and a screen `RateList.tsx` at `/items/rate-list`.

**Tech Stack:** Postgres/plpgsql (DB suite `npm test` at repo root, native Postgres), Deno Edge Function (no local Deno runtime — logic tested through the web vitest suite, as the other functions do), React + vitest (`cd web && npx vitest run`, `npx tsc --noEmit`), i18next en/hi/mr.

**Spec:** `docs/superpowers/specs/2026-09-27-rate-list-import-design.md`

## Global Constraints

- Migration file: `supabase/migrations/0026_rate_list_import.sql`. Function dir: `supabase/functions/read-rate-list/`.
- Gemini: endpoint `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`; model from env `GEMINI_MODEL`, default `gemini-2.5-flash`; key from env `GEMINI_API_KEY`, sent only in header `x-goog-api-key`.
- New items: cost = price, stock 30, low_stock_at 10, in the item's unit.
- Units: `kg`, `piece`, `bunch`, `dozen` only.
- Sold-by rules (spec table): 12 pc/dozen → dozen; box/packet/pc/piece → piece; N grams → kg with price × 1000 ÷ N (2 dp); bunch/जुडी/गड्डी → bunch; anything else → kg as written.
- `apply_price_list` admin of `current_vendor_id()` only (42501), invalid row → 22023 and nothing applied.
- Images: ≤ 5 per request, media types `image/jpeg`, `image/png`, `image/webp`, base64 ≤ 2,000,000 chars each. Never stored.
- Every user-visible string in en/hi/mr (`web/src/i18n/*.json`; top-level objects are pretty-printed one key per line, some nested objects are single long lines — keep valid JSON).
- Commit trailer: `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Run `npx tsc --noEmit` in `web/` before each web commit.

## Review Focus

- "1 kg" / "1kg" must NOT be parsed as grams (the `g` in `kg`) — test in Task 2.
- A row matched to an item via the Hindi or Marathi name as written (not English) — test in Task 3.
- The same item listed twice on the page (two photos overlapping) — last wins, earlier marked duplicate — test in Task 3.
- Gemini returns markdown-fenced JSON or an empty/blocked candidate — must map to `read_failed`, not crash — test in Task 4.
- Apply with a row for another shop's item id — whole apply refused, nothing changed — test in Task 1.

---

### Task 1: Database — aliases, price log, `apply_price_list`

**Files:**
- Create: `supabase/migrations/0026_rate_list_import.sql`
- Create: `tests/rate_list_import.test.mjs`
- Modify: `tests/run.mjs` (add `import "./rate_list_import.test.mjs";` after `import "./delete_pending_bill.test.mjs";`)

**Interfaces:**
- Produces: table `item_aliases(vendor_id, item_id, alias)`; table `price_changes`; RPC `apply_price_list(p_rows jsonb) returns jsonb` with rows `{kind:"update", item_id, price, alias?}` | `{kind:"create", names:{name_en,name_hi,name_mr}, unit, price, alias?}`, returning `{updated:[{item_id,name_en,name_hi,name_mr,unit,old_price,new_price}], created:[{item_id,name_en,name_hi,name_mr,unit,price}], unchanged:int}`.

- [ ] **Step 1: Write the failing tests** — `tests/rate_list_import.test.mjs`

```js
import { test, assert, assertDenied, assertEqual, once } from "./framework.mjs";
import { sql } from "./fixtures.mjs";
import { seedTwoVendors } from "./seed.mjs";

const getWorld = once(seedTwoVendors);

async function item(v, { name = "RL Tomato", price = 40, unit = "kg" } = {}) {
  const { rows: [i] } = await sql(
    `insert into items (vendor_id, name_en, name_hi, name_mr, price, stock_kg, unit, last_cost)
     values ($1,$2,'टमाटर','टोमॅटो',$3,50,$4,20) returning id`, [v.vendorId, name, price, unit]);
  return i.id;
}
const priceOf = async (id) => Number((await sql(`select price from items where id=$1`, [id])).rows[0].price);
const apply = (client, rows) => client.rpc("apply_price_list", { p_rows: rows });

test("an admin updates prices; changes are logged and returned", async () => {
  const w = await getWorld();
  const a = await item(w.a, { name: "RL Onion A", price: 40 });
  const b = await item(w.a, { name: "RL Onion B", price: 30 });
  const { data, error } = await apply(w.a.clients.admin, [
    { kind: "update", item_id: a, price: 44 },
    { kind: "update", item_id: b, price: 30 },
  ]);
  assert(!error, error?.message);
  assertEqual(await priceOf(a), 44, "a repriced");
  assertEqual(data.updated.length, 1, "one updated");
  assertEqual(Number(data.updated[0].old_price), 40, "old price");
  assertEqual(Number(data.updated[0].new_price), 44, "new price");
  assertEqual(data.unchanged, 1, "one unchanged");
  const { rows } = await sql(`select old_price::float8 o, new_price::float8 n, source, changed_by from price_changes where item_id=$1`, [a]);
  assertEqual(rows.length, 1, "logged once");
  assertEqual(rows[0].source, "rate_list", "source");
  assertEqual(rows[0].changed_by, w.a.adminId, "changed_by");
  assertEqual((await sql(`select count(*)::int n from price_changes where item_id=$1`, [b])).rows[0].n, 0, "unchanged not logged");
});

test("a new item is created with cost = price, stock 30 and low stock 10", async () => {
  const w = await getWorld();
  const { data, error } = await apply(w.a.clients.admin, [{
    kind: "create", names: { name_en: "RL Kiwi", name_hi: "कीवी", name_mr: "किवी" },
    unit: "piece", price: 25, alias: "Kiwi (imported)",
  }]);
  assert(!error, error?.message);
  const id = data.created[0].item_id;
  const { rows: [i] } = await sql(
    `select price::float8 p, last_cost::float8 c, stock_kg::float8 s, low_stock_at::float8 l, unit from items where id=$1`, [id]);
  assertEqual(i.p, 25, "price"); assertEqual(i.c, 25, "cost = price");
  assertEqual(i.s, 30, "stock 30"); assertEqual(i.l, 10, "low 10"); assertEqual(i.unit, "piece", "unit");
  const { rows: al } = await sql(`select item_id from item_aliases where vendor_id=$1 and lower(alias)=lower('kiwi (IMPORTED)')`, [w.a.vendorId]);
  assertEqual(al[0].item_id, id, "alias saved");
});

test("an alias is saved on update and re-pointed if reused", async () => {
  const w = await getWorld();
  const a = await item(w.a, { name: "RL Brinjal A" });
  const b = await item(w.a, { name: "RL Brinjal B" });
  await apply(w.a.clients.admin, [{ kind: "update", item_id: a, price: 41, alias: "Baingan" }]);
  await apply(w.a.clients.admin, [{ kind: "update", item_id: b, price: 41, alias: "baingan" }]);
  const { rows } = await sql(`select item_id from item_aliases where vendor_id=$1 and lower(alias)='baingan'`, [w.a.vendorId]);
  assertEqual(rows.length, 1, "one alias row");
  assertEqual(rows[0].item_id, b, "re-pointed");
});

test("staff can read their shop's aliases, not another shop's", async () => {
  const w = await getWorld();
  const b = await item(w.b, { name: "RL Other" });
  await sql(`insert into item_aliases (vendor_id, item_id, alias) values ($1,$2,'RL other alias')`, [w.b.vendorId, b]);
  const { data } = await w.a.clients.recorder.from("item_aliases").select("alias");
  assert(!(data ?? []).some((r) => r.alias === "RL other alias"), "saw another shop's alias");
});

test("a pending bill is repriced through the 0025 trigger", async () => {
  const w = await getWorld();
  const a = await item(w.a, { name: "RL Pending", price: 40 });
  const { rows: [bill] } = await sql(
    `insert into bills (vendor_id, customer_id, recorder_id, total, status) values ($1,$2,$3,0,'recording') returning id`,
    [w.a.vendorId, w.a.customerId, w.a.recorderId]);
  await sql(`insert into bill_items (bill_id, vendor_id, item_id, qty_kg, unit_price, line_total) values ($1,$2,$3,2,40,80)`,
    [bill.id, w.a.vendorId, a]);
  await sql(`select issue_token($1)`, [bill.id]);
  await apply(w.a.clients.admin, [{ kind: "update", item_id: a, price: 50 }]);
  assertEqual(Number((await sql(`select total from bills where id=$1`, [bill.id])).rows[0].total), 100, "bill total");
});

test("a biller or recorder may not apply", async () => {
  const w = await getWorld();
  const a = await item(w.a, { name: "RL Guard", price: 40 });
  assertDenied((await apply(w.a.clients.biller, [{ kind: "update", item_id: a, price: 1 }])).error, "biller applied");
  assertDenied((await apply(w.a.clients.recorder, [{ kind: "update", item_id: a, price: 1 }])).error, "recorder applied");
  assertEqual(await priceOf(a), 40, "price changed");
});

test("another shop's item id refuses the whole list", async () => {
  const w = await getWorld();
  const mine = await item(w.a, { name: "RL Mine", price: 40 });
  const theirs = await item(w.b, { name: "RL Theirs", price: 40 });
  const { error } = await apply(w.a.clients.admin, [
    { kind: "update", item_id: mine, price: 45 },
    { kind: "update", item_id: theirs, price: 45 },
  ]);
  assertDenied(error, "cross-shop update");
  assertEqual(await priceOf(mine), 40, "partial apply");
  assertEqual(await priceOf(theirs), 40, "other shop changed");
});

test("an invalid row (zero price, missing name, bad unit) rolls back everything", async () => {
  const w = await getWorld();
  const a = await item(w.a, { name: "RL Rollback", price: 40 });
  for (const bad of [
    { kind: "update", item_id: a, price: 0 },
    { kind: "create", names: { name_en: "RL X", name_hi: "", name_mr: "एक्स" }, unit: "kg", price: 10 },
    { kind: "create", names: { name_en: "RL Y", name_hi: "वाई", name_mr: "वाय" }, unit: "box", price: 10 },
    { kind: "delete", item_id: a },
  ]) {
    const { error } = await apply(w.a.clients.admin, [{ kind: "update", item_id: a, price: 41 }, bad]);
    assertDenied(error, `accepted ${JSON.stringify(bad)}`);
    assertEqual(await priceOf(a), 40, "partial apply");
  }
  assertEqual((await sql(`select count(*)::int n from items where name_en in ('RL X','RL Y')`)).rows[0].n, 0, "item created");
});
```

- [ ] **Step 2: Run to verify fail** — `npm test` (repo root). Expected: the new tests FAIL (`function apply_price_list does not exist` / relation missing).

- [ ] **Step 3: Implement** — `supabase/migrations/0026_rate_list_import.sql`

```sql
-- Updating prices from a rate-list photo.
-- Spec: docs/superpowers/specs/2026-09-27-rate-list-import-design.md
--
-- The photo is read by the read-rate-list Edge Function and reviewed in the app; nothing
-- reaches the database until the admin taps Apply, which is this file's one RPC.

-- Names the shop's rate list uses for an item, learned whenever a list line is linked to
-- or creates an item. Unique per shop ignoring case: one name points at one item.
create table item_aliases (
  id         uuid primary key default gen_random_uuid(),
  vendor_id  uuid not null references vendors(id) on delete cascade,
  item_id    uuid not null references items(id) on delete cascade,
  alias      text not null check (length(btrim(alias)) > 0),
  created_at timestamptz not null default now()
);
create unique index item_aliases_vendor_alias_idx on item_aliases (vendor_id, lower(alias));

alter table item_aliases enable row level security;
-- Read by the shop's staff (the review screen matches against it). Written only by
-- apply_price_list, which is security definer, so there is no write policy.
create policy item_aliases_read on item_aliases for select
  using (vendor_id = current_vendor_id());

-- Who changed which price, from what, when. Only the rate list writes here for now.
create table price_changes (
  id         uuid primary key default gen_random_uuid(),
  vendor_id  uuid not null references vendors(id) on delete cascade,
  item_id    uuid not null references items(id) on delete cascade,
  old_price  numeric(10,2) not null,
  new_price  numeric(10,2) not null,
  source     text not null check (source in ('rate_list')),
  changed_by uuid references app_users(id),
  changed_at timestamptz not null default now()
);
create index price_changes_item_idx on price_changes (item_id, changed_at);

alter table price_changes enable row level security;
create policy price_changes_admin_read on price_changes for select
  using (vendor_id = current_vendor_id() and current_user_role() = 'admin');

create function apply_price_list(p_rows jsonb) returns jsonb
  language plpgsql security definer set search_path = public as $$
declare
  r           jsonb;
  v_item      items%rowtype;
  v_price     numeric;
  v_alias     text;
  v_updated   jsonb := '[]'::jsonb;
  v_created   jsonb := '[]'::jsonb;
  v_unchanged integer := 0;
begin
  if current_vendor_id() is null or current_user_role() <> 'admin' then
    raise exception 'only an admin may apply a price list' using errcode = '42501';
  end if;
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' then
    raise exception 'rows must be an array' using errcode = '22023';
  end if;

  -- One transaction: any bad row raises and nothing above it survives.
  for r in select value from jsonb_array_elements(p_rows) loop
    v_price := round((r->>'price')::numeric, 2);
    if v_price is null or v_price <= 0 then
      raise exception 'a price must be more than zero' using errcode = '22023';
    end if;
    v_alias := nullif(btrim(coalesce(r->>'alias', '')), '');

    if r->>'kind' = 'update' then
      select * into v_item from items
       where id = (r->>'item_id')::uuid and vendor_id = current_vendor_id()
         for update;
      if not found then
        raise exception 'item % is not in your shop', r->>'item_id' using errcode = '42501';
      end if;
      if v_item.price <> v_price then
        -- The 0025 trigger reprices pending bills from here.
        update items set price = v_price where id = v_item.id;
        insert into price_changes (vendor_id, item_id, old_price, new_price, source, changed_by)
        values (v_item.vendor_id, v_item.id, v_item.price, v_price, 'rate_list', auth.uid());
        v_updated := v_updated || jsonb_build_object(
          'item_id', v_item.id, 'name_en', v_item.name_en, 'name_hi', v_item.name_hi,
          'name_mr', v_item.name_mr, 'unit', v_item.unit,
          'old_price', v_item.price, 'new_price', v_price);
      else
        v_unchanged := v_unchanged + 1;
      end if;

    elsif r->>'kind' = 'create' then
      if length(btrim(coalesce(r->'names'->>'name_en', ''))) = 0
         or length(btrim(coalesce(r->'names'->>'name_hi', ''))) = 0
         or length(btrim(coalesce(r->'names'->>'name_mr', ''))) = 0 then
        raise exception 'a new item needs all three names' using errcode = '22023';
      end if;
      -- Owner decision: cost = price, stock 30, low stock 10, in the item's unit.
      -- create_item_with_cost checks the unit and logs the opening stock.
      v_item := create_item_with_cost(
        jsonb_build_object('name_en', btrim(r->'names'->>'name_en'),
                           'name_hi', btrim(r->'names'->>'name_hi'),
                           'name_mr', btrim(r->'names'->>'name_mr')),
        v_price, 30, r->>'unit', 10, v_price);
      v_created := v_created || jsonb_build_object(
        'item_id', v_item.id, 'name_en', v_item.name_en, 'name_hi', v_item.name_hi,
        'name_mr', v_item.name_mr, 'unit', v_item.unit, 'price', v_item.price);

    else
      raise exception 'unknown row kind %', r->>'kind' using errcode = '22023';
    end if;

    if v_alias is not null then
      insert into item_aliases (vendor_id, item_id, alias)
      values (current_vendor_id(), v_item.id, v_alias)
      on conflict (vendor_id, lower(alias)) do update set item_id = excluded.item_id;
    end if;
  end loop;

  return jsonb_build_object('updated', v_updated, 'created', v_created, 'unchanged', v_unchanged);
end $$;

revoke all on function apply_price_list(jsonb) from public, anon;
grant execute on function apply_price_list(jsonb) to authenticated;
```

- [ ] **Step 4: Run to verify pass** — `npm test`. Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/0026_rate_list_import.sql tests/rate_list_import.test.mjs tests/run.mjs
git commit -m "feat(db): item aliases, price log and apply_price_list (0026)"
```

---

### Task 2: Sold-by normaliser (`web/src/soldBy.ts`)

**Files:**
- Create: `web/src/soldBy.ts`
- Create: `web/src/__tests__/soldBy.test.ts`

**Interfaces:**
- Produces: `export type SoldBy = { unit: Unit; price: number; grams: number | null }` and `export function normaliseSoldBy(soldBy: string, price: number): SoldBy` (`grams` set only when a gram conversion happened, for the review note).

- [ ] **Step 1: Failing test** — `web/src/__tests__/soldBy.test.ts`

```ts
import { describe, it, expect } from "vitest";
import { normaliseSoldBy } from "../soldBy";

describe("normaliseSoldBy", () => {
  it.each([
    ["12 pc", "dozen"], ["12pcs", "dozen"], ["Dozen", "dozen"], ["1 dz", "dozen"], ["दर्जन", "dozen"], ["डझन", "dozen"],
    ["1 box", "piece"], ["packet", "piece"], ["1 pkt", "piece"], ["1 pc", "piece"], ["piece", "piece"], ["नग", "piece"],
    ["bunch", "bunch"], ["1 जुडी", "bunch"], ["गड्डी", "bunch"],
    ["1 kg", "kg"], ["1kg", "kg"], ["kilo", "kg"], ["", "kg"], ["per bag", "kg"],
  ])("%s → %s, price unchanged", (soldBy, unit) => {
    const r = normaliseSoldBy(soldBy, 20);
    expect(r.unit).toBe(unit);
    expect(r.price).toBe(20);
    expect(r.grams).toBeNull();
  });

  it.each([
    ["250 g", 20, 80], ["250gm", 20, 80], ["500 gms", 30, 60], ["100 grams", 12, 120], ["250 ग्राम", 20, 80], ["333 g", 10, 30.03],
  ])("%s at ₹%d → ₹%d per kg", (soldBy, price, perKg) => {
    const r = normaliseSoldBy(soldBy, price);
    expect(r.unit).toBe("kg");
    expect(r.price).toBe(perKg);
    expect(r.grams).not.toBeNull();
  });

  it("does not read the g in kg as grams", () => {
    expect(normaliseSoldBy("2 kg", 50)).toEqual({ unit: "kg", price: 50, grams: null });
  });

  it("does not treat 12 inside a larger number as a dozen", () => {
    expect(normaliseSoldBy("120 pc", 5).unit).toBe("piece");
  });
});
```

- [ ] **Step 2: Run** — `cd web && npx vitest run src/__tests__/soldBy.test.ts` → FAIL (module missing).

- [ ] **Step 3: Implement** — `web/src/soldBy.ts`

```ts
import type { Unit } from "./units";

export type SoldBy = { unit: Unit; price: number; grams: number | null };

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * The owner's "sold by" rules for a rate-list line. Run here, not in the model's prompt,
 * so they are the same every day and tested. Order matters: grams before the kg default,
 * a dozen before the generic piece words (a dozen is written "12 pc").
 */
export function normaliseSoldBy(soldBy: string, price: number): SoldBy {
  const s = soldBy.normalize("NFC").toLowerCase().trim();

  // "250 g", "250gm", "500 gms", "100 grams", "250 ग्राम" -- but never the g of "kg".
  const g = /(?:^|[^\d.])(\d+(?:\.\d+)?)\s*(?:g|gm|gms|gram|grams|ग्राम)(?![a-z])/.exec(` ${s}`);
  if (g && !/\d\s*kg/.test(s)) {
    const grams = Number(g[1]);
    if (grams > 0) return { unit: "kg", price: round2((price * 1000) / grams), grams };
  }
  if (/(?:^|[^\d])12\s*(?:pc|pcs|piece|pieces|nos)\b|dozen|\bdz\b|दर्जन|डझन/.test(s)) {
    return { unit: "dozen", price, grams: null };
  }
  if (/bunch|जुडी|गड्डी|judi/.test(s)) return { unit: "bunch", price, grams: null };
  if (/box|packet|\bpkt\b|\bpack\b|\bpcs?\b|piece|\bnos\b|नग/.test(s)) {
    return { unit: "piece", price, grams: null };
  }
  return { unit: "kg", price, grams: null };
}
```

- [ ] **Step 4: Run** — same command → PASS. If a case fails, fix the regex, not the test.

- [ ] **Step 5: Commit** — `git add web/src/soldBy.ts web/src/__tests__/soldBy.test.ts && git commit -m "feat(web): sold-by unit rules for rate lists"`

---

### Task 3: Matcher and review model (`web/src/rateListMatch.ts`)

**Files:**
- Create: `web/src/rateListMatch.ts`
- Create: `web/src/__tests__/rateListMatch.test.ts`

**Interfaces:**
- Consumes: `normaliseSoldBy` (Task 2).
- Produces:

```ts
export type ExtractedRow = {
  name_as_written: string; sold_by_as_written: string; price: number;
  name_en: string; name_hi: string; name_mr: string; confidence: "high" | "low";
};
export type MatchItem = { id: string; name_en: string; name_hi: string; name_mr: string; price: number; unit: Unit };
export type Alias = { alias: string; item_id: string };
export type ReviewRow =
  | { key: number; kind: "update"; row: ExtractedRow; item: MatchItem; price: string; grams: number | null; include: boolean; changed: boolean }
  | { key: number; kind: "mismatch"; row: ExtractedRow; item: MatchItem; listUnit: Unit; price: string; include: boolean }
  | { key: number; kind: "new"; row: ExtractedRow; names: { name_en: string; name_hi: string; name_mr: string }; unit: Unit; price: string; grams: number | null; suggestion: MatchItem | null; include: boolean }
  | { key: number; kind: "duplicate"; row: ExtractedRow; item: MatchItem };
export function buildReview(rows: ExtractedRow[], items: MatchItem[], aliases: Alias[]): ReviewRow[];
export function linkRow(r: ReviewRow & { kind: "new" }, item: MatchItem): ReviewRow;
export function rowError(r: ReviewRow): string | null; // i18n key or null
export type ApplyRow =
  | { kind: "update"; item_id: string; price: number; alias?: string }
  | { kind: "create"; names: { name_en: string; name_hi: string; name_mr: string }; unit: Unit; price: number; alias?: string };
export function toApplyRows(review: ReviewRow[]): ApplyRow[];
```

`price` in review rows is a string because it is bound to an input.

- [ ] **Step 1: Failing tests** — `web/src/__tests__/rateListMatch.test.ts`

```ts
import { describe, it, expect } from "vitest";
import { buildReview, linkRow, rowError, toApplyRows, type ExtractedRow, type MatchItem } from "../rateListMatch";

const items: MatchItem[] = [
  { id: "onion", name_en: "Onion", name_hi: "प्याज", name_mr: "कांदा", price: 40, unit: "kg" },
  { id: "banana", name_en: "Banana", name_hi: "केला", name_mr: "केळी", price: 60, unit: "dozen" },
  { id: "tomato", name_en: "Tomato", name_hi: "टमाटर", name_mr: "टोमॅटो", price: 30, unit: "kg" },
];
const row = (o: Partial<ExtractedRow>): ExtractedRow => ({
  name_as_written: "", sold_by_as_written: "", price: 0, name_en: "", name_hi: "", name_mr: "", confidence: "high", ...o,
});

describe("buildReview", () => {
  it("matches by English name ignoring case and spaces, and marks a changed price", () => {
    const [r] = buildReview([row({ name_as_written: "  ONION ", price: 44 })], items, []);
    expect(r.kind).toBe("update");
    if (r.kind !== "update") return;
    expect(r.item.id).toBe("onion"); expect(r.price).toBe("44"); expect(r.changed).toBe(true); expect(r.include).toBe(true);
  });

  it("matches by the Hindi or Marathi name as written", () => {
    const rs = buildReview([row({ name_as_written: "प्याज", price: 40 }), row({ name_as_written: "केळी", sold_by_as_written: "12 pc", price: 60 })], items, []);
    expect(rs.map((r) => r.kind)).toEqual(["update", "update"]);
  });

  it("marks an unchanged price not changed", () => {
    const [r] = buildReview([row({ name_as_written: "Onion", price: 40 })], items, []);
    expect(r.kind === "update" && r.changed).toBe(false);
  });

  it("matches through a saved alias, then through the model's English name", () => {
    const rs = buildReview([
      row({ name_as_written: "Kanda Nashik", price: 41 }),
      row({ name_as_written: "Tamatar", name_en: "Tomato", price: 32 }),
    ], items, [{ alias: "kanda nashik", item_id: "onion" }]);
    expect(rs.map((r) => (r.kind === "update" ? r.item.id : r.kind))).toEqual(["onion", "tomato"]);
  });

  it("converts grams to per kg for an existing kg item", () => {
    const [r] = buildReview([row({ name_as_written: "Onion", sold_by_as_written: "250 g", price: 11 })], items, []);
    expect(r.kind === "update" && r.price).toBe("44");
    expect(r.kind === "update" && r.grams).toBe(250);
  });

  it("flags a unit mismatch on an existing item and leaves it unticked", () => {
    const [r] = buildReview([row({ name_as_written: "Banana", sold_by_as_written: "1 pc", price: 6 })], items, []);
    expect(r.kind).toBe("mismatch");
    if (r.kind !== "mismatch") return;
    expect(r.listUnit).toBe("piece"); expect(r.include).toBe(false); expect(r.price).toBe("");
  });

  it("proposes an unknown line as a new item with the model's names and the rule's unit", () => {
    const [r] = buildReview([row({ name_as_written: "Kiwi", sold_by_as_written: "1 box", price: 120, name_en: "Kiwi", name_hi: "कीवी", name_mr: "किवी" })], items, []);
    expect(r.kind).toBe("new");
    if (r.kind !== "new") return;
    expect(r.unit).toBe("piece"); expect(r.price).toBe("120"); expect(r.include).toBe(true);
    expect(r.names).toEqual({ name_en: "Kiwi", name_hi: "कीवी", name_mr: "किवी" }); expect(r.suggestion).toBeNull();
  });

  it("suggests a close existing item for a new line", () => {
    const [r] = buildReview([row({ name_as_written: "Tomatoes", name_en: "Tomatoes", price: 30 })], items, []);
    expect(r.kind === "new" && r.suggestion?.id).toBe("tomato");
  });

  it("keeps the last line for an item listed twice and marks the earlier a duplicate", () => {
    const rs = buildReview([row({ name_as_written: "Onion", price: 41 }), row({ name_as_written: "onion", price: 43 })], items, []);
    expect(rs[0].kind).toBe("duplicate");
    expect(rs[1].kind === "update" && rs[1].price).toBe("43");
  });
});

describe("linkRow, rowError and toApplyRows", () => {
  it("linking a new row to an item makes it an update carrying the written name as alias", () => {
    const [r] = buildReview([row({ name_as_written: "Tamatar Desi", price: 35 })], items, []);
    if (r.kind !== "new") throw new Error("expected new");
    const linked = linkRow(r, items[2]);
    expect(linked.kind).toBe("update");
    expect(toApplyRows([linked])).toEqual([{ kind: "update", item_id: "tomato", price: 35, alias: "Tamatar Desi" }]);
  });

  it("linking to an item of another unit gives a mismatch", () => {
    const [r] = buildReview([row({ name_as_written: "Kela", sold_by_as_written: "1 pc", price: 6 })], items, []);
    if (r.kind !== "new") throw new Error("expected new");
    expect(linkRow(r, items[1]).kind).toBe("mismatch");
  });

  it("sends only ticked, changed or new rows; no alias when the written name is an item name", () => {
    const rs = buildReview([
      row({ name_as_written: "Onion", price: 44 }),
      row({ name_as_written: "Tomato", price: 30 }),
      row({ name_as_written: "Kiwi", name_en: "Kiwi", name_hi: "कीवी", name_mr: "किवी", price: 120 }),
    ], items, []);
    expect(toApplyRows(rs)).toEqual([
      { kind: "update", item_id: "onion", price: 44 },
      { kind: "create", names: { name_en: "Kiwi", name_hi: "कीवी", name_mr: "किवी" }, unit: "kg", price: 120, alias: "Kiwi" },
    ]);
  });

  it("reports invalid ticked rows", () => {
    const [r] = buildReview([row({ name_as_written: "Kiwi", name_en: "Kiwi", name_hi: "", name_mr: "किवी", price: 120 })], items, []);
    expect(rowError(r)).toBe("rateList.needNames");
    expect(rowError({ ...r, include: false })).toBeNull();
    const [u] = buildReview([row({ name_as_written: "Onion", price: 44 })], items, []);
    expect(rowError({ ...u, price: "0" } as typeof u)).toBe("rateList.badPrice");
  });
});
```

- [ ] **Step 2: Run** — `npx vitest run src/__tests__/rateListMatch.test.ts` → FAIL.

- [ ] **Step 3: Implement** — `web/src/rateListMatch.ts`

```ts
import type { Unit } from "./units";
import { normaliseSoldBy } from "./soldBy";

// (types exactly as in the Interfaces block above)

const norm = (s: string) => s.normalize("NFC").toLowerCase().replace(/\s+/g, " ").trim();

function lookupTable(items: MatchItem[], aliases: Alias[]): Map<string, MatchItem> {
  const byId = new Map(items.map((i) => [i.id, i]));
  const table = new Map<string, MatchItem>();
  for (const i of items) for (const n of [i.name_en, i.name_hi, i.name_mr]) if (norm(n)) table.set(norm(n), i);
  for (const a of aliases) {
    const i = byId.get(a.item_id);
    if (i && !table.has(norm(a.alias))) table.set(norm(a.alias), i);
  }
  return table;
}

function levenshtein(a: string, b: string): number {
  const d = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let prev = d[0]; d[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = d[j];
      d[j] = Math.min(d[j] + 1, d[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return d[b.length];
}

function closest(row: ExtractedRow, items: MatchItem[]): MatchItem | null {
  const names = [row.name_as_written, row.name_en].map(norm).filter((n) => n.length >= 3);
  for (const i of items) {
    const en = norm(i.name_en);
    if (en.length < 3) continue;
    if (names.some((n) => n.includes(en) || en.includes(n) || levenshtein(n, en) <= 2)) return i;
  }
  return null;
}

const priceText = (n: number) => String(Math.round(n * 100) / 100);

function asUpdateOrMismatch(key: number, row: ExtractedRow, item: MatchItem): ReviewRow {
  const sb = normaliseSoldBy(row.sold_by_as_written, row.price);
  if (sb.unit !== item.unit) {
    return { key, kind: "mismatch", row, item, listUnit: sb.unit, price: "", include: false };
  }
  return { key, kind: "update", row, item, price: priceText(sb.price), grams: sb.grams,
    include: true, changed: Math.abs(sb.price - item.price) >= 0.005 };
}

export function buildReview(rows: ExtractedRow[], items: MatchItem[], aliases: Alias[]): ReviewRow[] {
  const table = lookupTable(items, aliases);
  const matched = rows.map((row) =>
    [row.name_as_written, row.name_en, row.name_hi, row.name_mr]
      .map((n) => table.get(norm(n))).find((i) => i !== undefined) ?? null);
  const lastIndex = new Map<string, number>();
  matched.forEach((i, idx) => { if (i) lastIndex.set(i.id, idx); });

  return rows.map((row, key) => {
    const item = matched[key];
    if (item && lastIndex.get(item.id) !== key) return { key, kind: "duplicate", row, item };
    if (item) return asUpdateOrMismatch(key, row, item);
    const sb = normaliseSoldBy(row.sold_by_as_written, row.price);
    return { key, kind: "new", row,
      names: { name_en: row.name_en.trim() || row.name_as_written.trim(), name_hi: row.name_hi.trim(), name_mr: row.name_mr.trim() },
      unit: sb.unit, price: priceText(sb.price), grams: sb.grams, suggestion: closest(row, items), include: true };
  });
}

export function linkRow(r: ReviewRow & { kind: "new" }, item: MatchItem): ReviewRow {
  return asUpdateOrMismatch(r.key, r.row, item);
}

const validPrice = (p: string) => { const n = Number(p); return p.trim() !== "" && Number.isFinite(n) && n > 0; };

export function rowError(r: ReviewRow): string | null {
  if (r.kind === "duplicate" || !r.include) return null;
  if (!validPrice(r.price)) return "rateList.badPrice";
  if (r.kind === "new" && [r.names.name_en, r.names.name_hi, r.names.name_mr].some((n) => n.trim() === "")) {
    return "rateList.needNames";
  }
  return null;
}

function aliasFor(row: ExtractedRow, item: MatchItem | null): string | undefined {
  const written = row.name_as_written.trim();
  if (!written) return undefined;
  if (item && [item.name_en, item.name_hi, item.name_mr].some((n) => norm(n) === norm(written))) return undefined;
  return written;
}

export function toApplyRows(review: ReviewRow[]): ApplyRow[] {
  const out: ApplyRow[] = [];
  for (const r of review) {
    if (r.kind === "duplicate" || !r.include) continue;
    const price = Number(r.price);
    if (r.kind === "new") {
      const alias = aliasFor(r.row, null);
      out.push({ kind: "create", names: { ...r.names }, unit: r.unit, price, ...(alias ? { alias } : {}) });
      continue;
    }
    if (Math.abs(price - r.item.price) < 0.005) continue;
    const alias = aliasFor(r.row, r.item);
    out.push({ kind: "update", item_id: r.item.id, price, ...(alias ? { alias } : {}) });
  }
  return out;
}
```

Note: an "update" row whose price equals the current price is not sent (no-op), so it counts as unchanged on the result screen via the client, not the RPC.

- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** — `git add web/src/rateListMatch.ts web/src/__tests__/rateListMatch.test.ts && git commit -m "feat(web): match rate-list lines to items"`

---

### Task 4: Edge Function `read-rate-list`

**Files:**
- Create: `supabase/functions/read-rate-list/guards.ts`
- Create: `supabase/functions/read-rate-list/index.ts`
- Modify: `supabase/config.toml` (add `[functions.read-rate-list]` / `verify_jwt = true` with a one-line comment, next to the other function blocks)
- Create: `web/src/__tests__/readRateListGuards.test.ts`

**Interfaces:**
- Produces (guards.ts, pure, no Deno APIs):
  - `export type ErrorCode = "not_admin" | "bad_request" | "read_failed" | "not_configured";`
  - `export type RateImage = { media_type: "image/jpeg" | "image/png" | "image/webp"; data: string };`
  - `export const MAX_IMAGES = 5; export const MAX_IMAGE_CHARS = 2_000_000; export const DEFAULT_MODEL = "gemini-2.5-flash";`
  - `export function validateReadRequest(body: unknown): { ok: true; images: RateImage[] } | { ok: false; code: "bad_request" }`
  - `export function geminiRequest(images: RateImage[]): unknown` (the JSON body)
  - `export function geminiUrl(model: string): string`
  - `export function parseGeminiResponse(json: unknown): { ok: true; rows: ExtractedRow[] } | { ok: false; code: "read_failed" }` — `ExtractedRow` defined in guards.ts with the same shape as Task 3's (web imports its type from `rateListMatch.ts`; keep both identical).
- HTTP contract: `POST {images}` → `200 {rows: ExtractedRow[]}`; errors `{error: ErrorCode}` with 401/403 not_admin, 400 bad_request, 502 read_failed, 500 not_configured.

- [ ] **Step 1: Failing tests** — `web/src/__tests__/readRateListGuards.test.ts`

```ts
import { describe, it, expect } from "vitest";
import {
  validateReadRequest, geminiRequest, geminiUrl, parseGeminiResponse, MAX_IMAGES, DEFAULT_MODEL,
} from "../../../supabase/functions/read-rate-list/guards";

const img = { media_type: "image/jpeg", data: "QUJD" };

describe("validateReadRequest", () => {
  it("accepts 1..5 jpeg/png/webp images", () => {
    expect(validateReadRequest({ images: [img] }).ok).toBe(true);
    expect(validateReadRequest({ images: Array(MAX_IMAGES).fill(img) }).ok).toBe(true);
  });
  it.each([
    [{}], [{ images: [] }], [{ images: Array(MAX_IMAGES + 1).fill(img) }],
    [{ images: [{ media_type: "image/gif", data: "QUJD" }] }], [{ images: [{ media_type: "image/jpeg", data: "" }] }],
    [{ images: [{ media_type: "image/jpeg", data: "x".repeat(2_000_001) }] }], [null],
  ])("refuses %j", (body) => {
    expect(validateReadRequest(body)).toEqual({ ok: false, code: "bad_request" });
  });
});

describe("geminiRequest / geminiUrl", () => {
  it("asks for JSON with a schema and inlines every image", () => {
    const body = geminiRequest([img, img]) as {
      contents: { parts: Array<{ text?: string; inline_data?: { mime_type: string; data: string } }> }[];
      generationConfig: { responseMimeType: string; responseSchema: unknown; temperature: number };
    };
    const parts = body.contents[0].parts;
    expect(parts.filter((p) => p.inline_data).length).toBe(2);
    expect(parts[0].text).toMatch(/rate list/i);
    expect(body.generationConfig.responseMimeType).toBe("application/json");
    expect(body.generationConfig.temperature).toBe(0);
    expect(JSON.stringify(body.generationConfig.responseSchema)).toContain("sold_by_as_written");
  });
  it("puts the model in the path and no key in the URL", () => {
    expect(geminiUrl(DEFAULT_MODEL)).toBe(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent");
  });
});

const reply = (text: string) => ({ candidates: [{ content: { parts: [{ text }] } }] });
const good = { name_as_written: "Onion", sold_by_as_written: "1 kg", price: 40, name_en: "Onion", name_hi: "प्याज", name_mr: "कांदा", confidence: "high" };

describe("parseGeminiResponse", () => {
  it("returns rows from the JSON text", () => {
    expect(parseGeminiResponse(reply(JSON.stringify([good])))).toEqual({ ok: true, rows: [good] });
  });
  it("tolerates a markdown fence", () => {
    expect(parseGeminiResponse(reply("```json\n" + JSON.stringify([good]) + "\n```")).ok).toBe(true);
  });
  it("drops rows with no name or a non-positive price, and coerces a numeric-string price", () => {
    const r = parseGeminiResponse(reply(JSON.stringify([
      good, { ...good, name_as_written: " " }, { ...good, price: 0 }, { ...good, price: "35" },
    ])));
    expect(r.ok && r.rows.map((x) => x.price)).toEqual([40, 35]);
  });
  it("defaults missing optional strings and an unknown confidence to low", () => {
    const r = parseGeminiResponse(reply(JSON.stringify([{ name_as_written: "Kiwi", price: 10 }])));
    expect(r.ok && r.rows[0]).toEqual({ name_as_written: "Kiwi", sold_by_as_written: "", price: 10, name_en: "", name_hi: "", name_mr: "", confidence: "low" });
  });
  it("returns an empty list for []", () => {
    expect(parseGeminiResponse(reply("[]"))).toEqual({ ok: true, rows: [] });
  });
  it.each([[{}], [{ candidates: [] }], [reply("not json")], [reply("{\"a\":1}")], [null]])("fails on %j", (j) => {
    expect(parseGeminiResponse(j)).toEqual({ ok: false, code: "read_failed" });
  });
});
```

- [ ] **Step 2: Run** → FAIL (module missing).

- [ ] **Step 3: Implement** — `supabase/functions/read-rate-list/guards.ts`

```ts
// Pure logic for read-rate-list. No Deno or network APIs here, so the web vitest suite can
// import and test it -- there is no Deno runtime locally (see admin-create-user).

export type ErrorCode = "not_admin" | "bad_request" | "read_failed" | "not_configured";
export type RateImage = { media_type: "image/jpeg" | "image/png" | "image/webp"; data: string };
export type ExtractedRow = {
  name_as_written: string; sold_by_as_written: string; price: number;
  name_en: string; name_hi: string; name_mr: string; confidence: "high" | "low";
};

export const MAX_IMAGES = 5;
export const MAX_IMAGE_CHARS = 2_000_000;
export const DEFAULT_MODEL = "gemini-2.5-flash";
const TYPES = ["image/jpeg", "image/png", "image/webp"];

export function validateReadRequest(body: unknown):
  { ok: true; images: RateImage[] } | { ok: false; code: "bad_request" } {
  const bad = { ok: false as const, code: "bad_request" as const };
  const images = (body as { images?: unknown } | null)?.images;
  if (!Array.isArray(images) || images.length < 1 || images.length > MAX_IMAGES) return bad;
  for (const i of images) {
    const m = i as { media_type?: unknown; data?: unknown };
    if (typeof m?.media_type !== "string" || !TYPES.includes(m.media_type)) return bad;
    if (typeof m.data !== "string" || m.data.length === 0 || m.data.length > MAX_IMAGE_CHARS) return bad;
  }
  return { ok: true, images: images as RateImage[] };
}

const PROMPT = `You are reading a vegetable and fruit vendor's daily rate list (printed, handwritten, a board, or a phone screenshot; English, Hindi or Marathi).
Return one entry per item line. For each:
- name_as_written: the item name exactly as written.
- sold_by_as_written: the quantity/unit the price is for, exactly as written (e.g. "1 kg", "250 g", "12 pc", "1 box", "bunch"), or "" if none is written.
- price: the price as a number exactly as written, with no conversion.
- name_en, name_hi, name_mr: the item's common name in English, Hindi (Devanagari) and Marathi (Devanagari).
- confidence: "low" if any part was hard to read, else "high".
Skip headings, dates, totals and anything that is not an item with a price.`;

const SCHEMA = {
  type: "ARRAY",
  items: {
    type: "OBJECT",
    properties: {
      name_as_written: { type: "STRING" }, sold_by_as_written: { type: "STRING" }, price: { type: "NUMBER" },
      name_en: { type: "STRING" }, name_hi: { type: "STRING" }, name_mr: { type: "STRING" },
      confidence: { type: "STRING", enum: ["high", "low"] },
    },
    required: ["name_as_written", "sold_by_as_written", "price", "name_en", "name_hi", "name_mr", "confidence"],
  },
};

export function geminiRequest(images: RateImage[]): unknown {
  return {
    contents: [{ parts: [{ text: PROMPT }, ...images.map((i) => ({ inline_data: { mime_type: i.media_type, data: i.data } }))] }],
    generationConfig: { responseMimeType: "application/json", responseSchema: SCHEMA, temperature: 0 },
  };
}

export function geminiUrl(model: string): string {
  return `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
}

const str = (v: unknown) => (typeof v === "string" ? v : "");

export function parseGeminiResponse(json: unknown):
  { ok: true; rows: ExtractedRow[] } | { ok: false; code: "read_failed" } {
  const fail = { ok: false as const, code: "read_failed" as const };
  const text = (json as { candidates?: { content?: { parts?: { text?: unknown }[] } }[] } | null)
    ?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (typeof text !== "string") return fail;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.replace(/^\s*```(?:json)?\s*/i, "").replace(/\s*```\s*$/, ""));
  } catch {
    return fail;
  }
  if (!Array.isArray(parsed)) return fail;
  const rows: ExtractedRow[] = [];
  for (const p of parsed) {
    const o = (p ?? {}) as Record<string, unknown>;
    const price = typeof o.price === "number" ? o.price : Number(o.price);
    const name = str(o.name_as_written).trim();
    if (!name || !Number.isFinite(price) || price <= 0) continue;
    rows.push({
      name_as_written: name, sold_by_as_written: str(o.sold_by_as_written), price,
      name_en: str(o.name_en), name_hi: str(o.name_hi), name_mr: str(o.name_mr),
      confidence: o.confidence === "high" ? "high" : "low",
    });
  }
  return { ok: true, rows };
}
```

- [ ] **Step 4: Run** → PASS.

- [ ] **Step 5: Write `index.ts`** (wiring; not unit-tested — follow `supabase/functions/admin-create-user/index.ts`'s shape: CORS block, `fail()`, OPTIONS 204, POST only, caller client from the Authorization header, `getUser()`, then an `app_users` read `select("vendor_id, role, vendors(suspended_at)")` under the caller's JWT; refuse unless `role === "admin"` and the vendor is not suspended — copy the suspended check from admin-create-user exactly).

```ts
// Reads a rate-list photo with Gemini and returns the lines. Writes nothing: the admin
// reviews the result in the app and apply_price_list is the only write.
//
// Needs no service role -- every read below runs under the caller's JWT.
// Untestable locally (no Deno runtime); logic lives in ./guards.ts, tested by the web suite.
import { createClient } from "jsr:@supabase/supabase-js@2";
import {
  validateReadRequest, geminiRequest, geminiUrl, parseGeminiResponse, DEFAULT_MODEL, type ErrorCode,
} from "./guards.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const ANON = Deno.env.get("SUPABASE_ANON_KEY")!;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status: number) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...CORS } });
const fail = (code: ErrorCode, status: number) => json({ error: code }, status);

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (req.method !== "POST") return fail("bad_request", 405);

  const key = Deno.env.get("GEMINI_API_KEY");
  if (!key) return fail("not_configured", 500);

  const auth = req.headers.get("Authorization");
  if (!auth) return fail("not_admin", 401);

  let body: unknown;
  try { body = await req.json(); } catch { return fail("bad_request", 400); }
  const check = validateReadRequest(body);
  if (!check.ok) return fail(check.code, 400);

  const caller = createClient(SUPABASE_URL, ANON, {
    global: { headers: { Authorization: auth } }, auth: { persistSession: false },
  });
  const { data: who, error: whoError } = await caller.auth.getUser();
  if (whoError || !who?.user) return fail("not_admin", 401);
  const { data: me, error: meError } = await caller
    .from("app_users").select("vendor_id, role, vendors(suspended_at)").eq("id", who.user.id).maybeSingle();
  if (meError || !me || me.role !== "admin") return fail("not_admin", 403);
  // <copy admin-create-user's suspended-shop check here verbatim, returning fail("not_admin", 403)>

  const model = Deno.env.get("GEMINI_MODEL") || DEFAULT_MODEL;
  let res: Response;
  try {
    res = await fetch(geminiUrl(model), {
      method: "POST",
      // The key travels in a header, never the URL, so it cannot land in a request log.
      headers: { "Content-Type": "application/json", "x-goog-api-key": key },
      body: JSON.stringify(geminiRequest(check.images)),
      signal: AbortSignal.timeout(60_000),
    });
  } catch {
    return fail("read_failed", 502);
  }
  if (!res.ok) return fail("read_failed", 502);
  const parsed = parseGeminiResponse(await res.json().catch(() => null));
  if (!parsed.ok) return fail("read_failed", 502);
  return json({ rows: parsed.rows }, 200);
});
```

The `<copy ...>` line is an instruction to the implementer: open `supabase/functions/admin-create-user/index.ts`, find the block right after the role check that tests `vendors.suspended_at`, and reproduce it here with `fail("not_admin", 403)`. There must be no placeholder comment left in the committed file.

Add to `supabase/config.toml` beside the other function entries:

```toml
# Reads a rate-list photo with Gemini for an admin. verify_jwt proves a signed-in user;
# the function's own app_users read under the caller's JWT is the admin check.
[functions.read-rate-list]
verify_jwt = true
```

- [ ] **Step 6: Run** — `cd web && npx vitest run && npx tsc --noEmit` → green.
- [ ] **Step 7: Commit** — `git add supabase/functions/read-rate-list supabase/config.toml web/src/__tests__/readRateListGuards.test.ts && git commit -m "feat(fn): read-rate-list Edge Function (Gemini)"`

---

### Task 5: API module (`web/src/rateListApi.ts`)

**Files:**
- Create: `web/src/rateListApi.ts`
- Create: `web/src/__tests__/rateListApi.test.ts`

**Interfaces:**
- Consumes: `codeFrom` (`web/src/functionErrors.ts`), `supabase` (`web/src/supabase.ts`), `ErrorCode`/`RateImage` from the function's guards, `ExtractedRow`/`ApplyRow`/`Alias` from Task 3.
- Produces:
  - `readRateList(images: RateImage[]): Promise<{ rows: ExtractedRow[] | null; error: { key: string; detail: string } | null }>`
  - `listAliases(): Promise<{ data: Alias[] | null; error: unknown }>` — `supabase.from("item_aliases").select("alias, item_id")`
  - `applyPriceList(rows: ApplyRow[]): Promise<{ data: ApplyResult | null; error: unknown }>` — `supabase.rpc("apply_price_list", { p_rows: rows })`
  - `export type ApplyResult = { updated: { item_id: string; name_en: string; name_hi: string; name_mr: string; unit: Unit; old_price: number; new_price: number }[]; created: { item_id: string; name_en: string; name_hi: string; name_mr: string; unit: Unit; price: number }[]; unchanged: number }`
  - `downscale(file: File, maxSide = 1600): Promise<RateImage>` — draws onto a canvas, `toDataURL("image/jpeg", 0.8)`, strips the `data:...;base64,` prefix.

KEYS map: `{ not_admin: "error.notAllowed", bad_request: "error.unknown", read_failed: "rateList.readFailed", not_configured: "rateList.notConfigured" }`.

- [ ] **Step 1: Failing tests** — mock `../supabase` (`vi.mock("../supabase", () => ({ supabase: { functions: { invoke }, from, rpc } }))`) and assert: `readRateList` calls `invoke("read-rate-list", { body: { images } })` and returns `data.rows`; an error with a `Response` context `{error:"read_failed"}` maps to key `rateList.readFailed`; `applyPriceList` calls `rpc("apply_price_list", { p_rows: rows })`; `listAliases` selects `"alias, item_id"` from `item_aliases`. (`downscale` is not unit-tested: jsdom has no canvas — the screen test mocks it.)

```ts
import { describe, it, expect, vi } from "vitest";

const invoke = vi.fn();
const rpc = vi.fn(async () => ({ data: { updated: [], created: [], unchanged: 0 }, error: null }));
const select = vi.fn(async () => ({ data: [{ alias: "kanda", item_id: "i1" }], error: null }));
const from = vi.fn(() => ({ select }));
vi.mock("../supabase", () => ({ supabase: { functions: { invoke: (...a: unknown[]) => invoke(...a) }, rpc: (...a: unknown[]) => rpc(...a), from: (...a: unknown[]) => from(...a) } }));

const api = await import("../rateListApi");
const images = [{ media_type: "image/jpeg" as const, data: "QUJD" }];

describe("rateListApi", () => {
  it("reads rows through the Edge Function", async () => {
    invoke.mockResolvedValueOnce({ data: { rows: [{ name_as_written: "Onion" }] }, error: null });
    const r = await api.readRateList(images);
    expect(invoke).toHaveBeenCalledWith("read-rate-list", { body: { images } });
    expect(r.rows?.[0].name_as_written).toBe("Onion");
    expect(r.error).toBeNull();
  });
  it("maps a read failure to its message key", async () => {
    invoke.mockResolvedValueOnce({ data: null, error: { message: "x", context: new Response(JSON.stringify({ error: "read_failed" }), { status: 502 }) } });
    const r = await api.readRateList(images);
    expect(r.rows).toBeNull();
    expect(r.error?.key).toBe("rateList.readFailed");
  });
  it("applies through the RPC", async () => {
    await api.applyPriceList([{ kind: "update", item_id: "i1", price: 44 }]);
    expect(rpc).toHaveBeenCalledWith("apply_price_list", { p_rows: [{ kind: "update", item_id: "i1", price: 44 }] });
  });
  it("lists aliases", async () => {
    const r = await api.listAliases();
    expect(from).toHaveBeenCalledWith("item_aliases");
    expect(select).toHaveBeenCalledWith("alias, item_id");
    expect(r.data?.[0].alias).toBe("kanda");
  });
});
```

- [ ] **Step 2: Run** → FAIL. **Step 3: Implement** the module per the Interfaces block (short doc comment at the top, like `adminApi.ts`). **Step 4: Run** → PASS; `npx tsc --noEmit`.
- [ ] **Step 5: Commit** — `git add web/src/rateListApi.ts web/src/__tests__/rateListApi.test.ts && git commit -m "feat(web): rate-list API calls"`

---

### Task 6: Screen `RateList.tsx`, route, Items button, i18n

**Files:**
- Create: `web/src/screens/RateList.tsx`
- Create: `web/src/__tests__/RateList.test.tsx`
- Modify: `web/src/App.tsx` (add `<Route path="/items/rate-list" element={<RateList />} />` next to `/items`, plus the lazy/normal import matching how `Items` is imported)
- Modify: `web/src/screens/Items.tsx` (a `<Link to="/items/rate-list" data-testid="items-rate-list">` styled like the Add item button, next to it)
- Modify: `web/src/i18n/en.json`, `hi.json`, `mr.json` (new top-level `"rateList"` object, pretty-printed one key per line, inserted after the `"items"` object)

**Interfaces:**
- Consumes: Tasks 2, 3, 5; `listAllItems` from `web/src/admin.ts` (returns `AdminItem[]`, map to `MatchItem` with `price: Number(it.price)`); `itemName`, `perUnit`, `rupees`, `describeError`, `useSession`.

**Screen states** (`step: "pick" | "reading" | "review" | "applying" | "done"`):

1. **pick** — `<input type="file" accept="image/*" multiple data-testid="rate-list-file">` (max 5; more → show `rateList.tooMany`, keep first 5) and a "Read prices" button `data-testid="rate-list-read"`. Errors from a previous attempt render here.
2. **reading** — text `rateList.reading`. Runs: `downscale` each file → `readRateList(images)`; in parallel `listAllItems()` and `listAliases()`. On success → `buildReview(rows, items, aliases)` → review. Zero rows → back to pick with `rateList.noRows`. Error → back to pick with the error key.
3. **review** — header counts: changed, new, needs attention (mismatch + low confidence + invalid). A `Show unchanged ({{n}})` toggle (`data-testid="rate-list-show-unchanged"`) reveals update rows with `changed === false`. Each row `data-testid={`rate-row-${key}`}` shows `name_as_written` and `sold_by_as_written`, a low-confidence badge (`rateList.lowConfidence`) when `row.confidence === "low"`, an include checkbox (`rate-include-${key}`) except for duplicates, and by kind:
   - update: `item name — ₹old → [price input rate-price-${key}] / perUnit`; when `grams` → note `rateList.converted` `{{grams}} g ₹{{listPrice}} → ₹{{price}}/kg`.
   - mismatch: warning `rateList.mismatch` `{{listUnit}}`/`{{unit}}` + empty price input; typing a valid price ticks include.
   - new: badge `rateList.newItem`; three name inputs (`rate-name-en-${key}` etc.), a unit `<select>` (`rate-unit-${key}`, UNITS), price input; if `suggestion` → button `rate-suggest-${key}` "`rateList.didYouMean` {{name}}" which calls `linkRow(r, suggestion)`; a "Link to item" `<select>` (`rate-link-${key}`) of all items that calls `linkRow` on change.
   - duplicate: muted text `rateList.duplicate`.
   - Any `rowError(r)` → red text under the row with `t(key)`.
   - Apply button `rate-apply` disabled when `toApplyRows(review).length === 0` or any row has a `rowError`.
4. **applying** — `applyPriceList(toApplyRows(review))`. Error → stay on review, show `describeError(error)`. Success → done.
5. **done** — header `rateList.resultTitle` `{{changed}}`/`{{added}}`; list **Prices changed** (`rate-result-updated`) — item name (UI language via `itemName`), `₹old → ₹new / perUnit`, ▲ (text-red-700) if up, ▼ (text-emerald-700) if down; list **Items added** (`rate-result-created`) — name, `₹price / perUnit`, note `rateList.addedNote`; line `rateList.unchangedCount` {{n}} = RPC `unchanged` + client-side unchanged update rows; `rateList.skippedCount` {{n}} = rows not included (excluding duplicates) + duplicates. Buttons: **Done** (`<Link to="/items">`) and **Update another list** (resets to pick).

Admin-only: render `null` unless `session.kind === "ready" && session.role === "admin"`.

i18n `rateList` keys (en / hi / mr):

| key | en | hi | mr |
|---|---|---|---|
| open | Update prices from photo | फ़ोटो से दाम अपडेट करें | फोटोवरून दर अपडेट करा |
| title | Update prices from a rate list | रेट लिस्ट से दाम अपडेट करें | दरपत्रकावरून दर अपडेट करा |
| pick | Take or choose photos of today's rate list (up to 5). | आज की रेट लिस्ट की फ़ोटो लें या चुनें (5 तक)। | आजच्या दरपत्रकाचे फोटो घ्या किंवा निवडा (5 पर्यंत). |
| tooMany | Only the first 5 photos will be read. | केवल पहली 5 फ़ोटो पढ़ी जाएँगी। | फक्त पहिले 5 फोटो वाचले जातील. |
| read | Read prices | दाम पढ़ें | दर वाचा |
| reading | Reading the list… | लिस्ट पढ़ी जा रही है… | यादी वाचत आहे… |
| readFailed | The photo could not be read. Try a clearer photo. | फ़ोटो पढ़ी नहीं जा सकी। साफ़ फ़ोटो लें। | फोटो वाचता आला नाही. स्पष्ट फोटो घ्या. |
| notConfigured | Photo reading is not set up yet. | फ़ोटो पढ़ना अभी सेट नहीं है। | फोटो वाचणे अजून सेट केलेले नाही. |
| noRows | No prices found in this photo. | इस फ़ोटो में कोई दाम नहीं मिला। | या फोटोत एकही दर सापडला नाही. |
| summary | {{changed}} changed · {{added}} new · {{attention}} need a look | {{changed}} बदले · {{added}} नए · {{attention}} देखें | {{changed}} बदलले · {{added}} नवीन · {{attention}} तपासा |
| showUnchanged | Show unchanged ({{n}}) | बिना बदलाव वाले दिखाएँ ({{n}}) | न बदललेले दाखवा ({{n}}) |
| lowConfidence | Hard to read — check | पढ़ने में कठिन — जाँचें | वाचायला कठीण — तपासा |
| converted | {{grams}} g ₹{{listPrice}} → ₹{{price}}/kg | {{grams}} ग्राम ₹{{listPrice}} → ₹{{price}}/किलो | {{grams}} ग्रॅम ₹{{listPrice}} → ₹{{price}}/किलो |
| mismatch | List says {{listUnit}}, sold here by {{unit}} — enter the price per {{unit}} | लिस्ट में {{listUnit}}, यहाँ {{unit}} में बिकता है — प्रति {{unit}} दाम डालें | यादीत {{listUnit}}, इथे {{unit}} ने विकले जाते — प्रति {{unit}} दर टाका |
| newItem | New item | नया आइटम | नवीन वस्तू |
| didYouMean | Did you mean {{name}}? | क्या आपका मतलब {{name}} है? | तुम्हाला {{name}} म्हणायचे आहे का? |
| linkTo | Link to existing item | मौजूदा आइटम से जोड़ें | असलेल्या वस्तूशी जोडा |
| duplicate | Listed again below — ignored | नीचे फिर से है — छोड़ा गया | खाली पुन्हा आहे — वगळले |
| include | Include | शामिल करें | समाविष्ट करा |
| badPrice | Enter a price above zero. | शून्य से ज़्यादा दाम डालें। | शून्यापेक्षा जास्त दर टाका. |
| needNames | A new item needs all three names. | नए आइटम के तीनों नाम चाहिए। | नवीन वस्तूला तिन्ही नावे हवीत. |
| apply | Apply | लागू करें | लागू करा |
| applying | Saving… | सेव हो रहा है… | जतन करत आहे… |
| resultTitle | {{changed}} prices changed · {{added}} items added | {{changed}} दाम बदले · {{added}} आइटम जोड़े | {{changed}} दर बदलले · {{added}} वस्तू जोडल्या |
| pricesChanged | Prices changed | बदले गए दाम | बदललेले दर |
| itemsAdded | Items added | जोड़े गए आइटम | जोडलेल्या वस्तू |
| addedNote | stock 30 · cost = price | स्टॉक 30 · लागत = दाम | साठा 30 · खर्च = दर |
| unchangedCount | {{n}} unchanged | {{n}} बिना बदलाव | {{n}} न बदललेले |
| skippedCount | {{n}} skipped | {{n}} छोड़े गए | {{n}} वगळले |
| done | Done | हो गया | झाले |
| another | Update another list | दूसरी लिस्ट अपडेट करें | दुसरी यादी अपडेट करा |

- [ ] **Step 1: Failing tests** — `web/src/__tests__/RateList.test.tsx`. Mock `../rateListApi` (`readRateList`, `listAliases`, `applyPriceList`, `downscale: async () => ({ media_type: "image/jpeg", data: "QUJD" })`), `../admin` (`listAllItems` returning Onion kg ₹40 and Banana dozen ₹60), and `../components/SessionProvider` (admin). Render inside `MemoryRouter`. Helper `readWith(rows)`: sets `readRateList` to resolve `{ rows, error: null }`, fires `change` on `rate-list-file` with `{ target: { files: [new File(["x"], "a.jpg", { type: "image/jpeg" })] } }`, clicks `rate-list-read`, awaits `rate-row-0`. Tests:
  1. a changed price shows old → new and Apply sends `[{ kind: "update", item_id: "onion", price: 44 }]` (row `Onion` price 44);
  2. a new line shows the three prefilled names and Apply sends a `create` row with `unit: "piece"` for `sold_by "1 box"`;
  3. clearing a new row's Hindi name disables Apply and shows the needNames text;
  4. a unit mismatch (Banana `1 pc`) is unticked; typing a price ticks it;
  5. zero rows returns to pick with the noRows text;
  6. after Apply, the result screen lists the RPC's `updated` (₹40 → ₹44) and `created` names, and "Update another list" returns to the file picker;
  7. a biller renders nothing.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** the screen per the states above, i18n keys, route, and Items link. Follow Pending.tsx/Items.tsx styling (Tailwind slate, `min-h-[44px]`, rounded-lg/xl).
- [ ] **Step 4: Run** — `npx vitest run && npx tsc --noEmit` → green.
- [ ] **Step 5: Commit** — `git add web/src/screens/RateList.tsx web/src/__tests__/RateList.test.tsx web/src/App.tsx web/src/screens/Items.tsx web/src/i18n/*.json && git commit -m "feat(web): update prices from a rate-list photo"`

---

### Task 7: README + full verification

- [ ] **Step 1:** README: a short section in the existing per-feature style — what the feature does, owner rules (cost = price, stock 30 / low 10, sold-by table), and setup: `supabase secrets set GEMINI_API_KEY=...` (optionally `GEMINI_MODEL`), deploy `read-rate-list`, hand-apply 0026 + tracking row.
- [ ] **Step 2:** `npm test` (root), `cd web && npx vitest run && npm run build` → all green.
- [ ] **Step 3:** Commit — `git add README.md && git commit -m "docs: rate-list photo import"`

Rollout (owner, not implementation): set `GEMINI_API_KEY` secret → deploy the function (`SUPABASE_ACCESS_TOKEN=... npx supabase functions deploy read-rate-list`, per the CLI-401 memory) → hand-apply 0026 + tracking row → one real run on 2–3 sample images → merge.
