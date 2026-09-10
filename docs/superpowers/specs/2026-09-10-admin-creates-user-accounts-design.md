# Admin creates user accounts

**Status:** design, not built.
**Supersedes:** §9 of `2026-09-09-slice-4-history-and-dashboards-design.md`, which fixed
this boundary and deferred it. This is that slice, narrowed to the first of its two
features.

## What the vendor asked for

> admin configures the user details first then user can login. id and password admin will
> enter while creation

An admin fills in email, password, name and role. The person then signs in with those
credentials and is already attached to the shop. No sign-up step, no uuid, no runbook.

## Why this needs a server, and the trick that does not work

`auth.admin.createUser` needs the `service_role` key, which carries `bypassrls`. A copy in
the browser bundle is a full database compromise — `web/src/config.ts` says so, and it is
right. So account creation happens server-side.

The obvious cheaper route is a `SECURITY DEFINER` function, which is how
`current_vendor_id()` already reads `app_users` from behind RLS. **It cannot do this one.**
A password has to be hashed and registered by GoTrue: the row in `auth.users` is only part
of it, there is a matching `auth.identities` row, and the shape of both is GoTrue's to
change. Writing them from a migration means this project owns a copy of another service's
internal schema, and a GoTrue upgrade breaks logins with no failing test to warn us.

That route *would* work for **linking an account that already exists** — resolving an email
to an `auth.users.id` is a plain read. It was considered and set aside because the vendor
asked for creation, not linking, and two paths are more surface than one. It is recorded
here as the fallback if the Edge Function path proves unworkable.

## Architecture

```
Settings -> Staff -> Add staff
  |
  | supabase.functions.invoke("admin-create-user", { email, password, name, role })
  | Authorization: the ADMIN's own JWT, attached by supabase-js
  v
Edge Function (Deno)
  |
  |-- 1. anon-key client + caller's JWT: auth.getUser()  -> caller id, signature verified
  |-- 2. same client: select vendor_id, role from app_users where id = <caller>
  |        RLS applies. Caller must be role 'admin'. Their vendor_id is taken FROM HERE,
  |        never from the request body.
  |-- 3. service-role client: auth.admin.createUser({ email_confirm: true })
  |-- 4. service-role client: insert app_users { id, vendor_id, role, name,
  |                                             must_change_password: true }
  |-- 5. if step 4 fails: delete the auth user created in step 3
  v
{ id } | { error: <typed code> }
```

### The function is outside RLS, so every guard is hand-written

It holds the service-role key. None of the policies in `0002_rls.sql` constrain it. This is
the same lesson as `issue_token` — "SECURITY DEFINER bypasses RLS, so the tenant and role
checks that would normally live in policy have to be written here instead" — at higher
stakes, because this one can mint accounts.

Two guards carry the weight:

- **The caller's vendor comes from step 2, never the request body.** An admin cannot create
  a user in another shop, because they never get to say which shop.
- **The caller's admin role is read through RLS with their own JWT**, not asserted by the
  client. Step 1 verifies the token's signature; step 2 reads `app_users` under
  `users_read`, which is already scoped to their tenant.

`verify_jwt = true` in `config.toml` rejects unauthenticated calls at the platform edge.
That is defence in depth, not the check — it proves a valid token, not an admin.

### Step 5 is not optional

If `createUser` succeeds and the `app_users` insert fails, the result is an auth account
that can sign in and resolves to no tenant. Deleting the auth user is the compensating
action. It is best-effort: if the delete itself fails, the person lands on the **"Account
not linked to a shop"** panel — which is precisely why that panel survives this slice
rather than being reverted with the rest of the uuid flow.

## Forced password change

The admin types the password, so the admin knows it. `bills.recorder_id` and
`bills.biller_id` name who did the work, so an admin who keeps that password can record
bills under someone else's name and the history will not show it. The first login closes
that window.

**`app_users.must_change_password boolean not null default false`** (migration `0008`).

It lives on `app_users` rather than in `auth.users.user_metadata` because metadata the user
can write is metadata the user can clear. `app_metadata` would do, but `app_users` is the
row `SessionProvider` already reads and this project already owns.

Clearing it needs care: `users_admin_write` is admin-only, and a recorder must be able to
clear their own flag without being able to touch anything else on the row. A
`SECURITY DEFINER` function does it, matching house style:

```
complete_password_change() -- sets must_change_password = false for auth.uid() ONLY
```

It takes no arguments on purpose. There is no id to pass, so there is no id to forge.

**Session shape.** A new `SessionState` variant, `{ kind: "mustChangePassword", ... }`,
alongside `unmapped` and `error`. Not a field on `ready`: a boolean on `ready` would leave
`Shell` and `Guard` rendering the app behind the prompt, and every screen would have to
remember to check it. A distinct kind makes `App.tsx` unable to reach the routes at all —
the same reason `unmapped` is its own kind.

Order of operations on that screen: `supabase.auth.updateUser({ password })` first, then
`complete_password_change()`. If the second call fails the person is prompted again, which
is harmless. The reverse order would clear the flag and leave the admin's password live.

## Client changes

- **`web/src/adminApi.ts`** (new) — the only module that calls `functions.invoke`, kept
  separate from `admin.ts` because the error shape is different: `FunctionsHttpError`
  carries a response body, not a `PostgrestError`, and `describeError`'s code/message
  matching does not apply to it.
- **`validateNewStaff`** — validates email shape, password length and name instead of a
  uuid. Minimum password length **8**; Supabase's own default floor is 6, and the higher
  number is chosen here rather than inherited so that a change to the platform default does
  not silently weaken it.
- **The Add staff form** — Email, Password, Name, Role. The uuid field and its
  `staff.badId` message go away, along with `createStaff` in `admin.ts`.
- **Error mapping** — the function returns typed codes (`not_admin`, `email_taken`,
  `weak_password`, `create_failed`, `link_failed`) which map to their own keys.
  `email_taken` matters most: it is the ordinary case of adding someone twice.
- **The unmapped panel** stays, reworded away from "send this id to your admin" — nobody
  needs to send an id any more. It keeps the user id visible because the one route to that
  screen is now a failure that needs support, per step 5 above.

## What the local suite can and cannot prove

**Can, and must:** migration `0008` — the column, `complete_password_change()`, that it
clears only the caller's own row, and that it is refused with no session. `tests/shim.sql`
provides `auth.users` and `tests/client.mjs` does `set role authenticated` with real
claims, so these are exercised against a real Postgres with RLS on, not mocked.

**Can, with effort:** the function's guard logic, if the caller-verification and validation
are extracted into a plain module that vitest can import. Worth doing — those are the parts
that matter.

**Cannot:** the deployed function itself. `tests/run.mjs` has no Deno runtime, and
`auth.admin.createUser` is GoTrue, which the local suite does not run at all. This slice
therefore **adds to** the standing gap recorded in the README: nothing in this project has
ever run against real GoTrue. The first proof this works is a real admin creating a real
user on Cloud, and this spec should not pretend otherwise.

## Deployment, and the order it has to happen in

Cloud is the vendor's project and this repository's tooling never touches it. The steps
below are the vendor's to run.

1. `supabase functions deploy admin-create-user`
2. `supabase db push` — migration `0008`
3. **Only then** merge the client change.

Steps 1 and 2 before 3 is not a preference. On 2026-09-09 the SPA deployed ahead of
migrations `0006` and `0007` and the live dashboard broke until the push landed, because it
called functions that did not yet exist. `describeError` now names that failure, which
makes it legible rather than impossible.

**Secrets:** `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are understood to be injected
into the Edge Function environment by the platform, needing no manual secret. **Verify this
at deploy time rather than trusting it here** — if it has changed, the key is set with
`supabase secrets set` and nothing else about the design moves.

## Deliberately not in this slice

- **AI translation of item names**, the other half of §9. It shares the deployment path
  this slice builds, and becomes small once this exists. Its agreed behaviour — AI proposes,
  admin confirms, never silent auto-fill — is unchanged and recorded in §9.
- **Editing a user's password afterwards.** An admin can remove and re-add. Password reset
  by email is GoTrue's own flow and needs no function.
- **Deleting the auth account when staff are removed.** `removeStaff` unlinks and says so;
  making it delete the account is a separate decision with its own confirm.
