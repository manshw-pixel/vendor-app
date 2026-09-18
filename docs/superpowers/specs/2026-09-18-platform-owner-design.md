# Platform owner: onboard and suspend vendors — design

**Date:** 2026-09-18. **Status:** approved in brainstorm, awaiting spec review.

## Problem

Tenancy is already in the database: every table carries `vendor_id` and RLS keeps shops
apart. What is missing is the person above the shops. Today a new vendor and its first
admin are created by hand in the SQL editor (`docs/runbook-first-admin.md`), and nothing
can stop a shop that should no longer be using the app.

## Decisions taken with the owner

| Question | Decision |
|---|---|
| Owner login | **A separate owner account, outside every vendor.** |
| Onboarding | **Owner creates the vendor and its first admin in one step.** Admin must change the first password on first login. |
| Visibility | **Summary only** per vendor: name, created, suspended state, staff count, bills and sales this month, last bill time. No line-level data. |
| Suspend | **Yes, suspend and reinstate.** Suspended staff cannot sign in or write; data is kept. |

## Approach

A `platform_owners` table names owner accounts. Privileged work (creating an auth user,
banning sign-ins) runs in two Edge Functions with the service-role key, mirroring
`admin-create-user`. Suspension is enforced in the database's role helper, so every
existing role-gated policy and billing function refuses a suspended shop with no
per-table change. Rejected: an owner role inside `app_users` (would force a nullable
tenant into the security boundary) and continuing by SQL editor (does not scale).

## Data model — migration `0019_platform_owner.sql`

- `platform_owners(user_id uuid primary key references auth.users(id) on delete cascade,
  name text not null, created_at timestamptz not null default now())`. RLS on; policy
  `owners_read_self`: select where `user_id = auth.uid()`. No insert/update/delete
  policy: the first owner is inserted by hand once (runbook), later owners likewise.
- `is_platform_owner() returns boolean`, `security definer`, `stable`:
  `exists (select 1 from platform_owners where user_id = auth.uid())`.
- `vendors.suspended_at timestamptz null`. Trigger `vendors_suspension_guard` before
  update: if `suspended_at` changes and `auth.uid() is not null` and
  `not is_platform_owner()` → raise `42501` `only the platform owner may suspend a shop`.
  (Service role has null `auth.uid()`; Edge Functions run as service role.)
- `current_user_role()` redefined (`create or replace`, same signature and definer):
  returns `'suspended'` when the caller's vendor has `suspended_at not null`, else the
  role. `current_vendor_id()` is unchanged, so `vendor_id`-only read policies still
  return the shop's rows until the token expires (≤ 1 h); every write policy and every
  billing function keys on the role and refuses at once. Documented in the migration.
- `owner_vendor_summary()` returns table `(id uuid, name text, created_at timestamptz,
  suspended_at timestamptz, staff_count bigint, bills_month bigint, sales_month numeric,
  last_bill_at timestamptz)`, `security definer`, refuses with `42501` unless
  `is_platform_owner()`. "This month" = calendar month in Asia/Kolkata, the same
  convention `void_bill` uses. Ordered by name. Granted to `authenticated`.

## Edge Functions

### `owner-create-vendor`
Body `{ vendor: { name, address?, phone? }, admin: { name, email, password } }`.
Pure `guards.ts` validation (same style as admin-create-user: email shape, non-blank
names, `MIN_PASSWORD_LENGTH` 8). Flow: verify JWT with the caller's client; check
`platform_owners` under the caller's JWT (RLS lets an owner read their own row; a
non-owner sees nothing → `not_owner` 403); with service role: insert `vendors` → create
auth user (`email_confirm: true`) → insert `app_users` (admin, `must_change_password:
true`). Compensation: if the auth create fails, delete the vendor; if the link fails,
delete the auth user then the vendor. Error codes: `bad_request`, `not_owner`,
`email_taken`, `weak_password`, `vendor_failed`, `create_failed`, `link_failed`.
Returns `{ vendor_id, admin_id }`.

### `owner-suspend-vendor`
Body `{ vendor_id, action: "suspend" | "reinstate" }`. Owner check as above. With service
role: update `vendors.suspended_at` (now() or null); then for every `app_users` row of
that vendor, `auth.admin.updateUserById(id, { ban_duration: "876000h" })` to suspend or
`{ ban_duration: "none" }` to reinstate. Bans stop new sign-ins; the sentinel role stops
writes on existing sessions immediately. Returns `{ banned: n }`. If some bans fail the
function still returns 200 with `{ banned, failed }` and logs, because the DB flag is the
authoritative gate. Codes: `bad_request`, `not_owner`, `not_found`, `update_failed`.

Both get `verify_jwt = true` in `supabase/config.toml`.

## Web

- `session.ts`: new kinds `{ kind: "owner"; userId; email; name }` and
  `{ kind: "suspended"; email; vendorName }`. `AppUserRow.vendors` gains
  `suspended_at: string | null`. `sessionFromRow` returns `suspended` when the vendor is
  suspended (checked before `mustChangePassword`).
- `SessionProvider`: when the `app_users` row is null, read `platform_owners` (own row);
  a row → `owner`; null → `unmapped` as today; error → `error`.
- `App.tsx`: `owner` renders `OwnerConsole` (no Shell); `suspended` renders a
  `Suspended` panel (shop name, "contact the app owner", sign out).
- `ownerApi.ts`: `listVendorSummary()` (rpc), `createVendor(value)` and
  `setVendorSuspended(id, action)` (function invokes with code→key maps, like adminApi).
- `ownerRules.ts`: pure validation for the create form (vendor name, admin name, email,
  password ≥ 8; address/phone optional).
- `screens/OwnerConsole.tsx`: header with owner name and sign out; vendor table with the
  summary columns and a Suspend/Reinstate button per row behind a confirm block; a Create
  vendor form; success line naming the new shop and admin email; errors via the key maps.
- i18n block `owner.*` and `session.suspended*` in en/hi/mr (AI-written, flagged).
- Routes/Shell untouched for shop staff.

## Testing

DB (`tests/platform_owner.test.mjs`): owner reads own row only; staff cannot read or
insert `platform_owners`; `is_platform_owner()` true/false; admin cannot set or clear
`suspended_at` (42501) while the owner-role SQL helper can; after suspension the vendor's
recorder gets 42501 on customer insert and bill insert, `issue_token`/`complete_bill`/
`replace_bill_lines`/`log_stock_movement`/`void_bill` raise, reads still return rows, the
other vendor is unaffected; reinstating restores writes; `owner_vendor_summary()` refuses
a shop admin, and for the owner returns both seeded vendors with correct staff counts,
this-month bill counts/sales and `last_bill_at`. Owners are created in tests by inserting
into `platform_owners` via the owner-role `sql()` helper for a user made with
`makeUser`-style auth rows.

Web: `guards` for both functions (pure), `ownerRules`, `sessionFromRow` suspended/owner,
`SessionProvider` owner fallback, `OwnerConsole` list/create/suspend flows, `App`
renders the console for `owner` and the panel for `suspended`, `adminApi`-style code
mapping for `ownerApi`.

## Deployment

1. Apply 0019 on Cloud as one script; record `('0019','platform_owner')`.
2. Deploy the two Edge Functions (`supabase functions deploy owner-create-vendor` and
   `owner-suspend-vendor`); same 401 caveat as before — if the CLI cannot, paste them in
   the dashboard's function editor.
3. Create your owner login: Authentication → Add user, then
   `insert into platform_owners (user_id, name) values ((select id from auth.users where
   email = '<you>'), '<name>');`.
4. Merge and push.

## Out of scope

Self-signup; charging vendors; owner impersonating a shop; deleting a vendor; owner
tiers; per-vendor feature flags.
