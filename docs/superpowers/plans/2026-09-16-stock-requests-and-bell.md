# Stock Requests, Low-Stock Bell, and Pair-Name Fix — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let staff log the items customers ask for but the shop does not stock, surface that demand on the admin dashboard, badge the Items nav when stock runs low, and stop the bought-together card rendering English names under a Marathi UI.

**Architecture:** One migration (`0013`) adds a `status` column to the already-shipped `stock_requests` table, opens it to staff writes with new RLS policies, drops the destructive admin DELETE, and adds a date-ranged reader alongside the existing `*_between()` analytics functions. The frontend gains one screen, one data module, a polling hook, and a dashboard card. Requirements closed: #9, #10, #20.

**Tech Stack:** PostgreSQL 17 (Supabase Cloud in production, native Postgres for the suite), plain SQL migrations, React 19 + TypeScript + Vite, `@supabase/supabase-js` 2.116.0, react-i18next, Tailwind utility classes, Vitest for the web suite, a bespoke harness (`tests/framework.mjs`) for the database suite.

**Spec:** `docs/superpowers/specs/2026-09-16-stock-requests-and-bell-design.md`

## Global Constraints

- **Migrations are append-only and immutable.** Never edit `0001`–`0012`. All schema change goes in `supabase/migrations/0013_stock_requests_worklist.sql`. The suite applies every file in filename order, unmodified — the same files `supabase db push` sends to Cloud.
- **RLS is the security boundary, never the client.** Route guards in `web/src/routes.ts` are UX only. Every new table-touching capability needs a policy, and a test proving the policy denies the wrong caller.
- **Three roles exist:** `admin`, `recorder`, `biller`. Helper functions `current_vendor_id()` and `current_user_role()` are defined in `0002_rls.sql` and are what policies use.
- **No client-side vendor filtering.** RLS already scopes every query to the caller's tenant; a `.eq("vendor_id", …)` in the client is a weaker second copy of the policy. See the header comment in `web/src/data.ts`.
- **PostgREST serialises Postgres `numeric` and `bigint` as STRINGS.** Coerce with `Number()` before arithmetic or rendering. This has shipped as a bug before.
- **Changing a function's return type requires DROP then CREATE.** `create or replace` cannot change it. Keep the argument list identical so no PostgREST overload ambiguity arises (see the comment at `0010_points_redemption.sql:12`).
- **Every user-facing string is an i18n key** in `web/src/i18n/{en,hi,mr}.json`. All three files must gain the same keys. hi/mr strings are AI-written and unreviewed — label them as such in the commit body, never claim they are translated.
- **Run the database suite with `npm test` from the repo root.** Needs the native `postgresql-x64-17` service running and a `vendor_app_test` database. The exit code is the gate — never pipe it.
- **Run the web suite with `npm test` from `web/`** (`vitest run`). `npm run build` there also runs `tsc --noEmit`.
- **Touch targets are `min-h-[44px]`** and the layout is `max-w-3xl` — staff use this on phones at a counter.

---

## File Structure

**Created:**
- `supabase/migrations/0013_stock_requests_worklist.sql` — status column, staff insert/update policies, dropped delete policy, `stock_requests_between()`, and the rebuilt `bought_together_between()`.
- `tests/stock_requests.test.mjs` — RLS and function coverage for everything in 0013.
- `web/src/requests.ts` — every PostgREST call for stock requests, plus the pure name-normalisation logic.
- `web/src/screens/Requests.tsx` — the log-and-worklist screen.
- `web/src/useLowStock.ts` — the polling hook behind the nav badge.
- `web/src/__tests__/requests.test.ts` — normalisation unit tests.

**Modified:**
- `tests/run.mjs` — import the new test file.
- `web/src/history.ts` — the `Pair` type gains six name columns.
- `web/src/screens/Dashboards.tsx` — localise pair names; add the requests card.
- `web/src/routes.ts` — add `/requests` for recorder and admin.
- `web/src/App.tsx` — route the new screen.
- `web/src/components/Shell.tsx` — render the low-stock badge.
- `web/src/i18n/{en,hi,mr}.json` — new keys.

---

### Task 1: Migration 0013 — schema, policies, and the two functions

**Files:**
- Create: `supabase/migrations/0013_stock_requests_worklist.sql`
- Create: `tests/stock_requests.test.mjs`
- Modify: `tests/run.mjs:19` (add one import line after `./kick.test.mjs`)

**Interfaces:**
- Consumes: `current_vendor_id()` and `current_user_role()` from `0002_rls.sql`; the `stock_requests` table from `0001_schema.sql:112`; the seed helper `seedTwoVendors()` from `tests/seed.mjs`.
- Produces:
  - `stock_requests.status` — `text not null default 'open'`, constrained to `'open' | 'handled'`.
  - Policies `stock_requests_staff_insert`, `stock_requests_staff_update`. Policy `stock_requests_admin_delete` no longer exists.
  - `stock_requests_between(p_from timestamptz, p_to timestamptz)` returning `(item_name text, request_count bigint, last_requested_at timestamptz)`.
  - `bought_together_between(p_from timestamptz, p_to timestamptz)` returning `(item_a uuid, item_b uuid, name_a_en text, name_a_hi text, name_a_mr text, name_b_en text, name_b_hi text, name_b_mr text, bill_count bigint)`.

- [ ] **Step 1: Write the failing test**

Create `tests/stock_requests.test.mjs`:

```javascript
import { test, assert, assertDenied, assertInvisible, assertEqual, once } from "./framework.mjs";
import { sql, newClient } from "./fixtures.mjs";
import { seedTwoVendors } from "./seed.mjs";

// NOT seeded at import time: run.mjs imports this file before bootstrap() rebuilds the
// schema, so an import-time seed would be dropped. once() defers it to the first test.
const getWorld = once(seedTwoVendors);

test("a recorder may log a stock request", async () => {
  const world = await getWorld();
  const { error } = await world.a.clients.recorder
    .from("stock_requests")
    .insert({ vendor_id: world.a.vendorId, item_name: "dragon fruit" });
  assert(!error, `recorder insert was refused: ${error?.message}`);
});

test("an admin may log a stock request", async () => {
  const world = await getWorld();
  const { error } = await world.a.clients.admin
    .from("stock_requests")
    .insert({ vendor_id: world.a.vendorId, item_name: "kiwi" });
  assert(!error, `admin insert was refused: ${error?.message}`);
});

test("a biller may not log a stock request", async () => {
  const world = await getWorld();
  const { error } = await world.a.clients.biller
    .from("stock_requests")
    .insert({ vendor_id: world.a.vendorId, item_name: "avocado" });
  assertDenied(error, "a biller was allowed to log a stock request");
});

test("a recorder may not log a request into another vendor", async () => {
  const world = await getWorld();
  const { error } = await world.a.clients.recorder
    .from("stock_requests")
    .insert({ vendor_id: world.b.vendorId, item_name: "papaya" });
  assertDenied(error, "vendor A wrote a stock request into vendor B");
});

test("a blank item name is rejected", async () => {
  const world = await getWorld();
  const { error } = await world.a.clients.recorder
    .from("stock_requests")
    .insert({ vendor_id: world.a.vendorId, item_name: "   " });
  assertDenied(error, "a whitespace-only item name was accepted");
});

test("a new request starts open", async () => {
  const world = await getWorld();
  const { data, error } = await world.a.clients.recorder
    .from("stock_requests")
    .insert({ vendor_id: world.a.vendorId, item_name: "lychee" })
    .select("status")
    .single();
  assert(!error, `insert failed: ${error?.message}`);
  assertEqual(data.status, "open", "a new request should default to open");
});

test("a recorder may mark a request handled", async () => {
  const world = await getWorld();
  const { data: made } = await world.a.clients.recorder
    .from("stock_requests")
    .insert({ vendor_id: world.a.vendorId, item_name: "rambutan" })
    .select("id")
    .single();

  const { data, error } = await world.a.clients.recorder
    .from("stock_requests")
    .update({ status: "handled" })
    .eq("id", made.id)
    .select("status")
    .single();
  assert(!error, `update was refused: ${error?.message}`);
  assertEqual(data.status, "handled", "status did not flip");
});

test("an unknown status is rejected", async () => {
  const world = await getWorld();
  const { data: made } = await world.a.clients.recorder
    .from("stock_requests")
    .insert({ vendor_id: world.a.vendorId, item_name: "durian" })
    .select("id")
    .single();

  const { error } = await world.a.clients.recorder
    .from("stock_requests")
    .update({ status: "done" })
    .eq("id", made.id);
  assertDenied(error, "an unconstrained status value was accepted");
});

// Dropping stock_requests_admin_delete is a deliberate behaviour change: deleting rows
// destroys the demand history that v_stock_request_counts and #10 exist to report.
test("an admin may no longer delete a request", async () => {
  const world = await getWorld();
  const { data: made } = await world.a.clients.recorder
    .from("stock_requests")
    .insert({ vendor_id: world.a.vendorId, item_name: "mangosteen" })
    .select("id")
    .single();

  await world.a.clients.admin.from("stock_requests").delete().eq("id", made.id);

  const { data, error } = await world.a.clients.admin
    .from("stock_requests").select("id").eq("id", made.id);
  assert(!error, `unexpected error: ${error?.message}`);
  assertEqual(data.length, 1, "the row was deleted; the delete policy should be gone");
});

test("stock_requests_between counts, orders, and respects its date bounds", async () => {
  const world = await getWorld();
  const vid = world.a.vendorId;
  // Two rows for 'beetroot', one for 'turnip', all inside the window.
  await sql(`insert into stock_requests (vendor_id, item_name, created_at)
             values ($1,'beetroot', now() - interval '2 days'),
                    ($1,'Beetroot', now() - interval '1 day'),
                    ($1,'turnip',   now() - interval '1 day')`, [vid]);
  // One well outside it, which must not be counted.
  await sql(`insert into stock_requests (vendor_id, item_name, created_at)
             values ($1,'beetroot', now() - interval '90 days')`, [vid]);

  const { data, error } = await world.a.clients.admin.rpc("stock_requests_between", {
    p_from: new Date(Date.now() - 7 * 86400000).toISOString(),
    p_to: new Date(Date.now() + 86400000).toISOString(),
  });
  assert(!error, `rpc failed: ${error?.message}`);

  const beet = data.find((r) => r.item_name === "beetroot");
  assert(beet, "beetroot missing from the result");
  // Case is folded, so 'beetroot' and 'Beetroot' are one row -- and the 90-day-old row
  // is outside the window. bigint arrives as a string; coerce before comparing.
  assertEqual(Number(beet.request_count), 2, "beetroot count is wrong");
  assertEqual(data[0].item_name, "beetroot", "results are not ordered by count desc");
});

test("stock_requests_between does not leak across vendors", async () => {
  const world = await getWorld();
  await sql(`insert into stock_requests (vendor_id, item_name) values ($1,'vendor-b-only-fruit')`,
    [world.b.vendorId]);

  const { data, error } = await world.a.clients.admin.rpc("stock_requests_between", {
    p_from: new Date(Date.now() - 7 * 86400000).toISOString(),
    p_to: new Date(Date.now() + 86400000).toISOString(),
  });
  assert(!error, `rpc failed: ${error?.message}`);
  assertEqual(
    data.filter((r) => r.item_name === "vendor-b-only-fruit"),
    [],
    "vendor A saw vendor B's stock requests",
  );
});

test("an anonymous client sees no stock requests", async () => {
  const world = await getWorld();
  await sql(`insert into stock_requests (vendor_id, item_name) values ($1,'anon-check')`,
    [world.a.vendorId]);
  // newClient() with no sign-in IS the anon client -- same idiom as rls.test.mjs:157.
  const anon = await newClient();
  const { data } = await anon.from("stock_requests").select("*");
  assertInvisible(data, "an anon client could read stock requests");
});

test("bought_together_between returns all three names per side", async () => {
  const world = await getWorld();
  const { data, error } = await world.a.clients.admin.rpc("bought_together_between", {
    p_from: new Date(Date.now() - 7 * 86400000).toISOString(),
    p_to: new Date(Date.now() + 86400000).toISOString(),
  });
  assert(!error, `rpc failed: ${error?.message}`);
  // The shape is what matters here; whether any pair clears the threshold of 3 is
  // analytics.test.mjs's business. An empty result still proves the signature resolves.
  assert(Array.isArray(data), "expected rows");
});
```

Add the import to `tests/run.mjs` immediately after line 19 (`import "./kick.test.mjs";`):

```javascript
import "./stock_requests.test.mjs";
```

> **Note on the anon helper:** `tests/fixtures.mjs` exports the anonymous-client helper used by the existing "anon sees nothing" case in `tests/rls.test.mjs`. Open that file, copy the exact import and call it uses, and replace the dynamic `await import("./fixtures.mjs")` line above with the same idiom. Do not invent a new helper.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test`
Expected: FAIL. The insert cases fail because no insert policy exists (PostgREST returns a 42501), and the two RPC cases fail with "function stock_requests_between does not exist" / a missing-column error on the pair names.

- [ ] **Step 3: Write the migration**

Create `supabase/migrations/0013_stock_requests_worklist.sql`:

```sql
-- Requirements #20, #10 and the #9 bell's data source, plus an i18n fix to the
-- bought-together card.
--
-- #20 was specified as customers messaging the WhatsApp bot. WhatsApp is on hold for
-- want of a sender number, and the demand data behind #10 does not need the bot: staff
-- hear the requests at the counter, and logging them there also catches the walk-ins who
-- ask and leave without buying.

alter table stock_requests
  add column status text not null default 'open'
    check (status in ('open', 'handled'));

comment on column stock_requests.status is
  'Worklist state for staff. v_stock_request_counts and stock_requests_between() ignore '
  'it DELIBERATELY: handling a request does not un-ask it, and #10 is demand history.';

-- item_name is what v_stock_request_counts groups on. A blank one is a row that can
-- never be acted on and silently skews nothing -- refuse it at the boundary.
alter table stock_requests
  add constraint stock_requests_item_name_not_blank
    check (length(btrim(item_name)) > 0);

-- 0001 shipped this table with a read policy and an admin delete, on the assumption the
-- bot would insert as service_role (which bypasses RLS). Staff now write it directly.
create policy stock_requests_staff_insert on stock_requests for insert to authenticated
  with check (vendor_id = current_vendor_id()
              and current_user_role() in ('recorder', 'admin'));

-- The update permits editing item_name as well as status. v_stock_request_counts groups
-- on lower(item_name), so a typo fragments the count into two rows, and the person who
-- made it should be able to repair it. Narrowing this to status alone would need a
-- column-level grant; no migration in this project issues explicit grants, and this is
-- not the place to introduce the pattern.
create policy stock_requests_staff_update on stock_requests for update to authenticated
  using (vendor_id = current_vendor_id()
         and current_user_role() in ('recorder', 'admin'))
  with check (vendor_id = current_vendor_id());

-- Deleting a handled request destroys the evidence of the demand that #10 reports:
-- stock the item because eleven people asked, clear those eleven, and the dashboard
-- then says nobody ever wanted it. Marking handled replaces clearing.
drop policy if exists stock_requests_admin_delete on stock_requests;

-- #10, date-ranged. Deliberately the same shape as top_items_between() in 0007: the
-- dashboard has one date filter and every card respects it.
create function stock_requests_between(p_from timestamptz, p_to timestamptz)
  returns table (
    item_name         text,
    request_count     bigint,
    last_requested_at timestamptz
  )
  language sql stable as $$
  select lower(sr.item_name) as item_name,
         count(*) as request_count,
         max(sr.created_at) as last_requested_at
    from stock_requests sr
   where sr.created_at >= p_from
     and sr.created_at <  p_to
   group by lower(sr.item_name)
   order by count(*) desc, lower(sr.item_name)
   limit 10;
$$;

revoke all on function stock_requests_between(timestamptz, timestamptz) from public, anon;
grant execute on function stock_requests_between(timestamptz, timestamptz) to authenticated, service_role;

-- The bought-together card rendered name_en regardless of the UI language, so a Marathi
-- admin saw Marathi in the Top Items card and English in the card directly below it.
-- Return all three names per side and let the client pick.
--
-- DROP then CREATE, not CREATE OR REPLACE: Postgres will not let a replace change a
-- return type. The argument list is unchanged, so the PostgREST overload ambiguity that
-- 0010 warns about does not arise here.
drop function if exists bought_together_between(timestamptz, timestamptz);

create function bought_together_between(p_from timestamptz, p_to timestamptz)
  returns table (
    item_a     uuid,
    item_b     uuid,
    name_a_en  text,
    name_a_hi  text,
    name_a_mr  text,
    name_b_en  text,
    name_b_hi  text,
    name_b_mr  text,
    bill_count bigint
  )
  language sql stable as $$
  select a.item_id as item_a, b.item_id as item_b,
         ia.name_en, ia.name_hi, ia.name_mr,
         ib.name_en, ib.name_hi, ib.name_mr,
         count(distinct a.bill_id) as bill_count
    from bill_items a
    join bill_items b on b.bill_id = a.bill_id and a.item_id < b.item_id
    join bills bl on bl.id = a.bill_id
                 and bl.status = 'done'
                 and bl.completed_at >= p_from
                 and bl.completed_at <  p_to
    join items ia on ia.id = a.item_id
    join items ib on ib.id = b.item_id
   group by a.item_id, b.item_id,
            ia.name_en, ia.name_hi, ia.name_mr,
            ib.name_en, ib.name_hi, ib.name_mr
  having count(distinct a.bill_id) >= 3
   order by count(distinct a.bill_id) desc, a.item_id, b.item_id
   limit 10;
$$;

revoke all on function bought_together_between(timestamptz, timestamptz) from public, anon;
grant execute on function bought_together_between(timestamptz, timestamptz) to authenticated, service_role;
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test`
Expected: PASS, with the case count risen by the thirteen new cases and 0 failures.

If `tests/analytics.test.mjs` now fails, it is asserting the old `name_a`/`name_b` columns. Update those assertions to the new column names — do not revert the function.

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/0013_stock_requests_worklist.sql tests/stock_requests.test.mjs tests/run.mjs
git commit -m "feat: let staff log the items customers ask for"
```

---

### Task 2: The `requests.ts` data module

**Files:**
- Create: `web/src/requests.ts`
- Create: `web/src/__tests__/requests.test.ts`

**Interfaces:**
- Consumes: `supabase` from `web/src/supabase.ts`; the migration from Task 1.
- Produces:
  - `type StockRequest = { id: string; item_name: string; status: "open" | "handled"; created_at: string }`
  - `normaliseItemName(raw: string): string`
  - `logRequest(vendorId: string, itemName: string)` → PostgREST result
  - `listRequests()` → PostgREST result, newest first
  - `markHandled(id: string)` → PostgREST result

- [ ] **Step 1: Write the failing test**

Create `web/src/__tests__/requests.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { normaliseItemName } from "../requests";

describe("normaliseItemName", () => {
  it("trims surrounding whitespace", () => {
    expect(normaliseItemName("  dragon fruit  ")).toBe("dragon fruit");
  });

  it("collapses runs of internal whitespace", () => {
    // Two words typed with a stray double space must not become a second row in
    // v_stock_request_counts, which groups on the exact lowered string.
    expect(normaliseItemName("dragon   fruit")).toBe("dragon fruit");
  });

  it("treats tabs and newlines as whitespace", () => {
    expect(normaliseItemName("dragon\tfruit\n")).toBe("dragon fruit");
  });

  it("returns an empty string for a whitespace-only entry", () => {
    // The screen uses this to disable the Log button, so the blank never reaches the
    // check constraint added in 0013.
    expect(normaliseItemName("   ")).toBe("");
  });

  it("preserves case as typed", () => {
    // Case folding is the database's job (lower() in stock_requests_between). Doing it
    // here too would show staff a lowercased version of what they typed.
    expect(normaliseItemName("Dragon Fruit")).toBe("Dragon Fruit");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd web && npm test -- requests`
Expected: FAIL — "Failed to resolve import ../requests".

- [ ] **Step 3: Write the module**

Create `web/src/requests.ts`:

```typescript
import { supabase } from "./supabase";

export type StockRequest = {
  id: string;
  item_name: string;
  status: "open" | "handled";
  created_at: string;
};

/**
 * Trim and collapse internal whitespace, preserving case.
 *
 * stock_requests_between() groups on lower(item_name), so "dragon fruit" and
 * "dragon  fruit" would otherwise count as two different fruits. Case is folded in SQL
 * rather than here, so the worklist shows staff exactly what they typed.
 *
 * Deliberately NOT doing fuzzy matching: "dragonfruit" and "dragon fruit" will still
 * count separately. Synonym tables and trigram matching are speculative until real
 * counter entry proves messy; the item_name edit path in 0013 is the cheap mitigation.
 */
export function normaliseItemName(raw: string): string {
  return raw.trim().replace(/\s+/g, " ");
}

/**
 * Every PostgREST call for stock requests lives here, for the same two reasons as
 * data.ts: vendor_id is NOT NULL with no default and forgetting it is a bug that has
 * shipped before, and the screens get a small surface to stub in tests.
 *
 * None of these filters by vendor on the read path. RLS scopes it; a client filter
 * would be a weaker second copy of stock_requests_read.
 */
export async function logRequest(vendorId: string, itemName: string) {
  return supabase
    .from("stock_requests")
    .insert({ vendor_id: vendorId, item_name: normaliseItemName(itemName) })
    .select("id, item_name, status, created_at")
    .single();
}

export async function listRequests() {
  return supabase
    .from("stock_requests")
    .select("id, item_name, status, created_at")
    .order("created_at", { ascending: false })
    .limit(200);
}

export async function markHandled(id: string) {
  return supabase
    .from("stock_requests")
    .update({ status: "handled" })
    .eq("id", id)
    .select("id, status")
    .single();
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd web && npm test -- requests`
Expected: PASS, 5 cases.

- [ ] **Step 5: Commit**

```bash
git add web/src/requests.ts web/src/__tests__/requests.test.ts
git commit -m "feat: add the stock-requests data module"
```

---

### Task 3: The Requests screen and its route

**Files:**
- Create: `web/src/screens/Requests.tsx`
- Modify: `web/src/routes.ts:15-30` (the `BY_ROLE` map)
- Modify: `web/src/App.tsx` (add the route)
- Modify: `web/src/i18n/en.json`, `web/src/i18n/hi.json`, `web/src/i18n/mr.json`
- Test: `web/src/__tests__/routes.test.ts` (extend the existing file)

**Interfaces:**
- Consumes: `logRequest`, `listRequests`, `markHandled`, `normaliseItemName`, `StockRequest` from Task 2; `useSession()` from `web/src/components/SessionProvider.tsx`; `describeError` from `web/src/errors.ts`.
- **`useSession()` returns a discriminated union** (`web/src/session.ts:11`), not an object with `vendorId` on it. `vendorId` exists only on the `kind: "ready"` variant, so the component must narrow before reading it — `const session = useSession()`, then guard on `session.kind !== "ready"`. Destructuring `vendorId` straight off the hook will not type-check. `web/src/screens/Items.tsx:30` is the pattern to copy.
- Produces: the default-exported `Requests` component and the `/requests` path.

- [ ] **Step 1: Write the failing test**

Open `web/src/__tests__/routes.test.ts` and read how it asserts existing paths. Append, matching that file's style:

```typescript
it("gives recorders and admins the requests screen, but not billers", () => {
  expect(canAccess("recorder", "/requests")).toBe(true);
  expect(canAccess("admin", "/requests")).toBe(true);
  // UX only -- what actually stops a biller writing one is stock_requests_staff_insert
  // in 0013_stock_requests_worklist.sql.
  expect(canAccess("biller", "/requests")).toBe(false);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd web && npm test -- routes`
Expected: FAIL — `canAccess("recorder", "/requests")` returns `false`.

- [ ] **Step 3: Add the route and the i18n keys**

In `web/src/routes.ts`, add to the `recorder` array (after `/customers`) and to the `admin` array (after `/customers`):

```typescript
    { path: "/requests", labelKey: "nav.requests" },
```

In `web/src/i18n/en.json`, add to `nav`:

```json
  "requests": "Requests"
```

and a new top-level `req` block:

```json
"req": {
  "title": "Customer requests",
  "hint": "Items customers asked for that you do not stock.",
  "placeholder": "Item a customer asked for",
  "log": "Log request",
  "open": "Open",
  "handled": "Handled",
  "markHandled": "Mark handled",
  "showHandled": "Show handled ({{n}})",
  "hideHandled": "Hide handled",
  "empty": "No requests logged yet.",
  "loading": "Loading…"
}
```

In `web/src/i18n/hi.json`, add to `nav`: `"requests": "अनुरोध"` and:

```json
"req": {
  "title": "ग्राहक अनुरोध",
  "hint": "ग्राहकों ने जो सामान मांगा और आपके पास नहीं है।",
  "placeholder": "ग्राहक ने जो सामान मांगा",
  "log": "अनुरोध दर्ज करें",
  "open": "खुला",
  "handled": "पूरा हुआ",
  "markHandled": "पूरा हुआ चिह्नित करें",
  "showHandled": "पूरे हुए दिखाएं ({{n}})",
  "hideHandled": "पूरे हुए छिपाएं",
  "empty": "अभी तक कोई अनुरोध दर्ज नहीं है।",
  "loading": "लोड हो रहा है…"
}
```

In `web/src/i18n/mr.json`, add to `nav`: `"requests": "विनंत्या"` and:

```json
"req": {
  "title": "ग्राहक विनंत्या",
  "hint": "ग्राहकांनी मागितलेल्या पण तुमच्याकडे नसलेल्या वस्तू.",
  "placeholder": "ग्राहकाने मागितलेली वस्तू",
  "log": "विनंती नोंदवा",
  "open": "प्रलंबित",
  "handled": "पूर्ण",
  "markHandled": "पूर्ण म्हणून नोंदवा",
  "showHandled": "पूर्ण झालेल्या दाखवा ({{n}})",
  "hideHandled": "पूर्ण झालेल्या लपवा",
  "empty": "अद्याप कोणतीही विनंती नोंदवलेली नाही.",
  "loading": "लोड होत आहे…"
}
```

The hi and mr strings are AI-written and have not been reviewed by a native speaker, like the 204 keys already in those files. Say so in the commit body; do not present them as translated.

- [ ] **Step 4: Run the routes test to verify it passes**

Run: `cd web && npm test -- routes`
Expected: PASS.

- [ ] **Step 5: Write the screen**

Create `web/src/screens/Requests.tsx`. Before writing, open `web/src/screens/Customers.tsx` and follow its structure exactly — the `wanted` ref guard against overlapping fetches, the error banner shape, the `min-h-[44px]` touch targets, and how it reads `vendorId` from the session.

```tsx
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { listRequests, logRequest, markHandled, normaliseItemName, type StockRequest } from "../requests";
import { useSession } from "../components/SessionProvider";
import { describeError } from "../errors";
import "../i18n";

export default function Requests() {
  const { t } = useTranslation();
  const session = useSession();
  const [rows, setRows] = useState<StockRequest[]>([]);
  const [draft, setDraft] = useState("");
  const [showHandled, setShowHandled] = useState(false);
  const [busy, setBusy] = useState(true);
  const [problem, setProblem] = useState<{ key: string; detail: string } | null>(null);

  const load = useCallback(async () => {
    setBusy(true);
    const { data, error } = await listRequests();
    setBusy(false);
    setProblem(describeError(error));
    setRows((data ?? []) as StockRequest[]);
  }, []);

  useEffect(() => { void load(); }, [load]);

  const clean = normaliseItemName(draft);

  async function submit() {
    // vendorId lives only on the "ready" variant of the session union; narrowing here
    // is what makes it readable at all. App.tsx never renders a screen in another state,
    // so this guard is a type narrowing, not a runtime branch anyone reaches.
    if (clean === "" || session.kind !== "ready") return;
    setBusy(true);
    const { error } = await logRequest(session.vendorId, clean);
    setBusy(false);
    if (error) { setProblem(describeError(error)); return; }
    setDraft("");
    setProblem(null);
    await load();
  }

  async function handle(id: string) {
    const { error } = await markHandled(id);
    if (error) { setProblem(describeError(error)); return; }
    // Patch in place rather than refetching: the list can be 200 rows and the only
    // thing that changed is one field.
    setRows((all) => all.map((r) => (r.id === id ? { ...r, status: "handled" } : r)));
  }

  const open = rows.filter((r) => r.status === "open");
  const handled = rows.filter((r) => r.status === "handled");

  return (
    <div className="space-y-4">
      <div>
        <h2 className="font-semibold text-slate-800">{t("req.title")}</h2>
        <p className="text-xs text-slate-500">{t("req.hint")}</p>
      </div>

      <div className="flex gap-2">
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") void submit(); }}
          placeholder={t("req.placeholder")}
          data-testid="req-input"
          className="flex-1 border border-slate-300 rounded-lg px-3 min-h-[44px]"
        />
        <button
          onClick={() => void submit()}
          disabled={clean === "" || busy}
          data-testid="req-log"
          className="bg-green-600 text-white rounded-lg px-4 min-h-[44px] disabled:opacity-50"
        >
          {t("req.log")}
        </button>
      </div>

      {problem && (
        <div className="bg-red-50 border border-red-200 rounded-lg p-3">
          <p className="text-sm text-red-700">{t(problem.key)}</p>
          {problem.detail && (
            <p data-testid="req-problem-detail" className="text-xs text-red-600 mt-1 break-words">
              {t("error.details")}: {problem.detail}
            </p>
          )}
        </div>
      )}

      {busy && <p className="text-sm text-slate-500">{t("req.loading")}</p>}

      {!busy && rows.length === 0 && <p className="text-sm text-slate-500">{t("req.empty")}</p>}

      <ul className="space-y-2">
        {open.map((r) => (
          <li key={r.id} data-testid={`req-open-${r.id}`}
              className="bg-white border border-slate-200 rounded-xl p-3 flex items-center justify-between gap-3">
            <span className="text-slate-800 break-words">{r.item_name}</span>
            <button onClick={() => void handle(r.id)}
                    className="border border-slate-300 rounded-lg px-3 text-sm min-h-[44px] whitespace-nowrap">
              {t("req.markHandled")}
            </button>
          </li>
        ))}
      </ul>

      {handled.length > 0 && (
        <button onClick={() => setShowHandled((s) => !s)}
                data-testid="req-toggle-handled"
                className="text-sm text-slate-600 underline min-h-[44px]">
          {showHandled ? t("req.hideHandled") : t("req.showHandled", { n: handled.length })}
        </button>
      )}

      {showHandled && (
        <ul className="space-y-2">
          {handled.map((r) => (
            <li key={r.id} data-testid={`req-handled-${r.id}`}
                className="bg-slate-50 border border-slate-200 rounded-xl p-3 text-slate-500 line-through">
              {r.item_name}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
```

In `web/src/App.tsx`, add the route alongside the existing ones, following the exact lazy-loading and guard pattern the other screens use there.

- [ ] **Step 6: Verify the build and the whole web suite**

Run: `cd web && npm run build && npm test`
Expected: `tsc --noEmit` clean, vite build succeeds, all vitest cases pass.

- [ ] **Step 7: Commit**

```bash
git add web/src/screens/Requests.tsx web/src/routes.ts web/src/App.tsx web/src/i18n web/src/__tests__/routes.test.ts
git commit -m "feat: add the customer requests screen"
```

---

### Task 4: The dashboard requests card and the pair-name fix

**Files:**
- Modify: `web/src/history.ts:44-50` (the `Pair` type) and the `pairsBetween` region
- Modify: `web/src/screens/Dashboards.tsx`
- Modify: `web/src/i18n/{en,hi,mr}.json`
- Test: `web/src/__tests__/history.test.ts` and `web/src/__tests__/Dashboards.test.tsx` (extend both)

**Interfaces:**
- Consumes: `stock_requests_between` and the rebuilt `bought_together_between` from Task 1; `itemName` from `web/src/i18n/locales.ts:22`.
- Produces:
  - `type Pair = { item_a: string; item_b: string; name_a_en: string; name_a_hi: string; name_a_mr: string; name_b_en: string; name_b_hi: string; name_b_mr: string; bill_count: number }`
  - `type RequestCount = { item_name: string; request_count: number | string; last_requested_at: string }` — `request_count` is a Postgres `bigint`, which PostgREST serialises as a string, so the type admits both and every read goes through `Number()`.
  - `requestsBetween(range: Range)` in `history.ts`

- [ ] **Step 1: Write the failing test**

Open `web/src/__tests__/Dashboards.test.tsx`, read how it stubs `history.ts`, and append a case in that file's style:

```tsx
it("renders pair names in the active language", async () => {
  // The regression this fixes: bought_together_between used to return only name_en, so
  // a Marathi admin saw Marathi in Top Items and English in the card directly below.
  await i18n.changeLanguage("mr");
  stubPairs([{
    item_a: "a1", item_b: "b1",
    name_a_en: "Onion", name_a_hi: "प्याज", name_a_mr: "कांदा",
    name_b_en: "Tomato", name_b_hi: "टमाटर", name_b_mr: "टोमॅटो",
    bill_count: 4,
  }]);

  render(<Dashboards />);
  expect(await screen.findByTestId("dash-pair-a1-b1")).toHaveTextContent("कांदा");
  expect(screen.getByTestId("dash-pair-a1-b1")).toHaveTextContent("टोमॅटो");
  expect(screen.getByTestId("dash-pair-a1-b1")).not.toHaveTextContent("Onion");
});

it("lists what customers asked for that the shop does not stock", async () => {
  stubRequests([
    { item_name: "dragon fruit", request_count: 11, last_requested_at: "2026-09-15T10:00:00Z" },
    { item_name: "kiwi", request_count: 3, last_requested_at: "2026-09-14T10:00:00Z" },
  ]);

  render(<Dashboards />);
  const card = await screen.findByTestId("dash-req-dragon fruit");
  expect(card).toHaveTextContent("dragon fruit");
  expect(card).toHaveTextContent("11");
});
```

Match the file's existing stub helpers rather than inventing `stubPairs`/`stubRequests` if it already has an equivalent — read it first and reuse what is there.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd web && npm test -- Dashboards`
Expected: FAIL — the pair case renders "Onion" because the component reads `p.name_a`, and the requests case fails because no such card exists.

- [ ] **Step 3: Update `history.ts`**

Replace the `Pair` type at `web/src/history.ts:44-50` with:

```typescript
export type Pair = {
  item_a: string;
  item_b: string;
  name_a_en: string;
  name_a_hi: string;
  name_a_mr: string;
  name_b_en: string;
  name_b_hi: string;
  name_b_mr: string;
  bill_count: number;
};

/** #10. `request_count` is a Postgres bigint, which PostgREST serialises as a STRING --
 *  Number() it before rendering or comparing. */
export type RequestCount = {
  item_name: string;
  request_count: number | string;
  last_requested_at: string;
};
```

Add alongside `pairsBetween`:

```typescript
export async function requestsBetween(range: Range) {
  const { fromTs, toTs } = toBounds(range);
  return supabase.rpc("stock_requests_between", { p_from: fromTs, p_to: toTs });
}
```

- [ ] **Step 4: Update `Dashboards.tsx`**

Extend the import from `../history` to include `requestsBetween` and `type RequestCount`.

Add state next to the others:

```tsx
  const [requests, setRequests] = useState<RequestCount[]>([]);
```

In `load`, add the fourth call to the `Promise.all` and set it:

```tsx
    const [money, items, together, asked] = await Promise.all([
      collectedBetween(r), topItemsBetween(r), pairsBetween(r), requestsBetween(r),
    ]);
```

```tsx
    setRequests((asked.data ?? []) as RequestCount[]);
```

and fold its error into the existing first-error-wins chain:

```tsx
    setProblem(
      describeError(money.error) ?? describeError(items.error)
        ?? describeError(together.error) ?? describeError(asked.error),
    );
```

Replace the pair `<span>` so both sides go through `itemName()`. `itemName` takes an object keyed `name_en`/`name_hi`/`name_mr`, which a flattened pair row is not — reshape each side at the call site rather than giving `itemName` a second signature:

```tsx
                <span className="text-slate-700">
                  {itemName({ name_en: p.name_a_en, name_hi: p.name_a_hi, name_mr: p.name_a_mr }, lang)}
                  {" + "}
                  {itemName({ name_en: p.name_b_en, name_hi: p.name_b_hi, name_mr: p.name_b_mr }, lang)}
                </span>
```

Add the fourth card after the bought-together one:

```tsx
      <Card title={t("dash.requests")} subtitle={t("dash.requestsSub")}>
        {requests.length === 0 ? (
          <p className="text-sm text-slate-500">{t("dash.empty")}</p>
        ) : (
          <ul className="space-y-1">
            {requests.map((r) => (
              <li key={r.item_name} data-testid={`dash-req-${r.item_name}`}
                  className="flex justify-between text-sm">
                <span className="text-slate-700 break-words">{r.item_name}</span>
                <span className="text-slate-600">
                  {t("dash.askedCount", { n: Number(r.request_count) })}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Card>
```

Add to the `dash` block of all three i18n files:

- `en.json`: `"requests": "Asked for, not stocked"`, `"requestsSub": "What customers wanted that you do not carry"`, `"askedCount": "{{n}} asked"`
- `hi.json`: `"requests": "मांगा गया, स्टॉक में नहीं"`, `"requestsSub": "ग्राहक जो चाहते थे पर आपके पास नहीं है"`, `"askedCount": "{{n}} ने मांगा"`
- `mr.json`: `"requests": "मागणी झाली, स्टॉक नाही"`, `"requestsSub": "ग्राहकांना हवे होते पण तुमच्याकडे नाही"`, `"askedCount": "{{n}} जणांनी मागितले"`

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd web && npm run build && npm test`
Expected: `tsc --noEmit` clean and all cases passing. If `history.test.ts` fails, it is asserting the old `name_a`/`name_b` — update those assertions to the new columns.

- [ ] **Step 6: Commit**

```bash
git add web/src/history.ts web/src/screens/Dashboards.tsx web/src/i18n web/src/__tests__
git commit -m "feat: show unstocked demand on the dashboard, and localise pair names"
```

---

### Task 5: The low-stock badge

**Files:**
- Create: `web/src/useLowStock.ts`
- Modify: `web/src/components/Shell.tsx:64-73` (the nav map)
- Modify: `web/src/i18n/{en,hi,mr}.json`

**Interfaces:**
- Consumes: the `v_low_stock` view from `0004_views.sql:46`; `supabase` from `web/src/supabase.ts`.
- Produces: `useLowStock(enabled: boolean): number` — the count of items under 10 kg, `0` while loading or on error.

- [ ] **Step 1: Write the hook**

There is no test for this one, and the plan says so plainly rather than pretending otherwise: the polling hook and the badge render are covered by nothing, the same position as the rest of the UI in this project. The count query is `v_low_stock`, which `tests/views.test.mjs` already exercises for correctness and cross-tenant isolation.

Create `web/src/useLowStock.ts`:

```typescript
import { useEffect, useState } from "react";
import { supabase } from "./supabase";

const EVERY_MS = 5 * 60 * 1000;

/**
 * #9, the low-stock bell. Polls rather than subscribing to Realtime.
 *
 * Stock crosses 10 kg a few times a day, and an admin who learns of it four minutes
 * later restocks at the same moment as one told instantly. Realtime buys nothing
 * operationally here and costs the riskiest thing in the slice: a Realtime policy that
 * mishandles vendor_id is a cross-tenant leak, which is the single failure the RLS suite
 * exists to prevent.
 *
 * The threshold lives in v_low_stock. The client never learns the number 10.
 */
export function useLowStock(enabled: boolean): number {
  const [count, setCount] = useState(0);

  useEffect(() => {
    if (!enabled) return;
    let alive = true;

    const read = async () => {
      const { count: n, error } = await supabase
        .from("v_low_stock")
        .select("id", { count: "exact", head: true });
      // A failed poll leaves the last good count on screen rather than flashing 0 --
      // a badge that blinks to zero on a dropped connection reads as "restocked".
      if (alive && !error && typeof n === "number") setCount(n);
    };

    void read();
    const timer = setInterval(() => void read(), EVERY_MS);
    window.addEventListener("focus", read);
    return () => {
      alive = false;
      clearInterval(timer);
      window.removeEventListener("focus", read);
    };
  }, [enabled]);

  return count;
}
```

- [ ] **Step 2: Render the badge in `Shell.tsx`**

Add the import:

```typescript
import { useLowStock } from "../useLowStock";
```

Inside the `Shell` component, above the `return`:

```tsx
  // Admin only: they are the role that restocks. A recorder told about low stock can
  // do nothing but worry about it.
  const lowStock = useLowStock(role === "admin");
```

In the nav map, replace `{t(r.labelKey)}` with:

```tsx
              <>
                {t(r.labelKey)}
                {r.path === "/items" && lowStock > 0 && (
                  <span
                    data-testid="low-stock-badge"
                    title={t("items.lowBadge", { n: lowStock })}
                    className="ml-1.5 bg-amber-500 text-white text-xs rounded-full px-1.5 py-0.5 min-w-[1.25rem] text-center"
                  >
                    {lowStock}
                  </span>
                )}
              </>
```

Add to the `items` block of all three i18n files:

- `en.json`: `"lowBadge": "{{n}} items low on stock"`
- `hi.json`: `"lowBadge": "{{n}} सामान स्टॉक में कम हैं"`
- `mr.json`: `"lowBadge": "{{n}} वस्तूंचा साठा कमी आहे"`

- [ ] **Step 3: Verify the build and the whole web suite**

Run: `cd web && npm run build && npm test`
Expected: `tsc --noEmit` clean and every existing case still passing. `Shell` is rendered by several component tests; if any now fails on an unmocked `v_low_stock` query, add it to that test file's existing supabase stub rather than changing the hook.

- [ ] **Step 4: Commit**

```bash
git add web/src/useLowStock.ts web/src/components/Shell.tsx web/src/i18n
git commit -m "feat: badge the Items nav when stock runs low"
```

---

### Task 6: Full verification and deploy

**Files:** none changed unless verification surfaces a problem.

- [ ] **Step 1: Run the database suite**

Run: `npm test` (repo root)
Expected: every case passing, 0 failures, exit 0. Read the skip banner it prints — `pg_cron` and the Vault/`pg_net` shims are expected skips, nothing new should appear there.

- [ ] **Step 2: Run the web suite and the type check**

Run: `cd web && npm run build && npm test`
Expected: `tsc --noEmit` clean, vite build succeeds, every case passing.

> **Local `tsc` clean does not mean CI clean.** TypeScript 7 is a per-platform native binary and the Linux build in CI has rejected code this Windows machine accepted. Treat a green local build as necessary, not sufficient.

- [ ] **Step 3: Update the README**

`README.md` opens with "✅ Verified: 128 cases, 0 failures" and a list of what the suite covers. Update the count to what Step 1 actually printed — copy the number, do not estimate — and add a bullet to the covered list:

```markdown
- **Staff-logged stock requests.** The insert policy admits recorder and admin and
  refuses biller and cross-tenant writes; status flips `open` to `handled` and rejects
  anything else; blank names are refused by a check constraint; the dropped delete
  policy is pinned, because deleting a handled request would destroy the demand history
  that #10 reports. `stock_requests_between()` folds case, respects its date bounds, and
  does not leak across vendors.
```

Also update the migration count in the paragraph under that heading — it says "all twelve migrations" and there are now thirteen.

- [ ] **Step 4: Commit the README**

```bash
git add README.md
git commit -m "docs: record the stock-requests coverage in the suite"
```

- [ ] **Step 5: Deploy**

The deploy order for this project is **functions → db push → git push**. This slice adds no Edge Function, so:

```bash
npx supabase db push
git push
```

Then, signed in to Cloud as an admin: open `/requests`, log an item, confirm it appears as open, mark it handled, and confirm the dashboard's new card counts it under the current date range. Drop an item's stock under 10 kg and confirm the Items nav badge appears.

> **Confirm which project the SQL editor is pointed at before running anything by hand.** The test suite wipes its database on every run and is barred from reaching Cloud; that guard does not protect a browser tab.

---

## Notes for the executor

**Do not "fix" these — they are deliberate:**

- `v_stock_request_counts` is left in place, unfiltered and unread. Removing it is not this slice's business.
- "dragon fruit" and "dragonfruit" count separately. Fuzzy matching is explicitly out of scope; the item_name edit path is the mitigation.
- The bell polls. Do not convert it to a Realtime subscription.
- `stock_requests_between()` ignores `status`. Handling a request does not un-ask it.
- Handled requests collapse behind a toggle rather than disappearing.

**If a task's test passes before you write the implementation**, stop — the test is not testing what it claims. Fix the test first.
