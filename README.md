# Vendor App — database foundation

The Postgres foundation for a vegetable & fruit vendor management app on self-hosted
Supabase. One project serves many vendors, tenanted by `vendor_id`.

- Product spec: [`../SKILLVendor.md`](../SKILLVendor.md)
- Design: [`../docs/superpowers/specs/2026-09-07-vegetable-vendor-app-design.md`](../docs/superpowers/specs/2026-09-07-vegetable-vendor-app-design.md)
- Plan this implements: [`../docs/superpowers/plans/2026-09-07-vendor-app-database-foundation.md`](../docs/superpowers/plans/2026-09-07-vendor-app-database-foundation.md)

## ⚠️ Nothing here has ever been executed

Docker was not installed on the machine where this was written, so `supabase start` could
not run. **No migration has been applied to a Postgres instance and no test in
`tests/` has ever been executed.** Every file was written, read back, and reviewed by
eye; the JavaScript passed `node --check` and nothing more.

Treat the whole of `supabase/migrations/` as unverified until the suite below runs green.
The first run will very likely surface transcription-level errors that only a real
Postgres can find.

### How to verify

```bash
# 1. Install Docker Desktop, and confirm it answers
docker --version

# 2. Bring up the local stack (ports 55321 API / 55322 DB — deliberately not the
#    54321/54322 that the unrelated onevio-crm project in this repo uses)
cd vendor-app
supabase start

# 3. Export the keys the harness needs
supabase status -o json     # copy anon and service_role keys
export SUPABASE_ANON_KEY=...
export SUPABASE_SERVICE_ROLE_KEY=...

# 4. Run the suite. The exit code is the gate — never pipe it.
npm install
npm test
```

`tests/fixtures.mjs` drops and rebuilds the `public` schema from
`supabase/migrations/` in filename order on every run, so the suite is repeatable.

## What is here

| Migration | Contents |
|---|---|
| `0001_schema.sql` | Ten tables, every one carrying `vendor_id` |
| `0002_rls.sql` | RLS on all ten, plus `current_vendor_id()` / `current_user_role()` |
| `0003_functions.sql` | `issue_token`, `complete_bill`, `customer_points_balance` |
| `0004_views.sql` | Eight dashboard views, all `security_invoker = true` |
| `0005_cron.sql` | `expire_points()` and its daily pg_cron schedule |

The security model in one line: **there is no application server**, so RLS is the entire
authorization layer, and the operations that must not be forgeable — token issuance,
stock decrements, points awards — live in `SECURITY DEFINER` functions that carry their
own role and tenant guards, because a definer function bypasses RLS.

## Known unknowns

- **pg_cron may not be available on the local CLI stack** without extra configuration
  (`shared_preload_libraries`). If `0005_cron.sql` fails at `create extension`, split the
  `cron.schedule` call into a deploy-only file and keep `expire_points()` in the
  migration — the tests cover the function, not the schedule.
- Points expiry is correct on *read* regardless (`customer_points_balance` filters on
  `expires_at`); the sweep exists to make the lapse an auditable ledger event.

## Not in this slice

Edge Functions (`whatsapp-webhook`, `send-notifications`), the React SPA, and Drive
integration are slices 2–4 in the design spec. Outbound WhatsApp messages are already
queued into `outbound_messages` by the billing functions, so wiring a BSP later is a
delivery job, not a redesign.
