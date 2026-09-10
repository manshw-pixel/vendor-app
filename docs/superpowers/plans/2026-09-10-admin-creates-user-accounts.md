# Admin-Created User Accounts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An admin fills in email, password, name and role in Settings → Staff; the person signs in with those credentials, is forced to change the password once, and lands in the shop already attached to it.

**Architecture:** A Deno Edge Function (`admin-create-user`) holds the `service_role` key server-side and is the only thing that can mint an `auth.users` row. It verifies the caller is an admin by reading `app_users` **under the caller's own JWT** (so RLS applies and the vendor is never client-supplied), then creates the account and links it, deleting the account again if the link fails. Migration `0008` adds `app_users.must_change_password` plus a no-argument `SECURITY DEFINER` function that clears it for `auth.uid()` only; the SPA gates every route behind a new `SessionState` kind until that flag is false.

**Tech Stack:** Deno (Supabase Edge Functions), `@supabase/supabase-js` 2.116.0, PostgreSQL 17, React 19 + TypeScript 7, vitest 5 (web), the bespoke node runner in `tests/` (database).

**Spec:** `docs/superpowers/specs/2026-09-10-admin-creates-user-accounts-design.md`

## Global Constraints

- **The `service_role` key must NEVER appear under `web/`.** It carries `bypassrls`; a copy in a browser bundle is a full database compromise. `web/src/config.ts` states this — it holds only `SUPABASE_URL` and `SUPABASE_ANON_KEY`, both public by design.
- **The Edge Function is outside RLS.** It holds the service-role key, so no policy in `0002_rls.sql` constrains it. Every tenant and role check is hand-written inside it.
- **The caller's `vendor_id` is read from `app_users` under the caller's JWT, never taken from the request body.** This is what stops an admin creating users in another shop.
- **Roles are exactly `'admin' | 'recorder' | 'biller'`** — the check constraint in `0001_schema.sql:36` and `ROLES` in `web/src/config.ts`.
- **Minimum password length is 8.** Chosen here rather than inherited from Supabase's default floor of 6, so a platform default change cannot silently weaken it.
- **New accounts are created with `email_confirm: true`.** Production keeps email confirmations on (`supabase/config.toml:26`); without this the person cannot sign in with the password the admin just handed them.
- **Every user-facing string is a translation key present in all three of `web/src/i18n/{en,hi,mr}.json`.** A key in `en.json` missing from `mr.json` silently shows English to a Marathi user; Marathi is the default language.
- **Migrations are append-only and byte-identical to what `supabase db push` sends.** Never edit `0001`–`0007`.
- **`mr.json` terminates sentences with a full stop, `hi.json` with a danda (`।`).** The two files disagree by convention; follow each file's existing convention, do not normalise across them.
- **Deployment is the vendor's to run, in this order:** `supabase functions deploy admin-create-user`, then `supabase db push`, then merge the client. Never run either against Cloud from this repository's tooling.

---

## File Structure

**Created:**
- `supabase/migrations/0008_must_change_password.sql` — the column, the clearing function, its grants.
- `supabase/functions/admin-create-user/index.ts` — the HTTP handler; wiring only.
- `supabase/functions/admin-create-user/guards.ts` — pure request validation, no imports from Deno or supabase-js, so vitest can import it.
- `tests/must_change_password.test.mjs` — database-suite coverage of migration `0008`.
- `web/src/adminApi.ts` — the only module that calls `functions.invoke`.
- `web/src/components/ChangePassword.tsx` — the forced-change screen.
- `web/src/__tests__/guards.test.ts` — vitest over the shared guard module.
- `web/src/__tests__/adminApi.test.ts` — vitest over the invoke wrapper and its error mapping.
- `web/src/__tests__/ChangePassword.test.tsx` — vitest over the screen.

**Modified:**
- `supabase/config.toml` — add the `[functions.admin-create-user]` block.
- `tests/run.mjs` — import the new database test file.
- `web/src/adminRules.ts` — `validateNewStaff` takes email/password/name/role.
- `web/src/admin.ts` — delete `createStaff` and the `NewStaffValue` import.
- `web/src/session.ts` — new `mustChangePassword` kind; `sessionFromRow` reads the flag.
- `web/src/components/SessionProvider.tsx` — select the new column.
- `web/src/App.tsx` — route the new kind; reword the `Unmapped` panel.
- `web/src/screens/Staff.tsx` — the form becomes email/password/name/role.
- `web/src/i18n/{en,hi,mr}.json` — new keys, retired keys.
- `docs/runbook-first-admin.md` — the post-bootstrap section describes the new flow.
- Existing tests: `web/src/__tests__/{adminRules,admin,Staff,App,session,SessionProvider}.test.*`.

---

### Task 1: Migration 0008 — the flag and the function that clears it

**Files:**
- Create: `supabase/migrations/0008_must_change_password.sql`
- Create: `tests/must_change_password.test.mjs`
- Modify: `tests/run.mjs:13` (add the import alongside the other test files)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: column `app_users.must_change_password boolean not null default false`; SQL function `complete_password_change() returns void`, callable by `authenticated`, which sets the flag false for `auth.uid()` and nobody else.

- [ ] **Step 1: Write the failing test**

Create `tests/must_change_password.test.mjs`. Note the house idioms: `once()` defers seeding because `run.mjs` imports test files *before* `bootstrap()` rebuilds the schema, and `world.a.clients.admin` is a supabase-js client already signed in as that user.

```javascript
import { test, assert, assertEqual, assertDenied, once } from "./framework.mjs";
import { sql } from "./fixtures.mjs";
import { seedTwoVendors } from "./seed.mjs";

const getWorld = once(seedTwoVendors);

test("must_change_password defaults to false for existing staff", async () => {
  const world = await getWorld();
  const { rows } = await sql(
    `select must_change_password from app_users where id = $1`, [world.a.recorderId]);
  assertEqual(rows[0].must_change_password, false,
    "an existing row must not be forced to change a password nobody set for them");
});

test("complete_password_change clears the caller's own flag", async () => {
  const world = await getWorld();
  await sql(`update app_users set must_change_password = true where id = $1`,
    [world.a.recorderId]);

  const { error } = await world.a.clients.recorder.rpc("complete_password_change");
  assert(!error, `rpc failed: ${error && error.message}`);

  const { rows } = await sql(
    `select must_change_password from app_users where id = $1`, [world.a.recorderId]);
  assertEqual(rows[0].must_change_password, false, "the caller's own flag should be clear");
});

test("complete_password_change touches nobody else's row", async () => {
  // The function takes no arguments precisely so there is no id to forge. This proves
  // the body really does key on auth.uid() rather than clearing broadly.
  const world = await getWorld();
  await sql(`update app_users set must_change_password = true where id in ($1, $2)`,
    [world.a.billerId, world.b.recorderId]);

  await world.a.clients.biller.rpc("complete_password_change");

  const { rows } = await sql(
    `select must_change_password from app_users where id = $1`, [world.b.recorderId]);
  assertEqual(rows[0].must_change_password, true,
    "another vendor's flag must be untouched");
});

test("complete_password_change changes nothing without a session", async () => {
  // auth.uid() is null for anon. The update must match zero rows rather than every row.
  const world = await getWorld();
  await sql(`update app_users set must_change_password = true where id = $1`,
    [world.a.adminId]);

  const anon = world.a.clients.admin;
  await anon.auth.signOut();
  await anon.rpc("complete_password_change");

  const { rows } = await sql(
    `select must_change_password from app_users where id = $1`, [world.a.adminId]);
  assertEqual(rows[0].must_change_password, true,
    "an anonymous call must not clear anyone's flag");
});

test("a recorder still cannot update app_users directly", async () => {
  // The function exists BECAUSE users_admin_write is admin-only. If a recorder could
  // write the row themselves the function would be pointless -- and they could also
  // promote themselves to admin.
  const world = await getWorld();
  const { error } = await world.a.clients.recorder
    .from("app_users").update({ role: "admin" }).eq("id", world.a.recorderId);
  assertDenied(error, "a recorder must not be able to write app_users");
});
```

Add the import to `tests/run.mjs`, after the `expiry` line:

```javascript
import "./must_change_password.test.mjs";
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test` (from the repository root)
Expected: FAIL — `column "must_change_password" does not exist`, and `could not find the function public.complete_password_change`.

- [ ] **Step 3: Write the migration**

Create `supabase/migrations/0008_must_change_password.sql`:

```sql
-- An admin now creates staff accounts and types their first password, so the admin knows
-- it. bills.recorder_id and bills.biller_id name who did the work (0001_schema.sql:75-76),
-- so an admin who keeps that password could record bills under someone else's name and
-- the history would not show it. This flag closes that window at first login.
--
-- The flag lives here rather than in auth.users.user_metadata because metadata the user
-- can write is metadata the user can clear. app_metadata would also do, but app_users is
-- the row SessionProvider already reads and the row this project owns.
alter table app_users
  add column must_change_password boolean not null default false;

-- Clearing it needs its own function because users_admin_write is admin-only: a recorder
-- must be able to clear their OWN flag without gaining the ability to write anything else
-- on the row -- including their own role. RLS cannot restrict by column, so the narrow
-- privilege is expressed as a narrow function instead.
--
-- It takes no arguments on purpose. There is no id to pass, so there is no id to forge.
--
-- Unlike issue_token()/complete_bill(), a null auth.uid() is NOT waved through here. Those
-- act on a bill that names its own tenant, so a service-role caller is unambiguous; this
-- one keys entirely on who is calling, and a null there would match no row -- which is the
-- correct outcome, stated explicitly rather than left to the where clause by luck.
create function complete_password_change()
  returns void
  language sql security definer set search_path = public as $$
  update app_users
     set must_change_password = false
   where id = auth.uid()
$$;

revoke all on function complete_password_change() from public, anon;
grant execute on function complete_password_change() to authenticated;
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: PASS — 81 passed, 0 failed (76 existing + 5 new).

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/0008_must_change_password.sql tests/must_change_password.test.mjs tests/run.mjs
git commit -m "feat(db): flag staff who must change an admin-set password"
```

---

### Task 2: The shared guard module

**Files:**
- Create: `supabase/functions/admin-create-user/guards.ts`
- Create: `web/src/__tests__/guards.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `type CreateUserRequest = { email: string; password: string; name: string; role: string }`
  - `type ErrorCode = "bad_request" | "not_admin" | "email_taken" | "weak_password" | "create_failed" | "link_failed"`
  - `validateCreateUserRequest(body: unknown): { ok: true; value: CreateUserRequest } | { ok: false; code: ErrorCode; field?: string }`
  - `MIN_PASSWORD_LENGTH = 8`
  - `ROLES = ["admin", "recorder", "biller"] as const`

This module is deliberately free of Deno and supabase-js imports so vitest can import it directly from `web/`. It is the part of the function whose logic matters and the only part the local suite can prove.

- [ ] **Step 1: Write the failing test**

Create `web/src/__tests__/guards.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import {
  validateCreateUserRequest, MIN_PASSWORD_LENGTH,
} from "../../../supabase/functions/admin-create-user/guards";

const good = { email: "rina@shop.test", password: "sunflower9", name: "Rina", role: "recorder" };

describe("validateCreateUserRequest", () => {
  it("accepts a well-formed request", () => {
    const r = validateCreateUserRequest(good);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toEqual(good);
  });

  it("rejects a body that is not an object at all", () => {
    // The function is reachable by anything holding a valid JWT, not only this SPA.
    // A malformed body must be a clean 400, never a crash that reads as a 500.
    for (const body of [null, undefined, "rina", 42, []]) {
      expect(validateCreateUserRequest(body).ok).toBe(false);
    }
  });

  it("rejects a role outside the three the column allows", () => {
    // 0001_schema.sql:36 -- role in ('admin','recorder','biller'). Anything else is a
    // 23514 from the database AFTER the auth account has already been created, which is
    // the expensive way to find out.
    const r = validateCreateUserRequest({ ...good, role: "owner" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.field).toBe("role");
  });

  it("rejects a password below the floor this project sets", () => {
    const r = validateCreateUserRequest({ ...good, password: "a".repeat(MIN_PASSWORD_LENGTH - 1) });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("weak_password");
  });

  it("sets its own floor rather than inheriting Supabase's", () => {
    // Supabase's own default minimum is 6. If this constant ever equals it, a change to
    // the platform default silently weakens this app.
    expect(MIN_PASSWORD_LENGTH).toBeGreaterThan(6);
  });

  it("rejects a blank name", () => {
    const r = validateCreateUserRequest({ ...good, name: "   " });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.field).toBe("name");
  });

  it("rejects something that is not an email address", () => {
    for (const email of ["rina", "rina@", "@shop.test", "rina shop@test.com", ""]) {
      const r = validateCreateUserRequest({ ...good, email });
      expect(r.ok, `should reject ${JSON.stringify(email)}`).toBe(false);
    }
  });

  it("lowercases and trims the email, because GoTrue treats it case-insensitively", () => {
    const r = validateCreateUserRequest({ ...good, email: "  Rina@Shop.Test  " });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.email).toBe("rina@shop.test");
  });

  it("trims the name but never the password", () => {
    // Trimming a password silently changes the credential the admin read out loud.
    const r = validateCreateUserRequest({ ...good, name: "  Rina  ", password: " pass word " });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.name).toBe("Rina");
      expect(r.value.password).toBe(" pass word ");
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd web && npx vitest run src/__tests__/guards.test.ts`
Expected: FAIL — cannot resolve `../../../supabase/functions/admin-create-user/guards`.

- [ ] **Step 3: Write the guard module**

Create `supabase/functions/admin-create-user/guards.ts`:

```typescript
/**
 * Pure request validation for admin-create-user.
 *
 * Deliberately imports NOTHING -- not Deno, not supabase-js -- so the web test suite can
 * import it directly and these rules are actually exercised. The deployed function around
 * it cannot be tested locally at all (no Deno runtime in tests/run.mjs, no GoTrue), so
 * everything that can live here should.
 */

/** Exactly the values app_users.role permits (0001_schema.sql check constraint). */
export const ROLES = ["admin", "recorder", "biller"] as const;
export type Role = (typeof ROLES)[number];

/**
 * Supabase's own default floor is 6. Set higher here ON PURPOSE: inheriting the platform
 * default would mean a change to it silently weakens this app, with nothing failing.
 */
export const MIN_PASSWORD_LENGTH = 8;

export type CreateUserRequest = {
  email: string;
  password: string;
  name: string;
  role: Role;
};

export type ErrorCode =
  | "bad_request"
  | "not_admin"
  | "email_taken"
  | "weak_password"
  | "create_failed"
  | "link_failed";

export type GuardResult =
  | { ok: true; value: CreateUserRequest }
  | { ok: false; code: ErrorCode; field?: string };

/** Deliberately loose. GoTrue is the authority on what it will accept; this only catches
 *  the obvious slip before an account is created, and must not reject an address GoTrue
 *  would have taken. */
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function validateCreateUserRequest(body: unknown): GuardResult {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return { ok: false, code: "bad_request" };
  }
  const b = body as Record<string, unknown>;

  const email = typeof b.email === "string" ? b.email.trim().toLowerCase() : "";
  const name = typeof b.name === "string" ? b.name.trim() : "";
  // NOT trimmed: trimming would silently change the credential the admin read out loud.
  const password = typeof b.password === "string" ? b.password : "";
  const role = typeof b.role === "string" ? b.role : "";

  if (!EMAIL.test(email)) return { ok: false, code: "bad_request", field: "email" };
  if (name === "") return { ok: false, code: "bad_request", field: "name" };
  if (!(ROLES as readonly string[]).includes(role)) {
    return { ok: false, code: "bad_request", field: "role" };
  }
  if (password.length < MIN_PASSWORD_LENGTH) {
    return { ok: false, code: "weak_password", field: "password" };
  }

  return { ok: true, value: { email, password, name, role: role as Role } };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd web && npx vitest run src/__tests__/guards.test.ts`
Expected: PASS — 9 tests.

- [ ] **Step 5: Verify TypeScript accepts the cross-directory import**

Run: `cd web && npx tsc --noEmit`
Expected: exit 0. If it complains that the file is outside `rootDir`, add `"../supabase/functions/**/*.ts"` to `include` in `web/tsconfig.json` rather than relaxing `rootDir`.

- [ ] **Step 6: Commit**

```bash
git add supabase/functions/admin-create-user/guards.ts web/src/__tests__/guards.test.ts
git commit -m "feat(functions): request guards for admin-create-user"
```

---

### Task 3: The Edge Function handler

**Files:**
- Create: `supabase/functions/admin-create-user/index.ts`
- Modify: `supabase/config.toml` (append a `[functions.admin-create-user]` block)

**Interfaces:**
- Consumes: `validateCreateUserRequest`, `ErrorCode` from Task 2.
- Produces: an HTTP endpoint invoked as `supabase.functions.invoke("admin-create-user", { body })`. On success `200 { id: string }`. On failure a non-2xx with `{ error: ErrorCode }`.

There is no automated test for this file. `tests/run.mjs` has no Deno runtime and the local suite runs no GoTrue, so nothing here can be proved before deployment — which is exactly why Task 2 exists and why this file is wiring only. Keep logic out of it.

- [ ] **Step 1: Write the handler**

Create `supabase/functions/admin-create-user/index.ts`:

```typescript
// Creates a staff account and links it to the calling admin's vendor.
//
// THIS FUNCTION IS OUTSIDE RLS. It holds the service_role key, which carries bypassrls, so
// not one policy in 0002_rls.sql constrains it. Every tenant and role check below is
// hand-written for that reason -- the same lesson as issue_token(), at higher stakes,
// because this one can mint accounts.
//
// Untestable locally: there is no Deno runtime in tests/run.mjs and the local suite runs no
// GoTrue. Logic belongs in ./guards.ts, which the web suite does exercise. This file is
// wiring, and should stay that way.
import { createClient } from "jsr:@supabase/supabase-js@2";
import { validateCreateUserRequest, type ErrorCode } from "./guards.ts";

const URL = Deno.env.get("SUPABASE_URL")!;
const ANON = Deno.env.get("SUPABASE_ANON_KEY")!;
const SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

function fail(code: ErrorCode, status: number): Response {
  return new Response(JSON.stringify({ error: code }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return fail("bad_request", 405);

  const auth = req.headers.get("Authorization");
  if (!auth) return fail("not_admin", 401);

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return fail("bad_request", 400);
  }

  const check = validateCreateUserRequest(body);
  if (!check.ok) return fail(check.code, check.code === "weak_password" ? 422 : 400);
  const { email, password, name, role } = check.value;

  // The caller's OWN client: anon key plus their Authorization header. Two things come
  // from this and must not come from anywhere else --
  //   1. getUser() verifies the JWT's signature, so the caller is who they say;
  //   2. the app_users read runs under THEIR session, so users_read applies and the
  //      vendor_id below is the database's answer, not the request body's.
  // Taking vendor_id from the body would let any admin create staff in any shop.
  const caller = createClient(URL, ANON, {
    global: { headers: { Authorization: auth } },
    auth: { persistSession: false },
  });

  const { data: who, error: whoError } = await caller.auth.getUser();
  if (whoError || !who?.user) return fail("not_admin", 401);

  const { data: me, error: meError } = await caller
    .from("app_users")
    .select("vendor_id, role")
    .eq("id", who.user.id)
    .maybeSingle();
  if (meError || !me || me.role !== "admin") return fail("not_admin", 403);

  const admin = createClient(URL, SERVICE, { auth: { persistSession: false } });

  // email_confirm: true because production keeps confirmations on (config.toml). Without
  // it the person cannot sign in with the password the admin just handed them, which is
  // the entire point of this flow.
  const { data: created, error: createError } = await admin.auth.admin.createUser({
    email, password, email_confirm: true,
  });
  if (createError || !created?.user) {
    const already = /already|exists|registered/i.test(createError?.message ?? "");
    return fail(already ? "email_taken" : "create_failed", already ? 409 : 500);
  }

  const { error: linkError } = await admin.from("app_users").insert({
    id: created.user.id,
    vendor_id: me.vendor_id,
    role,
    name,
    must_change_password: true,
  });

  if (linkError) {
    // NOT optional. An auth account with no app_users row can sign in and resolves to no
    // tenant -- a real person stuck on the "Account not linked to a shop" panel with
    // nobody able to help them. Best-effort: if this delete also fails, that panel is
    // where they land, which is why it survives this slice.
    await admin.auth.admin.deleteUser(created.user.id).catch(() => {});
    return fail("link_failed", 500);
  }

  return new Response(JSON.stringify({ id: created.user.id }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
});
```

- [ ] **Step 2: Add the config block**

Append to `supabase/config.toml`:

```toml
# verify_jwt rejects unauthenticated calls at the platform edge. That is defence in depth,
# NOT the check: a valid token proves a signed-in user, not an admin. The function reads
# app_users under the caller's own JWT to decide that, and must keep doing so.
[functions.admin-create-user]
verify_jwt = true
```

- [ ] **Step 3: Verify it at least parses**

Run: `npx supabase functions serve admin-create-user --no-verify-jwt`
Expected: it boots and reports it is serving. Stop it with Ctrl-C. If Deno is unavailable on this machine, skip this step and say so in the commit — it is a syntax check, not a test.

- [ ] **Step 4: Confirm no service-role key leaked into the bundle**

Run: `grep -ri "service_role\|SERVICE_ROLE" web/src/ || echo "clean"`
Expected: `clean`. Any hit here is a release blocker, not a lint warning.

- [ ] **Step 5: Commit**

```bash
git add supabase/functions/admin-create-user/index.ts supabase/config.toml
git commit -m "feat(functions): admin-create-user creates and links a staff account"
```

---

### Task 4: `validateNewStaff` takes credentials

**Files:**
- Modify: `web/src/adminRules.ts` (the `NewStaff*` types and `validateNewStaff`, added by PR #7)
- Modify: `web/src/__tests__/adminRules.test.ts` (the `validateNewStaff` describe block)

**Interfaces:**
- Consumes: `MIN_PASSWORD_LENGTH`, `ROLES` from Task 2's guard module.
- Produces:
  - `type NewStaffInput = { email: string; password: string; name: string; role: string }`
  - `type NewStaffField = keyof NewStaffInput`
  - `type NewStaffValue = { email: string; password: string; name: string; role: Role }`
  - `validateNewStaff(input: NewStaffInput): { ok: true; value: NewStaffValue } | { ok: false; errors: Partial<Record<NewStaffField, string>> }`

The client keeps its own validation rather than relying on the function's, so the admin gets a message naming the field before a round trip. The floor comes from the shared module so the two cannot drift.

- [ ] **Step 1: Replace the failing test block**

In `web/src/__tests__/adminRules.test.ts`, replace the entire `describe("validateNewStaff", ...)` block with:

```typescript
describe("validateNewStaff", () => {
  const good = { email: "rina@shop.test", password: "sunflower9", name: "Rina", role: "recorder" };

  it("accepts a well-formed row", () => {
    const r = validateNewStaff(good);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toEqual(good);
  });

  it("rejects something that is not an email address", () => {
    const r = validateNewStaff({ ...good, email: "rina" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.email).toBe("staff.badEmail");
  });

  it("lowercases the email, because GoTrue treats it case-insensitively", () => {
    const r = validateNewStaff({ ...good, email: "Rina@Shop.Test" });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.email).toBe("rina@shop.test");
  });

  it("rejects a password below the shared floor", () => {
    const r = validateNewStaff({ ...good, password: "short" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.password).toBe("staff.badPassword");
  });

  it("takes its floor from the same constant the function enforces", () => {
    // Two independent numbers would drift, and the drift shows up as the server rejecting
    // what the form accepted -- with the field message already dismissed.
    const atFloor = { ...good, password: "a".repeat(MIN_PASSWORD_LENGTH) };
    expect(validateNewStaff(atFloor).ok).toBe(true);
    const below = { ...good, password: "a".repeat(MIN_PASSWORD_LENGTH - 1) };
    expect(validateNewStaff(below).ok).toBe(false);
  });

  it("never trims the password", () => {
    const r = validateNewStaff({ ...good, password: " pass word " });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.password).toBe(" pass word ");
  });

  it("rejects a blank name", () => {
    const r = validateNewStaff({ ...good, name: "   " });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.name).toBe("staff.required");
  });

  it("rejects a role the check constraint would refuse", () => {
    const r = validateNewStaff({ ...good, role: "owner" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.role).toBe("staff.badRole");
  });

  it("reports every bad field at once", () => {
    const r = validateNewStaff({ email: "x", password: "", name: "", role: "" });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(Object.keys(r.errors).sort()).toEqual(["email", "name", "password", "role"]);
    }
  });
});
```

Update that file's import line to add the constant:

```typescript
import { MIN_PASSWORD_LENGTH } from "../../../supabase/functions/admin-create-user/guards";
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd web && npx vitest run src/__tests__/adminRules.test.ts`
Expected: FAIL — the old `validateNewStaff` still expects `{ id, name, role }` and reports `staff.badId`.

- [ ] **Step 3: Rewrite the validator**

In `web/src/adminRules.ts`, replace the `UUID` constant, the `NewStaff*` types and `validateNewStaff` with:

```typescript
export type NewStaffInput = { email: string; password: string; name: string; role: string };
export type NewStaffField = keyof NewStaffInput;
export type NewStaffValue = { email: string; password: string; name: string; role: Role };

/** Same shape as the Edge Function's own check, and deliberately as loose: GoTrue decides
 *  what it accepts, and rejecting an address it would have taken is worse than a round
 *  trip. */
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * A new staff account, as the admin fills it in.
 *
 * This duplicates the Edge Function's guards on purpose: the round trip creates a real
 * auth account, so an obvious slip should be named against its field before it is made.
 * MIN_PASSWORD_LENGTH is IMPORTED rather than restated, because two copies of that number
 * drift and the drift appears as the server refusing what the form accepted.
 */
export function validateNewStaff(
  input: NewStaffInput,
): { ok: true; value: NewStaffValue } | { ok: false; errors: Partial<Record<NewStaffField, string>> } {
  const errors: Partial<Record<NewStaffField, string>> = {};

  const email = input.email.trim().toLowerCase();
  if (!EMAIL.test(email)) errors.email = "staff.badEmail";
  if (input.name.trim() === "") errors.name = "staff.required";
  if (!(ROLES as readonly string[]).includes(input.role)) errors.role = "staff.badRole";
  // Not trimmed: trimming silently changes the credential the admin read out loud.
  if (input.password.length < MIN_PASSWORD_LENGTH) errors.password = "staff.badPassword";

  if (Object.keys(errors).length > 0) return { ok: false, errors };
  return {
    ok: true,
    value: { email, password: input.password, name: input.name.trim(), role: input.role as Role },
  };
}
```

Add to the imports at the top of `web/src/adminRules.ts`:

```typescript
import { MIN_PASSWORD_LENGTH } from "../../supabase/functions/admin-create-user/guards";
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd web && npx vitest run src/__tests__/adminRules.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add web/src/adminRules.ts web/src/__tests__/adminRules.test.ts
git commit -m "feat: validate staff credentials instead of a pasted user id"
```

---

### Task 5: The `adminApi` wrapper and its error mapping

**Files:**
- Create: `web/src/adminApi.ts`
- Create: `web/src/__tests__/adminApi.test.ts`
- Modify: `web/src/admin.ts` (delete `createStaff` and drop `NewStaffValue` from the type import on line 2)
- Modify: `web/src/__tests__/admin.test.ts` (delete the `describe("createStaff", ...)` block and remove `createStaff` from the destructured import)

**Interfaces:**
- Consumes: `NewStaffValue` from Task 4; `ErrorCode` from Task 2.
- Produces: `createUserAccount(value: NewStaffValue): Promise<{ error: { key: string; detail: string } | null }>` — already mapped to a translation key, because the failure shape here is not a `PostgrestError` and `describeError` does not apply.

- [ ] **Step 1: Write the failing test**

Create `web/src/__tests__/adminApi.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";

const invoke = vi.fn(async (..._a: unknown[]): Promise<{
  data: unknown; error: { message?: string; context?: Response } | null;
}> => ({ data: { id: "u9" }, error: null }));

vi.mock("../supabase", () => ({ supabase: { functions: { invoke: (...a: unknown[]) => invoke(...a) } } }));

const { createUserAccount } = await import("../adminApi");

const value = { email: "rina@shop.test", password: "sunflower9", name: "Rina", role: "recorder" as const };

beforeEach(() => vi.clearAllMocks());

describe("createUserAccount", () => {
  it("invokes the function with the credentials as the body", async () => {
    await createUserAccount(value);
    expect(invoke).toHaveBeenCalledWith("admin-create-user", { body: value });
  });

  it("sends no vendor id -- the function reads it from the caller's own session", async () => {
    // If the client could name a vendor, an admin could create staff in another shop.
    await createUserAccount(value);
    const body = (invoke.mock.calls[0]?.[1] as { body: Record<string, unknown> }).body;
    expect(Object.keys(body).sort()).toEqual(["email", "name", "password", "role"]);
  });

  it("reports success as a null error", async () => {
    expect((await createUserAccount(value)).error).toBeNull();
  });

  it("names an address that is already taken", async () => {
    // The ordinary case of adding someone twice. A generic failure here would send the
    // admin looking for a problem that is only "they are already here".
    invoke.mockResolvedValueOnce({
      data: null,
      error: { message: "Edge Function returned a non-2xx status code",
               context: new Response(JSON.stringify({ error: "email_taken" }), { status: 409 }) },
    });
    expect((await createUserAccount(value)).error?.key).toBe("error.emailTaken");
  });

  it("names a refused caller", async () => {
    invoke.mockResolvedValueOnce({
      data: null,
      error: { message: "non-2xx",
               context: new Response(JSON.stringify({ error: "not_admin" }), { status: 403 }) },
    });
    expect((await createUserAccount(value)).error?.key).toBe("error.notAllowed");
  });

  it("says the account was rolled back when linking failed", async () => {
    // link_failed means the auth account was created and then deleted again. Telling the
    // admin to just try again is right, and only true because of that compensating delete.
    invoke.mockResolvedValueOnce({
      data: null,
      error: { message: "non-2xx",
               context: new Response(JSON.stringify({ error: "link_failed" }), { status: 500 }) },
    });
    expect((await createUserAccount(value)).error?.key).toBe("error.staffNotCreated");
  });

  it("falls back to unknown when the body is not one of our codes", async () => {
    // A 500 from the platform itself, or a gateway, carries no { error } body at all.
    invoke.mockResolvedValueOnce({
      data: null,
      error: { message: "boom", context: new Response("<html>502</html>", { status: 502 }) },
    });
    expect((await createUserAccount(value)).error?.key).toBe("error.unknown");
  });

  it("reports a dead network as offline, not as a rejected request", async () => {
    invoke.mockResolvedValueOnce({ data: null, error: { message: "Failed to fetch" } });
    expect((await createUserAccount(value)).error?.key).toBe("error.offline");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd web && npx vitest run src/__tests__/adminApi.test.ts`
Expected: FAIL — cannot resolve `../adminApi`.

- [ ] **Step 3: Write the module**

Create `web/src/adminApi.ts`:

```typescript
import { supabase } from "./supabase";
import type { NewStaffValue } from "./adminRules";
import type { ErrorCode } from "../../supabase/functions/admin-create-user/guards";

/**
 * The only module that calls an Edge Function.
 *
 * Kept out of admin.ts because the failure shape is different in kind: supabase-js reports
 * a non-2xx as a FunctionsHttpError whose body has to be read off error.context, not as a
 * PostgrestError with a code. describeError matches Postgres codes and message text and
 * would send every one of these to "something went wrong", so the mapping lives here.
 */

const KEYS: Record<ErrorCode, string> = {
  not_admin: "error.notAllowed",
  email_taken: "error.emailTaken",
  weak_password: "error.weakPassword",
  bad_request: "error.unknown",
  create_failed: "error.staffNotCreated",
  link_failed: "error.staffNotCreated",
};

async function codeFrom(error: { message?: string; context?: unknown }): Promise<string> {
  if (/failed to fetch|networkerror|load failed/i.test(error.message ?? "")) {
    return "error.offline";
  }
  const res = error.context;
  if (!(res instanceof Response)) return "error.unknown";
  try {
    const body = (await res.clone().json()) as { error?: string };
    const code = body.error as ErrorCode | undefined;
    return (code && KEYS[code]) || "error.unknown";
  } catch {
    // A 502 from the platform or a gateway is HTML, not our JSON. Not knowing the cause
    // is itself the honest answer here.
    return "error.unknown";
  }
}

/**
 * Creates a staff account and links it to the signed-in admin's vendor.
 *
 * The body carries NO vendor id. The function reads that from app_users under the caller's
 * own JWT, which is what stops an admin creating staff in someone else's shop -- sending
 * one from here would invite the function to trust it.
 */
export async function createUserAccount(
  value: NewStaffValue,
): Promise<{ error: { key: string; detail: string } | null }> {
  const { error } = await supabase.functions.invoke("admin-create-user", { body: value });
  if (!error) return { error: null };
  return { error: { key: await codeFrom(error), detail: error.message ?? "" } };
}
```

- [ ] **Step 4: Delete the superseded `createStaff`**

In `web/src/admin.ts`, delete the `createStaff` function and its doc comment, and change line 2 to:

```typescript
import type { ItemValue, SettingsField } from "./adminRules";
```

In `web/src/__tests__/admin.test.ts`, delete the whole `describe("createStaff", ...)` block and remove `createStaff` from the destructured import.

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd web && npx vitest run src/__tests__/adminApi.test.ts src/__tests__/admin.test.ts`
Expected: PASS both files.

- [ ] **Step 6: Commit**

```bash
git add web/src/adminApi.ts web/src/admin.ts web/src/__tests__/adminApi.test.ts web/src/__tests__/admin.test.ts
git commit -m "feat: call admin-create-user, and map its errors to real messages"
```

---

### Task 6: The session gate

**Files:**
- Modify: `web/src/session.ts` (the `SessionState` union and `sessionFromRow`)
- Modify: `web/src/components/SessionProvider.tsx:26` (the `select` list)
- Modify: `web/src/__tests__/session.test.ts`
- Modify: `web/src/__tests__/SessionProvider.test.tsx`

**Interfaces:**
- Consumes: `app_users.must_change_password` from Task 1.
- Produces:
  - `AppUserRow` gains `must_change_password: boolean`
  - `SessionState` gains `{ kind: "mustChangePassword"; userId: string; email: string }`
  - `sessionFromRow` returns that kind when the flag is true, in preference to `ready`

- [ ] **Step 1: Write the failing test**

Add to `web/src/__tests__/session.test.ts`:

```typescript
const row = {
  name: "Rina", role: "recorder" as const, vendor_id: "v1",
  vendors: { name: "Shop" }, must_change_password: false,
};

describe("a password the admin chose", () => {
  it("becomes its own session kind, not a flag on ready", () => {
    // A boolean on `ready` would leave Shell and Guard rendering the app behind the
    // prompt, and every screen would have to remember to check it. A distinct kind makes
    // the routes unreachable rather than merely hidden -- the same reason unmapped is one.
    const s = sessionFromRow("u1", "rina@shop.test", { ...row, must_change_password: true });
    expect(s.kind).toBe("mustChangePassword");
  });

  it("carries the id and email that screen needs", () => {
    const s = sessionFromRow("u1", "rina@shop.test", { ...row, must_change_password: true });
    expect(s).toEqual({ kind: "mustChangePassword", userId: "u1", email: "rina@shop.test" });
  });

  it("lets a cleared flag through to ready", () => {
    expect(sessionFromRow("u1", "rina@shop.test", row).kind).toBe("ready");
  });

  it("outranks the role, so even an admin is stopped", () => {
    // An admin who created their own account through this flow is in the same position
    // as anyone else: the person who typed the password knows it.
    const s = sessionFromRow("u1", "a@shop.test",
      { ...row, role: "admin", must_change_password: true });
    expect(s.kind).toBe("mustChangePassword");
  });
});
```

Also update the existing `ready` assertions in that file to include `must_change_password: false` in the row they pass.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd web && npx vitest run src/__tests__/session.test.ts`
Expected: FAIL — `sessionFromRow` returns `ready` regardless of the flag.

- [ ] **Step 3: Extend the session**

In `web/src/session.ts`, add the field to `AppUserRow`:

```typescript
export type AppUserRow = {
  name: string;
  role: Role;
  vendor_id: string;
  vendors: { name: string } | null;
  must_change_password: boolean;
};
```

Add the variant to `SessionState`, after `unmapped`:

```typescript
  // Its own kind rather than a flag on `ready`, so App.tsx cannot reach the routes at all.
  // A boolean on ready would leave Shell and Guard rendering the app behind the prompt and
  // put the burden on every screen to remember the check.
  | { kind: "mustChangePassword"; userId: string; email: string }
```

And in `sessionFromRow`, immediately after the `if (!row)` line:

```typescript
  // Checked before role: an admin who created their own account is in exactly the same
  // position as anyone else, because the person who typed the password knows it.
  if (row.must_change_password) return { kind: "mustChangePassword", userId, email };
```

In `web/src/components/SessionProvider.tsx`, change the select on line 26 to:

```typescript
        .select("name, role, vendor_id, must_change_password, vendors(name)")
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd web && npx vitest run src/__tests__/session.test.ts src/__tests__/SessionProvider.test.tsx`
Expected: PASS. If `SessionProvider.test.tsx` fails, its mocked row needs `must_change_password: false` added.

- [ ] **Step 5: Commit**

```bash
git add web/src/session.ts web/src/components/SessionProvider.tsx web/src/__tests__/session.test.ts web/src/__tests__/SessionProvider.test.tsx
git commit -m "feat: make a forced password change its own session state"
```

---

### Task 7: The change-password screen

**Files:**
- Create: `web/src/components/ChangePassword.tsx`
- Create: `web/src/__tests__/ChangePassword.test.tsx`
- Modify: `web/src/App.tsx` (import it; add the branch in `Inner`)
- Modify: `web/src/__tests__/App.test.tsx`

**Interfaces:**
- Consumes: the `mustChangePassword` kind from Task 6.
- Produces: `<ChangePassword email={string} />`, rendered by `App.tsx` in place of every route while the flag is set.

- [ ] **Step 1: Write the failing test**

Create `web/src/__tests__/ChangePassword.test.tsx`:

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

const updateUser = vi.fn(async (..._a: unknown[]): Promise<{ error: { message?: string } | null }> =>
  ({ error: null }));
const rpc = vi.fn(async (..._a: unknown[]): Promise<{ error: { message?: string } | null }> =>
  ({ error: null }));
const signOut = vi.fn(async () => ({ error: null }));

vi.mock("../supabase", () => ({
  supabase: {
    auth: { updateUser: (...a: unknown[]) => updateUser(...a), signOut: () => signOut() },
    rpc: (...a: unknown[]) => rpc(...a),
  },
}));

const { ChangePassword } = await import("../components/ChangePassword");

beforeEach(() => vi.clearAllMocks());

function fill(pw: string, confirm = pw) {
  fireEvent.change(screen.getByTestId("newpw"), { target: { value: pw } });
  fireEvent.change(screen.getByTestId("newpw-confirm"), { target: { value: confirm } });
}

describe("the forced password change", () => {
  it("sets the new password", async () => {
    render(<ChangePassword email="rina@shop.test" />);
    fill("sunflower9");
    fireEvent.click(screen.getByTestId("newpw-save"));
    await waitFor(() => expect(updateUser).toHaveBeenCalledWith({ password: "sunflower9" }));
  });

  it("clears the flag only AFTER the password actually changed", async () => {
    // The reverse order clears the flag and leaves the admin's password live -- the exact
    // window this screen exists to close.
    render(<ChangePassword email="rina@shop.test" />);
    fill("sunflower9");
    fireEvent.click(screen.getByTestId("newpw-save"));
    await waitFor(() => expect(rpc).toHaveBeenCalledWith("complete_password_change"));
    expect(updateUser.mock.invocationCallOrder[0])
      .toBeLessThan(rpc.mock.invocationCallOrder[0]);
  });

  it("does not clear the flag when the password change failed", async () => {
    updateUser.mockResolvedValueOnce({ error: { message: "too weak" } });
    render(<ChangePassword email="rina@shop.test" />);
    fill("sunflower9");
    fireEvent.click(screen.getByTestId("newpw-save"));
    await waitFor(() => expect(updateUser).toHaveBeenCalled());
    expect(rpc).not.toHaveBeenCalled();
  });

  it("refuses two entries that do not match", async () => {
    render(<ChangePassword email="rina@shop.test" />);
    fill("sunflower9", "sunflower8");
    fireEvent.click(screen.getByTestId("newpw-save"));
    expect(await screen.findByTestId("newpw-error")).toBeTruthy();
    expect(updateUser).not.toHaveBeenCalled();
  });

  it("refuses a password below the floor", async () => {
    render(<ChangePassword email="rina@shop.test" />);
    fill("short");
    fireEvent.click(screen.getByTestId("newpw-save"));
    expect(await screen.findByTestId("newpw-error")).toBeTruthy();
    expect(updateUser).not.toHaveBeenCalled();
  });

  it("offers a way out that is not using the app", async () => {
    // The screen has no cancel by design, so sign out is the only exit. Without it a
    // person handed the wrong password is stuck on a screen they cannot satisfy.
    render(<ChangePassword email="rina@shop.test" />);
    fireEvent.click(screen.getByTestId("newpw-signout"));
    await waitFor(() => expect(signOut).toHaveBeenCalled());
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd web && npx vitest run src/__tests__/ChangePassword.test.tsx`
Expected: FAIL — cannot resolve `../components/ChangePassword`.

- [ ] **Step 3: Write the screen**

Create `web/src/components/ChangePassword.tsx`:

```typescript
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { supabase } from "../supabase";
import { MIN_PASSWORD_LENGTH } from "../../../supabase/functions/admin-create-user/guards";
import { LangSwitch } from "./Shell";

/**
 * Shown instead of every route while app_users.must_change_password is set.
 *
 * The admin typed this person's first password, so the admin knows it. bills.recorder_id
 * and bills.biller_id name who did the work, so until it changes an admin could record
 * bills under this person's name and the history would not show it.
 *
 * There is no cancel: the flag is the whole point. Sign out is the way out, for someone
 * handed a password that does not work -- without it they would be stuck on a screen they
 * cannot satisfy.
 */
export function ChangePassword({ email }: { email: string }) {
  const { t } = useTranslation();
  const [pw, setPw] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<{ key: string; detail: string } | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (pw.length < MIN_PASSWORD_LENGTH) {
      setError({ key: "changePw.tooShort", detail: "" });
      return;
    }
    if (pw !== confirm) {
      setError({ key: "changePw.mismatch", detail: "" });
      return;
    }
    setError(null);
    setBusy(true);

    // ORDER MATTERS. The password changes first; only then is the flag cleared. Reversed,
    // a failure between the two would leave the flag clear and the admin's password live,
    // which is exactly the window this screen closes. A failure in the other direction
    // just prompts again, which is harmless.
    const { error: pwError } = await supabase.auth.updateUser({ password: pw });
    if (pwError) {
      setBusy(false);
      setError({ key: "changePw.failed", detail: pwError.message ?? "" });
      return;
    }

    const { error: flagError } = await supabase.rpc("complete_password_change");
    setBusy(false);
    if (flagError) {
      setError({ key: "changePw.failed", detail: flagError.message ?? "" });
      return;
    }
    // SessionProvider re-reads app_users on the auth state change updateUser triggers, so
    // there is nothing to navigate to: the session resolves to `ready` and App renders the
    // routes on its own.
  }

  return (
    <div className="min-h-screen flex flex-col items-center justify-center p-4 gap-4">
      <form onSubmit={submit} className="bg-white border border-slate-200 rounded-xl p-6 w-full max-w-sm shadow-sm space-y-3">
        <h1 className="text-lg font-semibold text-slate-800">{t("changePw.title")}</h1>
        <p className="text-sm text-slate-600">{t("changePw.body", { email })}</p>

        {error && (
          <div data-testid="newpw-error" className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">
            {t(error.key)}
            {error.detail && <span className="block text-xs opacity-70 mt-1">{error.detail}</span>}
          </div>
        )}

        <div>
          <label className="block text-sm font-medium mb-1" htmlFor="newpw">{t("changePw.new")}</label>
          <input
            id="newpw" data-testid="newpw" type="password" autoComplete="new-password"
            value={pw} onChange={(e) => setPw(e.target.value)}
            className="w-full border border-slate-300 rounded-lg px-3 py-2 min-h-[44px]"
          />
        </div>
        <div>
          <label className="block text-sm font-medium mb-1" htmlFor="newpw-confirm">{t("changePw.confirm")}</label>
          <input
            id="newpw-confirm" data-testid="newpw-confirm" type="password" autoComplete="new-password"
            value={confirm} onChange={(e) => setConfirm(e.target.value)}
            className="w-full border border-slate-300 rounded-lg px-3 py-2 min-h-[44px]"
          />
        </div>

        <button
          type="submit" data-testid="newpw-save" disabled={busy}
          className="w-full bg-green-600 disabled:bg-green-300 text-white rounded-lg font-medium min-h-[44px]"
        >
          {t("changePw.save")}
        </button>
        <button
          type="button" data-testid="newpw-signout" onClick={() => void supabase.auth.signOut()}
          className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm bg-white min-h-[44px]"
        >
          {t("app.signOut")}
        </button>
      </form>
      <LangSwitch />
    </div>
  );
}
```

- [ ] **Step 4: Wire it into App**

In `web/src/App.tsx`, add the import beside the other component imports:

```typescript
import { ChangePassword } from "./components/ChangePassword";
```

and the branch in `Inner`, immediately after the `unmapped` line:

```typescript
  if (s.kind === "mustChangePassword") return <ChangePassword email={s.email} />;
```

Add to `web/src/__tests__/App.test.tsx`:

```typescript
  it("shows the password change instead of any route while the flag is set", async () => {
    // The gate has to be at the router, not inside a screen: reachable routes behind a
    // prompt are reachable.
    getSession.mockResolvedValue({
      data: { session: { user: { id: "u1", email: "rina@shop.test" } } },
    });
    appUserRow.value = {
      name: "Rina", role: "recorder", vendor_id: "v1",
      vendors: { name: "Shop" }, must_change_password: true,
    };

    render(<App />);

    expect(await screen.findByTestId("newpw")).toBeTruthy();
    expect(screen.queryByTestId("screen-bill")).toBeNull();
  });
```

Update the two existing `appUserRow.value` assignments in that file to include `must_change_password: false`.

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd web && npx vitest run src/__tests__/ChangePassword.test.tsx src/__tests__/App.test.tsx`
Expected: PASS both files.

- [ ] **Step 6: Commit**

```bash
git add web/src/components/ChangePassword.tsx web/src/App.tsx web/src/__tests__/ChangePassword.test.tsx web/src/__tests__/App.test.tsx
git commit -m "feat: force a password change before an admin-created account reaches the app"
```

---

### Task 8: The Add staff form takes credentials

**Files:**
- Modify: `web/src/screens/Staff.tsx` (the `adding` form and its `add()` handler)
- Modify: `web/src/__tests__/Staff.test.tsx` (the `describe("adding staff", ...)` block)

**Interfaces:**
- Consumes: `createUserAccount` from Task 5; `validateNewStaff` from Task 4.
- Produces: no new exports.

- [ ] **Step 1: Replace the failing test block**

In `web/src/__tests__/Staff.test.tsx`, replace the whole `describe("adding staff", ...)` block with:

```typescript
describe("adding staff", () => {
  async function openForm() {
    render(<Staff />);
    fireEvent.click(await screen.findByTestId("staff-add-open"));
  }

  function fill() {
    fireEvent.change(screen.getByTestId("staff-add-email"), { target: { value: "rina@shop.test" } });
    fireEvent.change(screen.getByTestId("staff-add-password"), { target: { value: "sunflower9" } });
    fireEvent.change(screen.getByTestId("staff-add-name"), { target: { value: "Rina" } });
  }

  it("creates the account with the credentials the admin typed", async () => {
    await openForm();
    fill();
    fireEvent.change(screen.getByTestId("staff-add-role"), { target: { value: "biller" } });
    fireEvent.click(screen.getByTestId("staff-add-save"));
    await waitFor(() => expect(createUserAccount).toHaveBeenCalledWith({
      email: "rina@shop.test", password: "sunflower9", name: "Rina", role: "biller",
    }));
  });

  it("asks for no user id at all", async () => {
    // The uuid was a value nobody could obtain without the Supabase dashboard.
    await openForm();
    expect(screen.queryByTestId("staff-add-id")).toBeNull();
  });

  it("refuses a bad address before an account is created", async () => {
    // The round trip mints a real auth account, so an obvious slip is worth catching
    // against its own field first.
    await openForm();
    fill();
    fireEvent.change(screen.getByTestId("staff-add-email"), { target: { value: "rina" } });
    fireEvent.click(screen.getByTestId("staff-add-save"));
    expect(await screen.findByTestId("staff-add-error-email")).toBeTruthy();
    expect(createUserAccount).not.toHaveBeenCalled();
  });

  it("refuses a short password before an account is created", async () => {
    await openForm();
    fill();
    fireEvent.change(screen.getByTestId("staff-add-password"), { target: { value: "abc" } });
    fireEvent.click(screen.getByTestId("staff-add-save"));
    expect(await screen.findByTestId("staff-add-error-password")).toBeTruthy();
    expect(createUserAccount).not.toHaveBeenCalled();
  });

  it("reloads the roster after a successful add", async () => {
    await openForm();
    expect(listStaff).toHaveBeenCalledTimes(1);
    fill();
    fireEvent.click(screen.getByTestId("staff-add-save"));
    await waitFor(() => expect(listStaff).toHaveBeenCalledTimes(2));
    expect(await screen.findByTestId("staff-added")).toBeTruthy();
  });

  it("names an address already in use, and keeps the form filled", async () => {
    createUserAccount.mockResolvedValueOnce({
      error: { key: "error.emailTaken", detail: "" },
    });
    await openForm();
    fill();
    fireEvent.click(screen.getByTestId("staff-add-save"));
    expect(await screen.findByText(/already (has an account|in use)|पहले से|आधीच/i)).toBeTruthy();
    expect((screen.getByTestId("staff-add-email") as HTMLInputElement).value).toBe("rina@shop.test");
  });

  it("does not claim success when the call failed", async () => {
    createUserAccount.mockResolvedValueOnce({ error: { key: "error.notAllowed", detail: "" } });
    await openForm();
    fill();
    fireEvent.click(screen.getByTestId("staff-add-save"));
    await waitFor(() => expect(createUserAccount).toHaveBeenCalled());
    expect(screen.queryByTestId("staff-added")).toBeNull();
  });

  it("never puts the password in the DOM as readable text", async () => {
    // A shop counter is not a private place, and this field is filled while someone reads
    // the password out.
    await openForm();
    fill();
    expect((screen.getByTestId("staff-add-password") as HTMLInputElement).type).toBe("password");
  });
});
```

Replace the `createStaff` mock at the top of that file with:

```typescript
const createUserAccount = vi.fn(async (..._a: unknown[]): Promise<{
  error: { key: string; detail: string } | null;
}> => ({ error: null }));

vi.mock("../adminApi", () => ({
  createUserAccount: (...a: unknown[]) => createUserAccount(...a),
}));
```

and remove `createStaff` from the `vi.mock("../admin", ...)` factory.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd web && npx vitest run src/__tests__/Staff.test.tsx`
Expected: FAIL — the form still renders `staff-add-id` and calls `createStaff`.

- [ ] **Step 3: Rewrite the form**

In `web/src/screens/Staff.tsx`:

Change the imports:

```typescript
import { listStaff, updateStaff, removeStaff, type StaffRow } from "../admin";
import { createUserAccount } from "../adminApi";
import { canEditStaff, validateNewStaff, type NewStaffInput, type NewStaffField } from "../adminRules";
```

Replace the `add()` function with:

```typescript
  async function add() {
    if (!adding) return;
    setAdded(false);
    setProblem(null);
    const result = validateNewStaff(adding);
    if (!result.ok) { setAddErrors(result.errors); return; }
    setAddErrors({});
    setBusy(true);
    const { error } = await createUserAccount(result.value);
    setBusy(false);
    setProblem(error);
    // Leave the form filled on failure. "That address already has an account" is the
    // common miss, and it is fixed by editing what is on screen.
    if (error) return;
    setAdding(null);
    await load();
    setAdded(true);
  }
```

Change the blank the Add button seeds:

```typescript
            setAdding({ email: "", password: "", name: "", role: "recorder" });
```

Replace the User ID field block with these two:

```typescript
          <div>
            <label className="block text-sm text-slate-600 mb-1" htmlFor="staff-add-email">
              {t("staff.email")}
            </label>
            <input
              id="staff-add-email" data-testid="staff-add-email" type="email" value={adding.email}
              autoComplete="off" spellCheck={false}
              onChange={(e) => setAdding({ ...adding, email: e.target.value })}
              className="w-full border border-slate-300 rounded-lg px-3 py-2 min-h-[44px]"
            />
            {addErrors.email && (
              <p data-testid="staff-add-error-email" className="text-xs text-red-700 mt-1">
                {t(addErrors.email)}
              </p>
            )}
          </div>
          <div>
            <label className="block text-sm text-slate-600 mb-1" htmlFor="staff-add-password">
              {t("staff.password")}
            </label>
            {/* type=password even though the admin is typing it themselves: a shop counter
                is not a private place, and this is filled while someone reads it out. */}
            <input
              id="staff-add-password" data-testid="staff-add-password" type="password"
              value={adding.password} autoComplete="new-password"
              onChange={(e) => setAdding({ ...adding, password: e.target.value })}
              className="w-full border border-slate-300 rounded-lg px-3 py-2 min-h-[44px]"
            />
            <p className="text-xs text-slate-500 mt-1">{t("staff.passwordHint")}</p>
            {addErrors.password && (
              <p data-testid="staff-add-error-password" className="text-xs text-red-700 mt-1">
                {t(addErrors.password)}
              </p>
            )}
          </div>
```

Replace the `staff.signUpFirst` note at the top of the screen with `staff.adminCreates`, and update the screen's doc comment: it no longer links an existing account, it creates one.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd web && npx vitest run src/__tests__/Staff.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add web/src/screens/Staff.tsx web/src/__tests__/Staff.test.tsx
git commit -m "feat: create the account from Add staff instead of linking one"
```

---

### Task 9: Translations, the reworded panel, and the runbook

**Files:**
- Modify: `web/src/i18n/en.json`, `web/src/i18n/hi.json`, `web/src/i18n/mr.json`
- Modify: `web/src/App.tsx` (the `Unmapped` panel's wording)
- Modify: `docs/runbook-first-admin.md` ("Adding staff after the first admin")

**Interfaces:**
- Consumes: every `t()` key introduced by Tasks 5, 7 and 8.
- Produces: no new exports.

**Add** — `staff.email`, `staff.password`, `staff.passwordHint`, `staff.badEmail`, `staff.badPassword`, `staff.adminCreates`; `changePw.title/body/new/confirm/save/tooShort/mismatch/failed`; `error.emailTaken`, `error.weakPassword`, `error.staffNotCreated`.

**Retire** — `staff.badId`, `staff.userId`, `staff.signUpFirst`, `error.staffExists` (the primary-key collision it named is now `email_taken` from the function), `session.sendIdToAdmin`.

**Keep, reworded** — `session.copyId` / `session.copied` stay; the unmapped panel keeps the user id for support, but the line above it must stop telling people to send it to an admin, because nobody needs it any more. The panel is now reached only by a failure — an account made in the dashboard, or the rare case where `link_failed`'s compensating delete also failed.

- [ ] **Step 1: Write the failing test**

Add to `web/src/__tests__/i18n-init.test.ts`, inside the existing "has every key the shell renders" test, extending its array:

```typescript
      "staff.email", "staff.password", "staff.passwordHint", "staff.badEmail",
      "staff.badPassword", "staff.adminCreates",
      "changePw.title", "changePw.body", "changePw.new", "changePw.confirm",
      "changePw.save", "changePw.tooShort", "changePw.mismatch", "changePw.failed",
      "error.emailTaken", "error.weakPassword", "error.staffNotCreated",
```

And add a new test to that file:

```typescript
  it("has retired every key the uuid flow used", () => {
    // Left behind, these read as live copy to the next person to open the file, and one of
    // them (staff.badId) taught an admin to expect a value the app no longer asks for.
    for (const key of ["staff.badId", "staff.userId", "staff.signUpFirst",
                       "error.staffExists", "session.sendIdToAdmin"]) {
      for (const lang of ["en", "hi", "mr"]) {
        expect(i18n.getResource(lang, "translation", key), `${lang} still has ${key}`)
          .toBeUndefined();
      }
    }
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd web && npx vitest run src/__tests__/i18n-init.test.ts`
Expected: FAIL — the new keys are missing and the retired ones are still present.

- [ ] **Step 3: Write the English strings**

In `web/src/i18n/en.json`. Note the file's shape: `error` and `session` are single-line objects; `staff` is multi-line. Match whichever block you are editing.

```
error.emailTaken:      "That email address already has an account. If they work here already, they are in the list below."
error.weakPassword:    "That password is too short. Use at least 8 characters."
error.staffNotCreated: "The account could not be created, and nothing was saved. Try again."

staff.email:        "Email"
staff.password:     "First password"
staff.passwordHint: "At least 8 characters. Tell them this password — they will be asked to change it when they first sign in."
staff.badEmail:     "Enter an email address."
staff.badPassword:  "Use at least 8 characters."
staff.adminCreates: "You create the account here. Give them the email and password you set, and they will be asked to choose their own password when they first sign in."

changePw.title:    "Choose your own password"
changePw.body:     "You are signed in as {{email}} with a password an admin chose. Set your own before you continue."
changePw.new:      "New password"
changePw.confirm:  "New password again"
changePw.save:     "Save password"
changePw.tooShort: "Use at least 8 characters."
changePw.mismatch: "The two passwords do not match."
changePw.failed:   "The password could not be changed. Try again."
```

Reword `session.sendIdToAdmin`'s replacement — the panel keeps a line, but it now describes a fault rather than a step:

```
session.notLinkedHelp: "Ask your shop's admin to add you. If they already did, show them this id."
```

- [ ] **Step 4: Write the Hindi and Marathi strings**

Translate all of the above into `hi.json` and `mr.json`. **Follow each file's own terminator convention** — `hi.json` uses the danda (`।`), `mr.json` uses a full stop. Keep the transliterations the rest of the app uses (पासवर्ड, ईमेल).

These are AI-written like every other Indian-language string in this project and have never been reviewed by a speaker — see `docs/superpowers/specs/`'s standing note and the README backlog. Do not let that block the merge; it never has been a blocker. Do add the new key count to the README note if it tracks one.

- [ ] **Step 5: Remove the retired keys and reword the panel**

Delete the five retired keys from all three files. In `web/src/App.tsx`, change the `Unmapped` panel's line from `t("session.sendIdToAdmin")` to `t("session.notLinkedHelp")` and update its doc comment: the panel is now reached only by a failure, not as a step in the normal flow.

- [ ] **Step 6: Verify key parity across the three files**

Run:

```bash
cd "D:/AI Project/vendor-app" && python -c "
import json,io
def keys(o,p=''):
    out=set()
    for k,v in o.items():
        out |= keys(v, p+k+'.') if isinstance(v,dict) else {p+k}
    return out
en=keys(json.load(io.open('web/src/i18n/en.json',encoding='utf-8')))
for l in ('hi','mr'):
    other=keys(json.load(io.open(f'web/src/i18n/{l}.json',encoding='utf-8')))
    assert en==other, (l, en^other)
print('parity ok:', len(en), 'keys')"
```

Expected: `parity ok: <N> keys` with no assertion error.

- [ ] **Step 7: Update the runbook**

In `docs/runbook-first-admin.md`, rewrite the "Adding staff after the first admin" section. It currently describes the three-step sign-up-then-paste-a-uuid flow, which no longer exists. It should say: the admin fills in email, password, name and role in Settings → Staff; the person signs in with those and is asked to choose their own password. Keep the bootstrap steps 1–4 unchanged — the first admin still has no admin to create them.

Add a line noting that this path depends on the `admin-create-user` function being deployed, and that the SQL insert in step 3 remains the recovery route if it is not.

- [ ] **Step 8: Run the full suites**

Run: `cd web && npx vitest run` and, from the root, `npm test`
Expected: both green.

- [ ] **Step 9: Commit**

```bash
git add web/src/i18n/ web/src/App.tsx web/src/__tests__/i18n-init.test.ts docs/runbook-first-admin.md
git commit -m "feat: copy for admin-created accounts, and retire the uuid flow's strings"
```

---

### Task 10: Full verification and the deployment note

**Files:**
- Modify: `README.md` (the backlog / "what the local suite does not cover" note)

**Interfaces:**
- Consumes: everything above.
- Produces: nothing.

- [ ] **Step 1: Run every suite and the type check**

Run each and record the actual output — do not claim any of them without it:

```bash
cd "D:/AI Project/vendor-app" && npm test
cd "D:/AI Project/vendor-app/web" && npm test
cd "D:/AI Project/vendor-app/web" && npx tsc --noEmit
```

Expected: 81 passed in the database suite; the web suite green; `tsc` exit 0.

`tsc` passing locally is **not** evidence CI will pass: TypeScript 7 is a per-platform native binary and the Linux build has rejected code Windows accepted. The CI `web` job is the real check.

- [ ] **Step 2: Confirm the key never reached the bundle**

```bash
cd "D:/AI Project/vendor-app/web" && npm run build && grep -ri "service_role" dist/ || echo "clean"
```

Expected: `clean`. A hit is a release blocker.

- [ ] **Step 3: Record what remains unproven**

Add to the README's existing "What the local suite does not cover" note: the `admin-create-user` function itself is not exercised by any test — `tests/run.mjs` has no Deno runtime and the local suite runs no GoTrue. Its guards are covered by `web/src/__tests__/guards.test.ts`; the deployed path is unverified until a real admin creates a real user on Cloud.

- [ ] **Step 4: Commit**

```bash
git add README.md
git commit -m "docs: record that the Edge Function itself is unverified locally"
```

- [ ] **Step 5: Hand over the deployment, in order**

Do **not** run these. They target the vendor's Cloud project, which this repository's tooling never touches. Present them and stop:

```bash
supabase functions deploy admin-create-user
supabase db push
```

Then, and only then, merge the client change. This ordering is not a preference: on 2026-09-09 the SPA deployed ahead of migrations `0006` and `0007` and the live dashboard broke until the push landed, because it called functions that did not yet exist.

At deploy time, **verify that `SUPABASE_SERVICE_ROLE_KEY` and `SUPABASE_URL` are actually present in the function's environment.** The spec assumes the platform injects them; if that has changed, set them with `supabase secrets set` — nothing else about the design moves.

---

## Self-Review

**Spec coverage.** Architecture steps 1–5 → Task 3. Hand-written guards → Tasks 2 and 3. Compensating delete → Task 3 step 1, asserted in Task 5's `link_failed` test. Forced password change (column, function, session kind, screen, ordering) → Tasks 1, 6, 7. `adminApi.ts` separation and error mapping → Task 5. `validateNewStaff` and password floor 8 → Tasks 2 and 4. Form fields → Task 8. Unmapped panel kept and reworded → Task 9. Local-suite boundaries → Tasks 1, 2, 3 headers and Task 10 step 3. Deployment order and secret verification → Task 10 step 5. No section is unclaimed.

**Placeholders.** None. Every code step carries real code; the only prose-only steps are the translations in Task 9 step 4 (which cannot be pre-written without inventing unreviewed Hindi and Marathi in a plan file rather than in the locale files where the backlog tracks them) and the two documentation steps, both of which state exactly what must be said.

**Type consistency.** `NewStaffValue` is `{ email, password, name, role }` in Task 4 and consumed with those names in Tasks 5 and 8. `ErrorCode` is defined once in Task 2 and imported by Tasks 3 and 5. `MIN_PASSWORD_LENGTH` has one definition (Task 2) and three importers (Tasks 4, 7, and the test in Task 4). `complete_password_change` takes no arguments in Task 1 and is called with none in Task 7. `must_change_password` is spelled identically in the migration, `AppUserRow`, the `select`, and the function's insert.

**One risk worth naming.** Tasks 4, 5 and 7 import from `supabase/functions/` into `web/src/`, which crosses `web/`'s `rootDir`. Task 2 step 5 catches this before it spreads. If the `tsconfig` change proves messy, the fallback is to duplicate `MIN_PASSWORD_LENGTH` and `ErrorCode` in `web/src/` with a comment pointing at the original — worse, because the numbers can then drift, which is the failure Task 4's fifth test exists to catch.
