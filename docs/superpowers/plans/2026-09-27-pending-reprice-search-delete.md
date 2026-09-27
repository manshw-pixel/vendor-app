# Pending Reprice, Item Search, Delete Pending Token — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Item price changes reprice pending bills; billing gets an item search box; admin/biller can delete a pending bill and roll back its token when it was the latest.

**Architecture:** One migration `0025_pending_reprice_and_delete.sql` adds an `AFTER UPDATE OF price` trigger on `items` and a `delete_pending_bill` security-definer RPC. The web app adds a pure `filterItems` helper used by `ItemGrid`, a `deletePendingBill` wrapper in `data.ts`, and a Delete button + confirm on `Pending.tsx`.

**Tech Stack:** PostgreSQL/Supabase (plpgsql), node test runner `tests/run.mjs` against native Postgres (`npm test` at repo root), React + Vite + vitest (`npm test` in `web/`), i18next (en/hi/mr JSON).

**Spec:** `docs/superpowers/specs/2026-09-27-pending-reprice-search-delete-design.md`

## Global Constraints

- Migration filename: `supabase/migrations/0025_pending_reprice_and_delete.sql`.
- Pending statuses are exactly `recording` and `billed`. Never touch `done` or `voided` bills.
- Token rollback only when deleted `token_no = vendor_counters.last_token`; new value = `coalesce(max(token_no) of the shop's remaining bills, 0)`.
- `delete_pending_bill` allowed for roles `admin` and `biller` only, same shop only; errcode `42501` for refusals, `22023` for wrong status.
- Reprice overwrites every pending line of the item, including hand-edited prices.
- Every new user-visible string gets keys in `web/src/i18n/en.json`, `hi.json`, `mr.json`.
- Commit trailer: `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Run `npx tsc --noEmit` in `web/` before each web commit (CI's Linux tsc is stricter — see memory).

## Review Focus

- Deleting the latest token twice in a row: counter must end at the highest surviving token, not `last - 2` blindly — test in Task 2.
- Deleting a bill whose token is older while a newer one exists: counter unchanged, next token is `last+1` — test in Task 2.
- Price edit on an item that also appears in a done bill: the done bill's lines and total unchanged — test in Task 1.
- Search typed in a different script/case than the UI language (e.g. English query while UI is Hindi): still matches — test in Task 3.
- Selected item filtered out by search: selection stays usable (Add still works) — test in Task 3.

---

### Task 1: Reprice trigger (migration part 1)

**Files:**
- Create: `supabase/migrations/0025_pending_reprice_and_delete.sql`
- Create: `tests/pending_reprice.test.mjs`
- Modify: `tests/run.mjs` (add import after `./offline_billing.test.mjs`)

**Interfaces:**
- Produces: trigger `items_reprice_pending` on `items`; function `reprice_pending_lines()`.

- [ ] **Step 1: Write the failing test** — `tests/pending_reprice.test.mjs`

```js
import { test, assert, assertEqual, once } from "./framework.mjs";
import { sql } from "./fixtures.mjs";
import { seedTwoVendors } from "./seed.mjs";

const getWorld = once(seedTwoVendors);

async function newItem(v, price = 40) {
  const { rows: [i] } = await sql(
    `insert into items (vendor_id, name_en, price, stock_kg, last_cost)
     values ($1,'Reprice Tomato',$2,100,20) returning id`, [v.vendorId, price]);
  return i.id;
}
// A bill with one line of `itemId`; issued (billed) unless status='recording'; completed if 'done'.
async function billWith(v, itemId, { qty = 2, price = 40, status = "billed" } = {}) {
  const { rows: [b] } = await sql(
    `insert into bills (vendor_id, customer_id, recorder_id, total, status)
     values ($1,$2,$3,0,'recording') returning id`, [v.vendorId, v.customerId, v.recorderId]);
  await sql(`insert into bill_items (bill_id, vendor_id, item_id, qty_kg, unit_price, line_total)
             values ($1,$2,$3,$4,$5,$6)`, [b.id, v.vendorId, itemId, qty, price, qty * price]);
  if (status !== "recording") await sql(`select issue_token($1)`, [b.id]);
  if (status === "done") await sql(`select complete_bill($1, null, 0, 'cash')`, [b.id]);
  return b.id;
}
const line = async (billId) => (await sql(
  `select unit_price::float8 p, line_total::float8 t from bill_items where bill_id=$1`, [billId])).rows[0];
const total = async (billId) => Number((await sql(`select total from bills where id=$1`, [billId])).rows[0].total);
const setPrice = (itemId, p) => sql(`update items set price=$2 where id=$1`, [itemId, p]);

test("a price change reprices billed lines and the bill total", async () => {
  const w = await getWorld();
  const item = await newItem(w.a);
  const b = await billWith(w.a, item, { qty: 2.5, price: 40 });
  await setPrice(item, 50);
  assertEqual((await line(b)).p, 50, "unit_price");
  assertEqual((await line(b)).t, 125, "line_total");
  assertEqual(await total(b), 125, "bill total");
});

test("a price change reprices a recording bill's lines", async () => {
  const w = await getWorld();
  const item = await newItem(w.a);
  const b = await billWith(w.a, item, { status: "recording" });
  await setPrice(item, 45);
  assertEqual((await line(b)).p, 45, "unit_price");
  assertEqual((await line(b)).t, 90, "line_total");
});

test("hand-edited prices are overwritten too", async () => {
  const w = await getWorld();
  const item = await newItem(w.a);
  const b = await billWith(w.a, item, { price: 33 });
  await setPrice(item, 60);
  assertEqual((await line(b)).p, 60, "unit_price");
});

test("done and voided bills are untouched", async () => {
  const w = await getWorld();
  const item = await newItem(w.a);
  const done = await billWith(w.a, item, { status: "done" });
  const voided = await billWith(w.a, item, { status: "done" });
  await sql(`update bills set status='voided', voided_at=now(), void_reason='x' where id=$1`, [voided]);
  await setPrice(item, 99);
  assertEqual((await line(done)).p, 40, "done line");
  assertEqual(await total(done), 80, "done total");
  assertEqual((await line(voided)).p, 40, "voided line");
});

test("another item's lines and an unchanged price are left alone", async () => {
  const w = await getWorld();
  const item = await newItem(w.a);
  const other = await newItem(w.a);
  const b = await billWith(w.a, other, { price: 40 });
  await setPrice(item, 70);
  await setPrice(other, 40);
  assertEqual((await line(b)).p, 40, "other item line");
});

test("an admin's price edit through RLS reprices too", async () => {
  const w = await getWorld();
  const item = await newItem(w.a);
  const b = await billWith(w.a, item);
  const { error } = await w.a.clients.admin.from("items").update({ price: 55 }).eq("id", item);
  assert(!error, error?.message);
  assertEqual(await total(b), 110, "bill total");
});

test("a still-pending token message gets the new total", async () => {
  const w = await getWorld();
  const item = await newItem(w.a);
  const b = await billWith(w.a, item);
  await setPrice(item, 50);
  const { rows } = await sql(
    `select (payload->>'total')::float8 t from outbound_messages where bill_id=$1 and status='pending'`, [b]);
  assertEqual(rows[0].t, 100, "message total");
});
```

Add `import "./pending_reprice.test.mjs";` to `tests/run.mjs` after `import "./offline_billing.test.mjs";`.

- [ ] **Step 2: Run to verify fail** — `npm test` (repo root). Expected: the new tests FAIL (prices unchanged).

- [ ] **Step 3: Implement** — create `supabase/migrations/0025_pending_reprice_and_delete.sql`:

```sql
-- Pending reprice + delete pending token.
-- Spec: docs/superpowers/specs/2026-09-27-pending-reprice-search-delete-design.md

-- --------------------------------------------------------------------------
-- Part 1: an item's new price reaches every bill not yet completed.
-- Every pending line is overwritten, hand-edited ones included (owner decision).
-- security definer: the admin editing the item may not hold write rights on
-- bill_items/bills under RLS; the trigger only touches new.vendor_id's rows.
-- --------------------------------------------------------------------------
create function reprice_pending_lines() returns trigger
  language plpgsql security definer set search_path = public as $$
declare
  v_bills uuid[];
begin
  with touched as (
    update bill_items bi
       set unit_price = new.price,
           line_total = round(bi.qty_kg * new.price, 2)
      from bills b
     where bi.item_id = new.id
       and bi.vendor_id = new.vendor_id
       and b.id = bi.bill_id
       and b.status in ('recording', 'billed')
    returning bi.bill_id
  )
  select array_agg(distinct bill_id) into v_bills from touched;

  if v_bills is null then
    return new;
  end if;

  -- A recording bill's total is set by issue_token; only billed totals are live.
  update bills b
     set total = (select coalesce(sum(line_total), 0) from bill_items where bill_id = b.id)
   where b.id = any(v_bills) and b.status = 'billed';

  -- An unsent token message would quote the old figure.
  update outbound_messages m
     set payload = jsonb_set(m.payload, '{total}', to_jsonb(b.total))
    from bills b
   where m.bill_id = b.id and b.id = any(v_bills)
     and b.status = 'billed' and m.status = 'pending';

  return new;
end $$;

create trigger items_reprice_pending
  after update of price on items
  for each row
  when (new.price is distinct from old.price)
  execute function reprice_pending_lines();
```

- [ ] **Step 4: Run to verify pass** — `npm test`. Expected: all pass (previous count + 7).

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/0025_pending_reprice_and_delete.sql tests/pending_reprice.test.mjs tests/run.mjs
git commit -m "feat(db): item price change reprices pending bills (0025)"
```

---

### Task 2: `delete_pending_bill` RPC (migration part 2)

**Files:**
- Modify: `supabase/migrations/0025_pending_reprice_and_delete.sql` (append)
- Create: `tests/delete_pending_bill.test.mjs`
- Modify: `tests/run.mjs` (import after `./pending_reprice.test.mjs`)

**Interfaces:**
- Produces: `delete_pending_bill(p_bill_id uuid) returns void`, callable via `rpc("delete_pending_bill", { p_bill_id })`.

- [ ] **Step 1: Write the failing test** — `tests/delete_pending_bill.test.mjs`

```js
import { test, assert, assertDenied, assertEqual, once } from "./framework.mjs";
import { sql } from "./fixtures.mjs";
import { seedTwoVendors } from "./seed.mjs";

const getWorld = once(seedTwoVendors);

async function billed(v, { status = "billed" } = {}) {
  const { rows: [b] } = await sql(
    `insert into bills (vendor_id, customer_id, recorder_id, total, status)
     values ($1,$2,$3,0,'recording') returning id`, [v.vendorId, v.customerId, v.recorderId]);
  await sql(`insert into bill_items (bill_id, vendor_id, item_id, qty_kg, unit_price, line_total)
             values ($1,$2,$3,1,40,40)`, [b.id, v.vendorId, v.itemId]);
  if (status !== "recording") await sql(`select issue_token($1)`, [b.id]);
  if (status === "done") await sql(`select complete_bill($1, null, 0, 'cash')`, [b.id]);
  return b.id;
}
const lastToken = async (v) => Number((await sql(
  `select last_token from vendor_counters where vendor_id=$1`, [v.vendorId])).rows[0].last_token);
const tokenOf = async (id) => (await sql(`select token_no from bills where id=$1`, [id])).rows[0]?.token_no;
const exists = async (id) => (await sql(`select 1 from bills where id=$1`, [id])).rows.length === 1;
const del = (client, id) => client.rpc("delete_pending_bill", { p_bill_id: id });

test("a biller deletes the latest pending bill and the token is reused", async () => {
  const w = await getWorld();
  const id = await billed(w.a);
  const t = await tokenOf(id);
  const { error } = await del(w.a.clients.biller, id);
  assert(!error, error?.message);
  assert(!(await exists(id)), "bill still there");
  assertEqual(await lastToken(w.a), t - 1, "counter rolled back");
  const next = await billed(w.a);
  assertEqual(await tokenOf(next), t, "token reused");
});

test("an admin may delete; lines and pending message go with the bill", async () => {
  const w = await getWorld();
  const id = await billed(w.a);
  const { error } = await del(w.a.clients.admin, id);
  assert(!error, error?.message);
  assertEqual((await sql(`select count(*)::int n from bill_items where bill_id=$1`, [id])).rows[0].n, 0, "lines");
  assertEqual((await sql(`select count(*)::int n from outbound_messages where bill_id=$1`, [id])).rows[0].n, 0, "messages");
});

test("deleting an older token leaves a gap", async () => {
  const w = await getWorld();
  const older = await billed(w.a);
  const newer = await billed(w.a);
  const before = await lastToken(w.a);
  await del(w.a.clients.biller, older);
  assertEqual(await lastToken(w.a), before, "counter unchanged");
  assert(await exists(newer), "newer bill kept");
});

test("two latest deletes in a row roll back to the highest surviving token", async () => {
  const w = await getWorld();
  const keep = await billed(w.a);
  const mid = await billed(w.a);
  const top = await billed(w.a);
  await del(w.a.clients.biller, mid);   // gap; counter stays at top
  await del(w.a.clients.biller, top);   // latest; counter drops past the gap
  assertEqual(await lastToken(w.a), await tokenOf(keep), "counter at highest surviving token");
});

test("a recording bill (no token) may be deleted without touching the counter", async () => {
  const w = await getWorld();
  await billed(w.a);
  const before = await lastToken(w.a);
  const id = await billed(w.a, { status: "recording" });
  const { error } = await del(w.a.clients.biller, id);
  assert(!error, error?.message);
  assertEqual(await lastToken(w.a), before, "counter");
});

test("a recorder may not delete", async () => {
  const w = await getWorld();
  const id = await billed(w.a);
  assertDenied((await del(w.a.clients.recorder, id)).error, "recorder deleted");
  assert(await exists(id), "bill gone");
});

test("another shop's bill may not be deleted", async () => {
  const w = await getWorld();
  const id = await billed(w.b);
  assertDenied((await del(w.a.clients.biller, id)).error, "cross-vendor delete");
  assert(await exists(id), "bill gone");
});

test("a done bill may not be deleted", async () => {
  const w = await getWorld();
  const id = await billed(w.a, { status: "done" });
  assertDenied((await del(w.a.clients.biller, id)).error, "done bill deleted");
  assert(await exists(id), "bill gone");
});
```

Add `import "./delete_pending_bill.test.mjs";` to `tests/run.mjs` after the Task 1 import.

- [ ] **Step 2: Run to verify fail** — `npm test`. Expected: new tests FAIL ("function delete_pending_bill ... does not exist").

- [ ] **Step 3: Implement** — append to `0025_pending_reprice_and_delete.sql`:

```sql
-- --------------------------------------------------------------------------
-- Part 2: deleting a bill before it is completed.
-- A delete, not a status: nothing has happened yet (no stock, points or payment moves
-- before complete_bill), so there is nothing to keep on record. bill_items and
-- outbound_messages (bill_id, 0020) cascade.
-- The token comes back only when it was the latest one; renumbering later tokens
-- would confuse customers already holding them.
-- --------------------------------------------------------------------------
create function delete_pending_bill(p_bill_id uuid) returns void
  language plpgsql security definer set search_path = public as $$
declare
  v_bill bills%rowtype;
  v_last integer;
begin
  if current_vendor_id() is null or current_user_role() not in ('admin', 'biller') then
    raise exception 'only an admin or biller may delete a pending bill' using errcode = '42501';
  end if;

  -- The counter lock first, the same row issue_token updates, so a token cannot be
  -- issued between reading last_token and rolling it back.
  select last_token into v_last from vendor_counters
   where vendor_id = current_vendor_id() for update;

  select * into v_bill from bills
   where id = p_bill_id and vendor_id = current_vendor_id() for update;
  if not found then
    raise exception 'bill % is not in your shop', p_bill_id using errcode = '42501';
  end if;
  if v_bill.status not in ('recording', 'billed') then
    raise exception 'bill % is %, only a pending bill may be deleted', p_bill_id, v_bill.status
      using errcode = '22023';
  end if;

  delete from bills where id = p_bill_id;

  if v_bill.token_no is not null and v_bill.token_no = v_last then
    update vendor_counters
       set last_token = coalesce(
             (select max(token_no) from bills where vendor_id = v_bill.vendor_id), 0)
     where vendor_id = v_bill.vendor_id;
  end if;
end $$;

revoke all on function delete_pending_bill(uuid) from public, anon;
grant execute on function delete_pending_bill(uuid) to authenticated;
```

- [ ] **Step 4: Run to verify pass** — `npm test`. Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/0025_pending_reprice_and_delete.sql tests/delete_pending_bill.test.mjs tests/run.mjs
git commit -m "feat(db): delete_pending_bill with latest-token rollback (0025)"
```

---

### Task 3: Item search in `ItemGrid`

**Files:**
- Create: `web/src/itemSearch.ts`
- Create: `web/src/__tests__/itemSearch.test.ts`
- Modify: `web/src/screens/bill/ItemGrid.tsx` (add search input above the `<select>`, map over filtered items)
- Modify: `web/src/__tests__/Bill.test.tsx` (one UI test)
- Modify: `web/src/i18n/en.json`, `hi.json`, `mr.json` (`bill.searchItem`, `bill.noItemMatch`)

**Interfaces:**
- Produces: `export function filterItems<T extends { name_en: string; name_hi: string; name_mr: string }>(items: readonly T[], query: string): T[]`

- [ ] **Step 1: Write the failing unit test** — `web/src/__tests__/itemSearch.test.ts`

```ts
import { describe, it, expect } from "vitest";
import { filterItems } from "../itemSearch";

const items = [
  { id: "1", name_en: "Onion", name_hi: "प्याज", name_mr: "कांदा" },
  { id: "2", name_en: "Potato", name_hi: "आलू", name_mr: "बटाटा" },
  { id: "3", name_en: "Green Chilli", name_hi: "", name_mr: "" },
];

describe("filterItems", () => {
  it("returns everything for an empty or blank query", () => {
    expect(filterItems(items, "")).toHaveLength(3);
    expect(filterItems(items, "   ")).toHaveLength(3);
  });
  it("matches English case-insensitively, anywhere in the name", () => {
    expect(filterItems(items, "ONI").map((i) => i.id)).toEqual(["1"]);
    expect(filterItems(items, "chil").map((i) => i.id)).toEqual(["3"]);
  });
  it("matches Hindi and Marathi names regardless of UI language", () => {
    expect(filterItems(items, "आलू").map((i) => i.id)).toEqual(["2"]);
    expect(filterItems(items, "कांदा").map((i) => i.id)).toEqual(["1"]);
  });
  it("returns nothing when nothing matches", () => {
    expect(filterItems(items, "mango")).toEqual([]);
  });
});
```

- [ ] **Step 2: Run to verify fail** — `cd web && npx vitest run src/__tests__/itemSearch.test.ts`. Expected: FAIL (module not found).

- [ ] **Step 3: Implement** — `web/src/itemSearch.ts`

```ts
/**
 * The billing item search. Matches all three names whatever the UI language, so a
 * recorder can type in whichever script is quickest for them.
 */
export function filterItems<T extends { name_en: string; name_hi: string; name_mr: string }>(
  items: readonly T[],
  query: string,
): T[] {
  const q = query.trim().toLocaleLowerCase();
  if (q === "") return [...items];
  return items.filter((i) =>
    [i.name_en, i.name_hi, i.name_mr].some((n) => n.toLocaleLowerCase().includes(q)));
}
```

- [ ] **Step 4: Run unit test** — Expected: PASS.

- [ ] **Step 5: Wire into `ItemGrid.tsx`**

Add import `import { filterItems } from "../../itemSearch";`, state `const [query, setQuery] = useState("");`, and `const shown = filterItems(items, query);`. Insert before the `<label ... htmlFor="item-select">`:

```tsx
      <input
        type="search"
        data-testid="item-search"
        aria-label={t("bill.searchItem")}
        placeholder={t("bill.searchItem")}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        className="w-full border border-slate-300 rounded-lg px-3 py-2 min-h-[44px] bg-white text-base text-slate-800"
      />
      {shown.length === 0 && (
        <p data-testid="item-no-match" className="text-sm text-slate-500">{t("bill.noItemMatch")}</p>
      )}
```

In the `<select>`, replace `{items.map((item) => (` with `{shown.map((item) => (`. Leave the `onChange` lookup as `items.find(...)` and `selected` independent of the filter so a selected item stays addable after the query changes. Also clear the query in `add()` after a successful add: add `setQuery("");` next to `setQty("");`.

i18n (add inside `"bill"` object of each file):
- en: `"searchItem": "Search items", "noItemMatch": "No item matches."`
- hi: `"searchItem": "आइटम खोजें", "noItemMatch": "कोई आइटम नहीं मिला।"`
- mr: `"searchItem": "वस्तू शोधा", "noItemMatch": "कोणतीही वस्तू सापडली नाही."`

- [ ] **Step 6: Add UI test** to `web/src/__tests__/Bill.test.tsx` (inside the existing top-level `describe`, reusing that file's render helper and item mocks — read the file's first 70 lines to use its exact helper name and item fixture names):

```tsx
  it("filters the item list by the search box and keeps a selection addable", async () => {
    // <render the Bill screen the way neighbouring tests do and reach the item step>
    const select = (await screen.findByTestId("item-select")) as HTMLSelectElement;
    const allOptions = select.options.length;
    fireEvent.change(screen.getByTestId("item-search"), { target: { value: "zzz-no-such-item" } });
    expect(select.options.length).toBe(1); // only the placeholder option
    expect(screen.getByTestId("item-no-match")).toBeTruthy();
    fireEvent.change(screen.getByTestId("item-search"), { target: { value: "" } });
    expect(select.options.length).toBe(allOptions);
  });
```

The `<render…>` comment must be replaced with the exact lines the neighbouring test at `Bill.test.tsx:43` uses to reach `item-select`.

- [ ] **Step 7: Run** — `cd web && npx vitest run && npx tsc --noEmit`. Expected: all pass, no type errors.

- [ ] **Step 8: Commit**

```bash
git add web/src/itemSearch.ts web/src/__tests__/itemSearch.test.ts web/src/screens/bill/ItemGrid.tsx web/src/__tests__/Bill.test.tsx web/src/i18n/*.json
git commit -m "feat(web): search items while billing"
```

---

### Task 4: Delete button on the Pending screen

**Files:**
- Modify: `web/src/data.ts` (add `deletePendingBill` after `listPending`)
- Modify: `web/src/screens/Pending.tsx`
- Modify: `web/src/__tests__/Pending.test.tsx`
- Modify: `web/src/i18n/en.json`, `hi.json`, `mr.json` (`pending.delete`, `pending.deleteTitle`, `pending.deleteBody`, `pending.deleteAccept`, `pending.deleted`)

**Interfaces:**
- Consumes: RPC `delete_pending_bill(p_bill_id uuid)` from Task 2.
- Produces: `export async function deletePendingBill(billId: string)` returning the supabase rpc result `{ error }`.

- [ ] **Step 1: Write failing tests** — in `Pending.test.tsx`, add a mock and include it in the `vi.mock("../data", ...)` factory:

```tsx
const deletePendingBill = vi.fn(async (..._a: unknown[]): Promise<{ error: { message?: string; code?: string } | null }> =>
  ({ error: null }));
// inside vi.mock("../data", () => ({ ... })):
  deletePendingBill: (...a: unknown[]) => deletePendingBill(...a),
```

Add tests:

```tsx
describe("deleting a pending bill", () => {
  it("a biller deletes after confirming, and the list refreshes", async () => {
    renderPending({ role: "biller" });
    fireEvent.click(await screen.findByTestId("pending-delete-b1"));
    expect(deletePendingBill).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId("pending-delete-confirm"));
    await waitFor(() => expect(deletePendingBill).toHaveBeenCalledWith("b1"));
    await waitFor(() => expect(listPending).toHaveBeenCalledTimes(2));
  });

  it("cancel does not delete", async () => {
    renderPending({ role: "admin" });
    fireEvent.click(await screen.findByTestId("pending-delete-b1"));
    fireEvent.click(screen.getByTestId("pending-delete-cancel"));
    expect(deletePendingBill).not.toHaveBeenCalled();
  });

  it("a recorder sees no delete button", async () => {
    renderPending({ role: "recorder" });
    await screen.findByText(/Asha/);
    expect(screen.queryByTestId("pending-delete-b1")).toBeNull();
  });

  it("a refused delete shows the failure", async () => {
    deletePendingBill.mockResolvedValueOnce({ error: { message: "nope", code: "42501" } });
    renderPending({ role: "biller" });
    fireEvent.click(await screen.findByTestId("pending-delete-b1"));
    fireEvent.click(screen.getByTestId("pending-delete-confirm"));
    await screen.findByText(/nope/);
  });
});
```

- [ ] **Step 2: Run to verify fail** — `cd web && npx vitest run src/__tests__/Pending.test.tsx`. Expected: new tests FAIL (no `pending-delete-b1`).

- [ ] **Step 3: Implement**

`data.ts`, after `listPending`:

```ts
/** Deletes a bill that has not been completed (0025). Its token is reused only if it was
 *  the latest; the database decides that, and refuses a done bill or another shop's. */
export async function deletePendingBill(billId: string) {
  return supabase.rpc("delete_pending_bill", { p_bill_id: billId });
}
```

`Pending.tsx`: import `deletePendingBill`; add state

```tsx
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [deleted, setDeleted] = useState(false);

  async function confirmDelete(id: string) {
    setDeletingId(null);
    setDeleted(false);
    const { error } = await deletePendingBill(id);
    if (error) {
      setFailure(describeError(error));
      return;
    }
    setDeleted(true);
    await refresh();
  }
```

Note: `refresh()` calls `setFailure(describeError(error))` with the list's error, which clears the delete failure on success — correct, since refresh only runs on success.

In the row's `<div className="flex gap-2">`, before the Complete button:

```tsx
              {(session.role === "admin" || session.role === "biller") && (
                <button
                  data-testid={`pending-delete-${bill.id}`}
                  onClick={() => setDeletingId(bill.id)}
                  disabled={completingId === bill.id}
                  className="border border-red-300 text-red-700 rounded-lg px-3 py-2 text-sm bg-white min-h-[44px] disabled:opacity-50"
                >
                  {t("pending.delete")}
                </button>
              )}
```

After the `{completed && ...}` success paragraph:

```tsx
      {deleted && (
        <p className="border border-emerald-200 bg-emerald-50 rounded-xl p-3 text-sm text-emerald-700">
          {t("pending.deleted")}
        </p>
      )}
```

Before the complete-confirm dialog block:

```tsx
      {deletingId && (() => {
        const bill = bills?.find((b) => b.id === deletingId);
        if (!bill) return null;
        return (
          <div role="dialog" aria-modal="true" aria-labelledby="pending-delete-title"
               className="fixed inset-0 bg-black/40 flex items-end sm:items-center justify-center p-4">
            <div className="bg-white rounded-xl p-4 w-full max-w-sm space-y-3">
              <h2 id="pending-delete-title" className="font-semibold text-slate-800">
                {t("pending.deleteTitle", { n: bill.token_no })}
              </h2>
              <p className="text-slate-700">{t("pending.deleteBody")}</p>
              <div className="flex gap-2 justify-end">
                <button data-testid="pending-delete-cancel" onClick={() => setDeletingId(null)}
                        className="border border-slate-300 rounded-lg px-3 py-2 min-h-[44px]">
                  {t("bill.cancel")}
                </button>
                <button data-testid="pending-delete-confirm" onClick={() => void confirmDelete(bill.id)}
                        className="rounded-lg px-4 py-2 min-h-[44px] bg-red-600 text-white font-semibold">
                  {t("pending.deleteAccept")}
                </button>
              </div>
            </div>
          </div>
        );
      })()}
```

i18n (inside `"pending"`):
- en: `"delete": "Delete", "deleteTitle": "Delete token {{n}}?", "deleteBody": "The bill and its items are removed. If this is the latest token, the number is used again for the next bill.", "deleteAccept": "Delete bill", "deleted": "Bill deleted."`
- hi: `"delete": "हटाएँ", "deleteTitle": "टोकन {{n}} हटाएँ?", "deleteBody": "बिल और उसके आइटम हटा दिए जाएँगे। अगर यह आख़िरी टोकन है, तो यही नंबर अगले बिल को मिलेगा।", "deleteAccept": "बिल हटाएँ", "deleted": "बिल हटा दिया गया।"`
- mr: `"delete": "काढा", "deleteTitle": "टोकन {{n}} काढायचा?", "deleteBody": "बिल आणि त्यातील वस्तू काढल्या जातील. हा शेवटचा टोकन असल्यास, हाच क्रमांक पुढच्या बिलाला मिळेल.", "deleteAccept": "बिल काढा", "deleted": "बिल काढले."`

- [ ] **Step 4: Run** — `cd web && npx vitest run && npx tsc --noEmit`. Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add web/src/data.ts web/src/screens/Pending.tsx web/src/__tests__/Pending.test.tsx web/src/i18n/*.json
git commit -m "feat(web): delete a pending bill from the queue"
```

---

### Task 5: README + full verification

**Files:**
- Modify: `README.md` (add a short section describing the three behaviours, following the existing per-slice style)

- [ ] **Step 1:** Add README lines: price edits reprice pending bills; item search on Bill/Edit bill; admin/biller can delete a pending bill, token reused only when it was the latest.
- [ ] **Step 2:** Run `npm test` (root) and `cd web && npx vitest run && npm run build`. Expected: all green.
- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs: pending reprice, item search, delete pending token"
```

Rollout (not part of implementation; owner-run): apply 0025 by hand in the SQL editor, insert the migration tracking row, push branch, PR, merge, confirm CI + Pages.
