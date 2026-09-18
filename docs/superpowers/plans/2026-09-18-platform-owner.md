# Platform Owner Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the app owner a login above every shop that can create a vendor with its first admin, see a per-vendor summary, and suspend or reinstate a vendor.

**Architecture:** Migration `0019_platform_owner.sql` adds `platform_owners`, `is_platform_owner()`, `vendors.suspended_at` with a guard trigger, redefines `current_user_role()` to return the sentinel `suspended` for a suspended shop, and adds `owner_vendor_summary()`. Two Edge Functions (`owner-create-vendor`, `owner-suspend-vendor`) hold the service-role work with pure `guards.ts` validation. The web gains `owner` and `suspended` session kinds, an Owner console screen, and an `ownerApi` module.

**Tech Stack:** Postgres 17 / plpgsql; Node test runner in `tests/` (native Postgres, pooled RLS-scoped clients, shim `auth.users`); Deno Edge Functions (not runnable locally; only `guards.ts` is unit-tested from the web suite); React + TS + Vite + vitest + react-i18next in `web/`.

**Spec:** `docs/superpowers/specs/2026-09-18-platform-owner-design.md`

## Global Constraints

- Owners are rows in `platform_owners`; an owner is never an `app_users` row. RLS policies in 0002 are not modified.
- `current_user_role()` returns exactly `'suspended'` (non-null) for a caller whose vendor has `suspended_at is not null`; otherwise unchanged. `current_vendor_id()` is unchanged.
- `vendors.suspended_at` may change only when `auth.uid() is null` (service role) or `is_platform_owner()`; otherwise sqlstate `42501`, message `only the platform owner may suspend a shop`.
- `owner_vendor_summary()` raises `42501` for any caller who is not an owner. "This month" is the calendar month in `Asia/Kolkata`.
- Edge Function error codes are exactly: create → `bad_request | not_owner | email_taken | weak_password | vendor_failed | create_failed | link_failed`; suspend → `bad_request | not_owner | not_found | update_failed`. Owner check reads `platform_owners` under the CALLER's JWT, never trusting the body. `MIN_PASSWORD_LENGTH = 8`. Both functions set `verify_jwt = true` in `supabase/config.toml`.
- Ban duration for suspend is the string `876000h`; reinstate uses `none`.
- New i18n keys in all three of `en.json`, `hi.json`, `mr.json` with identical key sets; hi sentences end `।`, mr `.`.
- PostgREST serialises numeric as strings; `Number()` every numeric in the web.
- Commit messages end with a blank line then a `Co-Authored-By:` trailer naming the model that wrote the commit.
- Do not change any database server setting. Deployment (Cloud SQL, function deploy, first owner insert, push) is the owner's step after the plan.

## File Structure

| File | Change | Responsibility |
|---|---|---|
| `supabase/migrations/0019_platform_owner.sql` | Create | table, helper, column, trigger, role sentinel, summary |
| `tests/platform_owner.test.mjs` | Create | all DB behaviour above |
| `tests/seed.mjs` | Modify | export `makeAuthUser(email, name)` (auth row + signed-in client, no `app_users` row) |
| `tests/run.mjs` | Modify | one import |
| `supabase/functions/owner-create-vendor/{guards.ts,index.ts}` | Create | validation + privileged flow |
| `supabase/functions/owner-suspend-vendor/{guards.ts,index.ts}` | Create | validation + privileged flow |
| `supabase/config.toml` | Modify | two `[functions.*]` entries |
| `web/src/__tests__/ownerGuards.test.ts` | Create | pure guard tests |
| `web/src/session.ts`, `web/src/components/SessionProvider.tsx`, `web/src/App.tsx` | Modify | `owner` / `suspended` kinds and panels |
| `web/src/ownerRules.ts`, `web/src/ownerApi.ts`, `web/src/screens/OwnerConsole.tsx` | Create | console |
| `web/src/i18n/{en,hi,mr}.json` | Modify | `owner.*`, `session.suspended*` |
| `web/src/__tests__/{session,SessionProvider,App,ownerRules,ownerApi,OwnerConsole}.test.*` | Create/Modify | web tests |
| `docs/runbook-first-admin.md` → `docs/runbook-platform-owner.md` | Rename + rewrite | bootstrap is one owner insert |
| `README.md` | Modify | count and coverage |

---

### Task 1: `platform_owners`, suspension flag, role sentinel

**Files:**
- Create: `supabase/migrations/0019_platform_owner.sql`, `tests/platform_owner.test.mjs`
- Modify: `tests/seed.mjs` (export `makeAuthUser`), `tests/run.mjs` (after `import "./item_units_functions.test.mjs";`)

**Interfaces:**
- Consumes: shim `auth.users`; `seedTwoVendors()`; `sql()`; `newClient()`, `serviceClient()` from fixtures; the module-local `makeUser` in seed.mjs (refactor: extract the auth-row-plus-sign-in part into an exported `makeAuthUser(email, name)` returning `{ id, client }`, and have `makeUser` call it then insert `app_users`).
- Produces: table `platform_owners`; `is_platform_owner()`; `vendors.suspended_at`; trigger `vendors_suspension_guard`; redefined `current_user_role()`.

- [ ] **Step 1: Failing tests** — `tests/platform_owner.test.mjs`:

```js
import { test, assert, assertDenied, assertInvisible, assertEqual, once } from "./framework.mjs";
import { sql, newClient } from "./fixtures.mjs";
import { seedTwoVendors, makeAuthUser } from "./seed.mjs";

let seq = 0;
async function world() {
  const w = await seedTwoVendors();
  const n = ++seq;
  const owner = await makeAuthUser(`owner-${n}@example.test`, "Owner");
  await sql(`insert into platform_owners (user_id, name) values ($1,'Owner')`, [owner.id]);
  const outsider = await makeAuthUser(`outsider-${n}@example.test`, "Nobody");
  return { ...w, owner, outsider };
}
const getW = once(world);
const roleOf = async (client) => (await client.rpc("current_user_role")).data;

test("an owner reads only their own platform_owners row; staff and outsiders see none", async () => {
  const w = await getW();
  const { data } = await w.owner.client.from("platform_owners").select("user_id");
  assertEqual(data.length, 1, "owner sees own row");
  assertEqual(data[0].user_id, w.owner.id, "own row");
  assertInvisible((await w.a.clients.admin.from("platform_owners").select("user_id")).data, "admin read owners");
  assertInvisible((await w.outsider.client.from("platform_owners").select("user_id")).data, "outsider read owners");
  const anon = await newClient();
  assertInvisible((await anon.from("platform_owners").select("user_id")).data, "anon read owners");
});

test("nobody can insert into platform_owners from a client", async () => {
  const w = await getW();
  for (const c of [w.owner.client, w.a.clients.admin, w.outsider.client]) {
    const { error } = await c.from("platform_owners").insert({ user_id: w.outsider.id, name: "X" });
    assertDenied(error, "client inserted an owner");
  }
});

test("is_platform_owner answers for the caller", async () => {
  const w = await getW();
  assertEqual((await w.owner.client.rpc("is_platform_owner")).data, true, "owner");
  assertEqual((await w.a.clients.admin.rpc("is_platform_owner")).data, false, "admin");
  assertEqual((await w.outsider.client.rpc("is_platform_owner")).data, false, "outsider");
});

test("a shop admin cannot suspend or reinstate their own shop", async () => {
  const w = await getW();
  const { error } = await w.a.clients.admin.from("vendors").update({ suspended_at: new Date().toISOString() }).eq("id", w.a.vendorId).select("id");
  assert(error || true, "");   // either refused or filtered; the row must be unchanged:
  const { rows: [v] } = await sql(`select suspended_at from vendors where id=$1`, [w.a.vendorId]);
  assertEqual(v.suspended_at, null, "admin set suspended_at");
  if (error) assert(/only the platform owner/.test(error.message) || error.code === "42501", error.message);
});

test("suspension flips current_user_role to the sentinel and blocks every write path; the other shop is untouched", async () => {
  const w = await getW();
  assertEqual(await roleOf(w.a.clients.recorder), "recorder", "before");
  await sql(`update vendors set suspended_at = now() where id=$1`, [w.a.vendorId]);   // owner-role SQL stands in for the Edge Function
  try {
    assertEqual(await roleOf(w.a.clients.recorder), "suspended", "sentinel");
    assertEqual(await roleOf(w.a.clients.admin), "suspended", "admin sentinel");
    // Reads still work until the token lapses; the spec accepts this window.
    const { data: items } = await w.a.clients.recorder.from("items").select("id");
    assert(items.length >= 1, "reads should still return the shop's rows");
    // Writes refused.
    const cust = await w.a.clients.recorder.from("customers").insert({ vendor_id: w.a.vendorId, name: "S", flat_no: "1", mobile: "+919000000001" });
    assertDenied(cust.error, "suspended recorder created a customer");
    const bill = await w.a.clients.recorder.from("bills").insert({ vendor_id: w.a.vendorId, customer_id: w.a.customerId, recorder_id: w.a.recorderId, status: "recording" });
    assertDenied(bill.error, "suspended recorder opened a bill");
    const item = await w.a.clients.admin.from("items").update({ price: 1 }).eq("id", w.a.itemId).select("id");
    assert(item.error || item.data.length === 0, "suspended admin changed a price");
    // A bill created BEFORE suspension cannot move through the lifecycle.
    const { rows: [b] } = await sql(`insert into bills (vendor_id, customer_id, recorder_id, total, status) values ($1,$2,$3,0,'recording') returning id`, [w.a.vendorId, w.a.customerId, w.a.recorderId]);
    const lines = await w.a.clients.recorder.rpc("replace_bill_lines", { p_bill_id: b.id, p_lines: [{ item_id: w.a.itemId, qty_kg: 1, unit_price: 40 }] });
    assertDenied(lines.error, "suspended recorder wrote lines");
    await sql(`insert into bill_items (bill_id, vendor_id, item_id, qty_kg, unit_price, line_total) values ($1,$2,$3,1,40,40)`, [b.id, w.a.vendorId, w.a.itemId]);
    const tok = await w.a.clients.recorder.rpc("issue_token", { p_bill_id: b.id });
    assertDenied(tok.error, "suspended recorder issued a token");
    await sql(`select issue_token($1)`, [b.id]);
    const done = await w.a.clients.biller.rpc("complete_bill", { p_bill_id: b.id });
    assertDenied(done.error, "suspended biller completed a bill");
    const mv = await w.a.clients.recorder.rpc("log_stock_movement", { p_item_id: w.a.itemId, p_kind: "purchase", p_qty_kg: 1, p_unit_cost: 1 });
    assertDenied(mv.error, "suspended recorder logged stock");
    // Vendor B carries on.
    const ok = await w.b.clients.recorder.from("customers").insert({ vendor_id: w.b.vendorId, name: "Fine", flat_no: "2", mobile: "+919000000002" });
    assert(!ok.error, `vendor B blocked: ${ok.error?.message}`);
  } finally {
    await sql(`update vendors set suspended_at = null where id=$1`, [w.a.vendorId]);
  }
  assertEqual(await roleOf(w.a.clients.recorder), "recorder", "reinstated");
  const again = await w.a.clients.recorder.from("customers").insert({ vendor_id: w.a.vendorId, name: "Back", flat_no: "3", mobile: "+919000000003" });
  assert(!again.error, `reinstated recorder still blocked: ${again.error?.message}`);
});

test("void_bill is refused for a suspended shop", async () => {
  const w = await getW();
  const { rows: [b] } = await sql(`insert into bills (vendor_id, customer_id, total, status) values ($1,$2,0,'recording') returning id`, [w.a.vendorId, w.a.customerId]);
  await sql(`insert into bill_items (bill_id, vendor_id, item_id, qty_kg, unit_price, line_total) values ($1,$2,$3,1,40,40)`, [b.id, w.a.vendorId, w.a.itemId]);
  await sql(`select issue_token($1)`, [b.id]); await sql(`select complete_bill($1)`, [b.id]);
  await sql(`update vendors set suspended_at = now() where id=$1`, [w.a.vendorId]);
  try {
    const { error } = await w.a.clients.admin.rpc("void_bill", { p_bill_id: b.id, p_reason: "x" });
    assertDenied(error, "suspended admin voided a bill");
  } finally { await sql(`update vendors set suspended_at = null where id=$1`, [w.a.vendorId]); }
});
```

Remove the odd `assert(error || true, "")` line from the admin-suspend test and keep the row-unchanged assertion plus the conditional message check. `seed.mjs`: extract `makeAuthUser` (creates the auth user via the service client, signs in a new client, returns `{ id, client }`) and make `makeUser` call it before inserting `app_users`. Add `import "./platform_owner.test.mjs";` to run.mjs.

- [ ] **Step 2: Run** `npm test` — new cases fail (no table/column/function); 225 existing pass.

- [ ] **Step 3: Migration**

```sql
-- Platform owner: the person above every shop.
-- Spec: docs/superpowers/specs/2026-09-18-platform-owner-design.md
--
-- Owners are NOT app_users rows: every policy keys on vendor_id and an owner has none.
-- The first owner row is inserted by hand once (docs/runbook-platform-owner.md), exactly
-- as the first admin used to be.

create table platform_owners (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  name       text not null,
  created_at timestamptz not null default now()
);
alter table platform_owners enable row level security;
create policy owners_read_self on platform_owners for select to authenticated
  using (user_id = auth.uid());
-- No insert/update/delete policy on purpose.

create function is_platform_owner() returns boolean
  language sql stable security definer set search_path = public as $$
  select exists (select 1 from platform_owners where user_id = auth.uid())
$$;
revoke all on function is_platform_owner() from public, anon;
grant execute on function is_platform_owner() to authenticated;

-- Suspension. The flag is authoritative; the Edge Function also bans sign-ins.
alter table vendors add column suspended_at timestamptz;

create function vendors_suspension_guard() returns trigger language plpgsql as $$
begin
  if new.suspended_at is distinct from old.suspended_at
     and auth.uid() is not null and not is_platform_owner() then
    raise exception 'only the platform owner may suspend a shop' using errcode = '42501';
  end if;
  return new;
end $$;
create trigger vendors_suspension_guard before update on vendors
  for each row execute function vendors_suspension_guard();

-- The enforcement point. Every write policy in 0002 and every billing function checks
-- the role; returning a sentinel that is none of admin/recorder/biller refuses them all at
-- once. It is a non-null string ON PURPOSE: `null not in (...)` is null, and an `if` on
-- null does not fire, so a null here would let issue_token() and friends through.
-- Read policies key on vendor_id only and keep working until the token lapses (<= 1h);
-- the spec accepts that window because the Edge Function also bans new sign-ins.
create or replace function current_user_role() returns text
  language sql stable security definer set search_path = public as $$
  select case when v.suspended_at is not null then 'suspended' else u.role end
    from app_users u join vendors v on v.id = u.vendor_id
   where u.id = auth.uid()
$$;
```

Grant lines for `current_user_role` were set in 0002; `create or replace` keeps them. Check 0002 for its grants and re-issue them if any exist.

- [ ] **Step 4: Run** — all pass (225 + 6 = 231). `rls.test.mjs` must still pass: for an active shop the helper returns the same values as before.
- [ ] **Step 5: Commit** `feat: platform owners and shop suspension enforced in the role helper`.

---

### Task 2: `owner_vendor_summary()`

**Files:** append to `0019_platform_owner.sql`; extend `tests/platform_owner.test.mjs`.

**Interfaces:** produces `owner_vendor_summary() returns table (id uuid, name text, created_at timestamptz, suspended_at timestamptz, staff_count bigint, bills_month bigint, sales_month numeric, last_bill_at timestamptz)`.

- [ ] **Step 1: Failing tests** (append):

```js
test("owner_vendor_summary refuses staff and outsiders", async () => {
  const w = await getW();
  assertDenied((await w.a.clients.admin.rpc("owner_vendor_summary")).error, "admin read the summary");
  assertDenied((await w.outsider.client.rpc("owner_vendor_summary")).error, "outsider read the summary");
});

test("owner_vendor_summary lists every vendor with staff, this-month bills and sales", async () => {
  const w = await getW();
  // One done bill in vendor A this month: 2 x 40 = 80.
  const { rows: [b] } = await sql(`insert into bills (vendor_id, customer_id, total, status) values ($1,$2,0,'recording') returning id`, [w.a.vendorId, w.a.customerId]);
  await sql(`insert into bill_items (bill_id, vendor_id, item_id, qty_kg, unit_price, line_total) values ($1,$2,$3,2,40,80)`, [b.id, w.a.vendorId, w.a.itemId]);
  await sql(`select issue_token($1)`, [b.id]); await sql(`select complete_bill($1)`, [b.id]);
  // An old bill last month must not count.
  await sql(`insert into bills (vendor_id, customer_id, total, status, completed_at) values ($1,$2,999,'done', (date_trunc('month', now() at time zone 'Asia/Kolkata') - interval '1 day') at time zone 'Asia/Kolkata')`, [w.a.vendorId, w.a.customerId]);
  const { data, error } = await w.owner.client.rpc("owner_vendor_summary");
  assert(!error, error?.message);
  const a = data.find((r) => r.id === w.a.vendorId);
  const bRow = data.find((r) => r.id === w.b.vendorId);
  assert(a && bRow, "both seeded vendors listed");
  assertEqual(Number(a.staff_count), 3, "A has admin, recorder, biller");
  assert(Number(a.bills_month) >= 1, "this month's bill counted");
  assert(Number(a.sales_month) >= 80 && Number(a.sales_month) < 999, "sales exclude last month's 999");
  assert(a.last_bill_at !== null, "last_bill_at");
  assertEqual(a.suspended_at, null, "not suspended");
  assertEqual(Number(bRow.bills_month), Number(bRow.bills_month), "B row present");
});
```

- [ ] **Step 2: Run** — fail (function missing).
- [ ] **Step 3: Append**

```sql
create function owner_vendor_summary()
  returns table (
    id uuid, name text, created_at timestamptz, suspended_at timestamptz,
    staff_count bigint, bills_month bigint, sales_month numeric, last_bill_at timestamptz
  )
  language plpgsql stable security definer set search_path = public as $$
declare
  v_from timestamptz := (date_trunc('month', now() at time zone 'Asia/Kolkata')) at time zone 'Asia/Kolkata';
begin
  if not is_platform_owner() then
    raise exception 'only the platform owner may list shops' using errcode = '42501';
  end if;
  return query
    select v.id, v.name, v.created_at, v.suspended_at,
           (select count(*) from app_users u where u.vendor_id = v.id),
           (select count(*) from bills b where b.vendor_id = v.id and b.status = 'done' and b.completed_at >= v_from),
           (select coalesce(sum(b.total), 0) from bills b where b.vendor_id = v.id and b.status = 'done' and b.completed_at >= v_from),
           (select max(b.completed_at) from bills b where b.vendor_id = v.id and b.status = 'done')
      from vendors v
     order by v.name, v.id;
end $$;
revoke all on function owner_vendor_summary() from public, anon;
grant execute on function owner_vendor_summary() to authenticated;
```

- [ ] **Step 4: Run** — 231 + 2 = 233.
- [ ] **Step 5: Commit** `feat: owner_vendor_summary for the owner console`.

---

### Task 3: Edge Functions `owner-create-vendor` and `owner-suspend-vendor`

**Files:**
- Create: `supabase/functions/owner-create-vendor/guards.ts`, `index.ts`; `supabase/functions/owner-suspend-vendor/guards.ts`, `index.ts`
- Modify: `supabase/config.toml` (two entries with `verify_jwt = true` and a one-line comment each, in the style of the existing entries)
- Create: `web/src/__tests__/ownerGuards.test.ts`

**Interfaces (produced):**
- `owner-create-vendor/guards.ts`: `MIN_PASSWORD_LENGTH = 8`; `type CreateVendorRequest = { vendor: { name: string; address: string | null; phone: string | null }; admin: { name: string; email: string; password: string } }`; `type ErrorCode = "bad_request" | "not_owner" | "email_taken" | "weak_password" | "vendor_failed" | "create_failed" | "link_failed"`; `validateCreateVendorRequest(body: unknown): { ok: true; value } | { ok: false; code: ErrorCode; field?: string }` — trims names/address/phone (empty → null for the optional two), lowercases+trims email, does NOT trim password; refuses blank vendor name, blank admin name, bad email, short password.
- `owner-suspend-vendor/guards.ts`: `type SuspendRequest = { vendor_id: string; action: "suspend" | "reinstate" }`; `type ErrorCode = "bad_request" | "not_owner" | "not_found" | "update_failed"`; `validateSuspendRequest(body)` — uuid shape for `vendor_id`, action in the two values. `BAN_DURATION = "876000h"`, `UNBAN = "none"` exported constants.
- `index.ts` for both: copy the structure of `supabase/functions/admin-create-user/index.ts` (CORS block, `fail()`, OPTIONS, POST only, Authorization present, caller client with anon key + caller's Authorization header, `getUser()`), then the owner check: `callerClient.from("platform_owners").select("user_id").eq("user_id", user.id).maybeSingle()` → not a row → `not_owner` 403. Then the service-role flow per the spec, with compensation and `console.error` logging exactly as admin-create-user does.

- [ ] **Step 1: Failing tests** — `web/src/__tests__/ownerGuards.test.ts` importing both guards via relative paths like `guards.test.ts` does: accepts a good create body (address/phone omitted → null); rejects non-object bodies; blank vendor name → `bad_request` field `vendor.name`; blank admin name → field `admin.name`; bad email → field `admin.email`; 7-char password → `weak_password`; password not trimmed; email lowercased. Suspend: accepts `{ vendor_id: <uuid>, action: "suspend" }` and `"reinstate"`; rejects a non-uuid id and an unknown action with `bad_request`; constants equal `"876000h"` and `"none"`.
- [ ] **Step 2: Run** in `web/` — fail (modules missing).
- [ ] **Step 3: Implement** guards, then both `index.ts` files, then config.toml. In `owner-create-vendor/index.ts` the compensation order is: link failed → delete auth user → delete vendor; create failed → delete vendor. Return `{ vendor_id, admin_id }` 200. In `owner-suspend-vendor/index.ts`: update `vendors` set `suspended_at` (now ISO string or null) where id → if zero rows `not_found` 404; then list `app_users` ids for the vendor and call `auth.admin.updateUserById(id, { ban_duration })` for each, counting successes and failures; return `{ banned, failed }` 200 and `console.error` each failure.
- [ ] **Step 4: Run** `npm test` and `npm run build` in `web/` — green. Also run `deno check supabase/functions/owner-create-vendor/index.ts supabase/functions/owner-suspend-vendor/index.ts` if `deno` is on PATH; if it is not, say so in the report (the existing functions have the same limitation).
- [ ] **Step 5: Commit** `feat: owner-create-vendor and owner-suspend-vendor Edge Functions`.

---

### Task 4: Session kinds `owner` and `suspended`

**Files:** `web/src/session.ts`, `web/src/components/SessionProvider.tsx`, `web/src/App.tsx`, tests `session.test.ts`, `SessionProvider.test.tsx`, `App.test.tsx`, i18n.

**Interfaces (produced):**
- `SessionState` gains `{ kind: "owner"; userId: string; email: string; name: string }` and `{ kind: "suspended"; email: string; vendorName: string }`.
- `AppUserRow.vendors` becomes `{ name: string; suspended_at: string | null } | null`; the provider's select becomes `"name, role, vendor_id, must_change_password, vendors(name, suspended_at)"`.
- `sessionFromRow(userId, email, row)` returns `suspended` when `row.vendors?.suspended_at` is non-null, checked BEFORE `mustChangePassword`.
- New pure `sessionFromOwnerRow(userId, email, ownerRow: { name: string } | null)` returns `owner` or `unmapped`.
- Provider: when the `app_users` read returns a clean null, read `platform_owners` (`select("name").eq("user_id", userId).maybeSingle()`); error → `error`; row → `owner`; null → `unmapped`.
- `App.tsx`: `owner` → `<OwnerConsole />` (created as a placeholder component in this task exporting a heading with `data-testid="owner-console"` — Task 5 fills it); `suspended` → `<Suspended vendorName email />` panel with `data-testid="session-suspended"`, `t("session.suspendedTitle")`, `t("session.suspended", { vendor, email })`, and a sign-out button.
- i18n: `session.suspendedTitle` en "This shop is suspended", hi "यह दुकान निलंबित है", mr "हे दुकान स्थगित केले आहे"; `session.suspended` en "{{vendor}} has been suspended by the app owner. You are signed in as {{email}}. Contact the app owner to reinstate the shop.", hi "{{vendor}} को ऐप मालिक ने निलंबित कर दिया है। आप {{email}} से साइन इन हैं। दुकान फिर से चालू करने के लिए ऐप मालिक से संपर्क करें।", mr "{{vendor}} ॲप मालकाने स्थगित केले आहे. तुम्ही {{email}} ने साइन इन आहात. दुकान पुन्हा सुरू करण्यासाठी ॲप मालकाशी संपर्क करा."

- [ ] **Step 1: Failing tests**: `session.test.ts` — suspended row → `suspended` with vendor name, even when `must_change_password` is true; `sessionFromOwnerRow` both branches. `SessionProvider.test.tsx` — read the file's `from` mock first; add: app_users null + platform_owners row → `owner`; app_users null + owners null → `unmapped`; app_users null + owners error → `error`. `App.test.tsx` — `owner` renders `owner-console`; `suspended` renders `session-suspended` with the vendor name and no nav.
- [ ] **Step 2: Run** — fail.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm test`, `npm run build` — green.
- [ ] **Step 5: Commit** `feat: owner and suspended session kinds`.

---

### Task 5: Owner console

**Files:** `web/src/ownerRules.ts`, `web/src/ownerApi.ts`, `web/src/screens/OwnerConsole.tsx` (replace the placeholder), tests `ownerRules.test.ts`, `ownerApi.test.ts`, `OwnerConsole.test.tsx`, i18n `owner.*`.

**Interfaces (produced):**
- `ownerRules.ts`: `type NewVendorInput = { vendorName: string; address: string; phone: string; adminName: string; email: string; password: string }`; `validateNewVendor(input)` → `{ ok: true; value: CreateVendorRequest-shaped { vendor: { name, address|null, phone|null }, admin: { name, email, password } } } | { ok: false; errors: Partial<Record<keyof NewVendorInput, string>> }` with keys `owner.required`, `owner.badEmail`, `owner.weakPassword` (min 8, the same constant imported from the function's guards, as `adminRules` does for staff).
- `ownerApi.ts`: `type VendorSummary = { id; name; created_at; suspended_at: string | null; staff_count: string | number; bills_month: string | number; sales_month: string | number; last_bill_at: string | null }`; `listVendorSummary()` → `supabase.rpc("owner_vendor_summary")`; `createVendor(value)` and `setVendorSuspended(vendorId, action)` invoking the two functions with `codeFrom`-style mapping (copy the helper pattern from adminApi.ts; do not import adminApi's private function — extract `codeFrom` into a shared `functionErrors.ts` used by both, keeping adminApi's behaviour identical). Key maps: create → `not_owner: error.notAllowed`, `email_taken: error.emailTaken`, `weak_password: error.weakPassword`, `bad_request: error.unknown`, `vendor_failed: owner.vendorNotCreated`, `create_failed: owner.adminNotCreated`, `link_failed: owner.vendorPartlyCreated`; suspend → `not_owner: error.notAllowed`, `bad_request: error.unknown`, `not_found: owner.vendorNotFound`, `update_failed: error.unknown`.
- `OwnerConsole.tsx`: header (`t("owner.title")`, owner name, sign out via `supabase.auth.signOut()`); table/list of vendors (`data-testid="owner-vendor-<id>"`) with name, created date, staff count, bills and sales this month (`rupees`), last bill time or "—", a state badge (`owner.active` / `owner.suspendedBadge`), and a button `owner-suspend-<id>` / `owner-reinstate-<id>` that opens a confirm block (`owner-confirm`, `owner-cancel`); "Add vendor" button opens the form (`owner-add`), fields with labels and testids `owner-vendorName`, `owner-address`, `owner-phone`, `owner-adminName`, `owner-email`, `owner-password`, submit `owner-save`; success line `owner-created` with `t("owner.created", { vendor, email })`; problem box `owner-problem`. Reload the list after create and after suspend/reinstate. Loading and empty states.
- i18n `owner` block (en; hi/mr AI-written with matching keys, hi `।`, mr `.`): `title` "Owner console", `vendors` "Shops", `add` "Add shop", `vendorName` "Shop name", `address` "Address (optional)", `phone` "Phone (optional)", `adminName` "Admin name", `email` "Admin email", `password` "First password", `save` "Create shop", `cancel` "Cancel", `created` "{{vendor}} created. {{email}} must change the password on first sign-in.", `staff` "{{n}} staff", `billsMonth` "{{n}} bills this month", `salesMonth` "Sales this month", `lastBill` "Last bill", `never` "No bills yet", `active` "Active", `suspendedBadge` "Suspended", `suspend` "Suspend", `reinstate` "Reinstate", `confirmSuspend` "Suspend {{vendor}}? Its staff will be signed out and cannot record or bill until reinstated.", `confirmReinstate` "Reinstate {{vendor}}?", `confirm` "Yes, do it", `empty` "No shops yet.", `loading` "Loading…", `required` "This field is required.", `badEmail` "Enter a valid email.", `weakPassword` "At least 8 characters.", `vendorNotCreated` "The shop could not be created. Nothing was saved.", `adminNotCreated` "The admin account could not be created. The shop was removed again.", `vendorPartlyCreated` "The admin account was created but could not be linked. Contact support before retrying.", `vendorNotFound` "That shop no longer exists."

- [ ] **Step 1: Failing tests**: `ownerRules.test.ts` (each rule; address/phone blank → null); `ownerApi.test.ts` (rpc name; invoke names and bodies; code mapping for `not_owner`, `email_taken`, `link_failed`, `not_found`, offline); `OwnerConsole.test.tsx` (mock `../ownerApi` and `../supabase` signOut; list renders two vendors with counts and badges; add form validates and calls `createVendor` with the exact body and shows `owner-created`; suspend opens confirm, confirm calls `setVendorSuspended(id, "suspend")` and reloads; a suspended row shows Reinstate).
- [ ] **Step 2: Run** — fail.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm test`, `npm run build` — green.
- [ ] **Step 5: Commit** `feat: owner console to onboard, watch and suspend shops`.

---

### Task 6: Runbook, README and full verification

- [ ] `git mv docs/runbook-first-admin.md docs/runbook-platform-owner.md`; rewrite it: why the first OWNER row is placed by hand (same RLS reasoning, now for `platform_owners`), the three bootstrap steps (add user in Auth → `insert into platform_owners` → sign in and see the console), how vendors are created from the console, how suspend works and its ≤1h read window, and how to deploy the two functions. Update any link to the old filename (grep README and docs).
- [ ] Run `npm test` (root), `npm test` and `npm run build` in `web/`; record real counts.
- [ ] README: case count, "nineteen migrations", and a Covered bullet:

```markdown
- **Platform owner.** `platform_owners` is readable only by its own row's user and written
  by nobody from a client. `is_platform_owner()` gates `owner_vendor_summary()`, which
  refuses staff and lists every shop with staff, this-month bills and sales. Suspending a
  shop makes `current_user_role()` return `suspended`, which every write policy and every
  billing function refuses at once while the other shop is untouched; reinstating restores
  them. A shop admin cannot change `suspended_at`.
```

- [ ] Commit `docs: platform owner runbook and coverage`.

## After the plan (owner)

1. Apply `0019_platform_owner.sql` on the vendor-app project as one script; insert `('0019','platform_owner')` into `supabase_migrations.schema_migrations`.
2. Deploy `owner-create-vendor` and `owner-suspend-vendor` (CLI or dashboard editor); confirm `verify_jwt` is on for both.
3. Authentication → Add user for your owner email; then `insert into platform_owners (user_id, name) values ((select id from auth.users where email = '<you>'), '<name>');`.
4. Merge and push; sign in as the owner and create a test shop.
