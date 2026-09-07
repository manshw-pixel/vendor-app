# Vendor App — database foundation

The Postgres foundation for a vegetable & fruit vendor management app on self-hosted
Supabase. One project serves many vendors, tenanted by `vendor_id`.

- Product spec: [`docs/product-spec.md`](docs/product-spec.md)
- Design: [`docs/design.md`](docs/design.md)
- Plan this implements: [`docs/plan-database-foundation.md`](docs/plan-database-foundation.md)

## ⚠️ Partly verified: DDL and the billing lifecycle ran; RLS did not

The full suite in `tests/` still has **never** been executed, because it needs the local
Supabase stack (PostgREST + GoTrue) and Docker Desktop cannot start on this machine —
WSL2 is not installed, so its Linux engine has no backend.

What *has* now been run, against a real PostgreSQL 17 with a thin shim supplying the
`anon`/`authenticated`/`service_role` roles and an `auth.uid()`:

- **All five migrations apply cleanly** in filename order — no syntax or transcription
  errors. Resulting objects: 10 tables (RLS enabled on all 10), 19 policies, 8 views
  (every one `security_invoker=true`), and the three billing functions.
  The one exception is the last two statements of `0005_cron.sql`
  (`create extension pg_cron` + `cron.schedule`), skipped because pg_cron is not
  available on a native Windows build. `expire_points()` itself applies and runs.
- **The billing lifecycle behaves as designed** on the service-role path:
  `issue_token` returns token 1, recomputes a forged `bills.total` of 99999 back down to
  the line-item sum, and rejects a second call on the same bill; `complete_bill` moves
  the bill to `done`, decrements stock (clamped at 0 on an over-sold line, as intended),
  awards the vendor-configured 50 points for a ₹700 bill, and queues both the
  `token_issued` and `points_awarded` outbound messages; `customer_points_balance`
  reports `(50, 30 days)`; `expire_points()` writes 0 rows before the lapse, 1 after,
  and 0 on a second run — the idempotency `is_expiry` exists for — leaving a balance of 0.

What remains unverified, and needs the real stack:

- **Every RLS policy.** The checks above ran as superuser, which bypasses RLS entirely.
  Tenant isolation and the role guards are the whole security model and none of it has
  been exercised.
- Anything reached through PostgREST or GoTrue: the signup/session fixtures, the eight
  dashboard views as seen by an `authenticated` session, and the grant surface.
- The `cron.schedule` call.

### How to finish verifying

Install WSL2 (`wsl --install`, from an elevated prompt, then reboot) so Docker Desktop
can start, then:

```bash
# 1. Confirm the engine answers — not just the client
docker info

# 2. Bring up the local stack (ports 55321 API / 55322 DB — chosen so this stack can
#    run alongside another local Supabase project without colliding)
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
