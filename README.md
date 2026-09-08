# Vendor App — database foundation

The Postgres foundation for a vegetable & fruit vendor management app on **Supabase
Cloud**. One project serves many vendors, tenanted by `vendor_id`.

**Everything runs on Supabase Cloud. Nothing runs locally** — there is no
`supabase start` stack, no Docker requirement. That takes two Cloud projects: a
production one, and a disposable one the test suite is allowed to wipe. See
[Running the suite](#running-the-suite) and [Deploying](#deploying).

- Product spec: [`docs/product-spec.md`](docs/product-spec.md)
- Design: [`docs/design.md`](docs/design.md)
- Plan this implements: [`docs/plan-database-foundation.md`](docs/plan-database-foundation.md)

## Verification status

`npm test` last ran **63 cases, 0 failures** — but against the local `supabase start`
stack, which no longer exists in this project. **That result is historical.** The suite
has not yet been re-run against Cloud, and until it has, treat the coverage below as
"passed once, on a different engine" rather than as a current green.

What the 63 cases cover:

- **RLS.** Vendor A sees none of vendor B's rows on any of the nine tenant tables, and
  cannot insert or update into vendor B. The role guards hold: recorder and biller are
  refused item price changes, admin is allowed. The `points_ledger` is append-only to
  every role, `vendor_counters` is writable by none, and a recorder cannot append a line
  to an already-billed bill. An anonymous client sees nothing on any table.
- **Through PostgREST and GoTrue.** The signup/session fixtures, the grant surface, and
  all eight dashboard views as seen by an `authenticated` session — including that the
  views are `security_invoker` and do not leak across vendors.
- **The billing lifecycle** under RLS: sequential tokens with no collision under
  concurrency, the tenant and role guards on `issue_token` and `complete_bill`, stock
  decrements, vendor-configured points thresholds, the recomputed line-item total, and
  idempotency on both functions.
- **Points expiry.** `expire_points()` offsets lapsed points, leaves unexpired ones
  alone, and is idempotent across runs.
- **`pg_cron`.** `create extension pg_cron` and `cron.schedule` both succeeded, and both
  are available and supported on Cloud.

Re-running these against the test project is what turns this section green again.

## Running the suite

The suite talks to a **Supabase Cloud project set aside for tests**. It is not your
production project, and it must not be: `tests/fixtures.mjs` begins each run by dropping
the `public` schema and deleting every row in `auth.users`, then replaying
`supabase/migrations/` in filename order — which is what makes the suite repeatable, and
what makes it data loss anywhere else.

**One-time setup**

1. Create a second, empty Supabase Cloud project. Free tier is fine.
2. In that project's dashboard, turn **email confirmations off**
   (Authentication → Sign In / Providers). Tests sign up real users and need a session
   immediately; with confirmations on, `signUp` returns `{ session: null }` and every
   downstream assertion fails on a null token. `supabase db push` does *not* push this
   setting — it must be set by hand. Leave it **on** in production.
3. Enable `pg_cron` on it (Database → Extensions), which `0005_cron.sql` needs.
4. Copy `.env.example` to `.env` and fill it in.

**Each run**

```bash
npm install
npm test        # the exit code is the gate -- never pipe it
```

The five required variables are documented in [`.env.example`](.env.example). Two things
the guard is strict about, both of which fail up front with an explanation:

- `SUPABASE_DB_URL` must be a **session-mode** connection on port **5432** (the direct
  connection, or the session pooler). The transaction pooler on 6543 cannot run the
  multi-statement DDL the reset sends, and would fail halfway through a drop.
- `SUPABASE_DB_URL` and `SUPABASE_API_URL` must name the **same** project, and it must be
  the one in `SUPABASE_TEST_PROJECT_REF`.

Free-tier projects pause after inactivity; an unpaused project is a prerequisite, and a
paused one surfaces as a connection failure.

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

## Deploying

**Deploys go to the production project. Tests never do.** Both are on Cloud now, so
"is it local?" can no longer tell them apart — the guard in `tests/fixtures.mjs`
identifies the target instead. It resets the project named by `SUPABASE_TEST_PROJECT_REF`
and refuses everything else: a different ref, a DB and API pointed at different projects,
an unset ref, `SUPABASE_PROD_PROJECT_REF`, or anything it cannot parse a ref out of. A
stale `SUPABASE_DB_URL` in a deploy shell therefore fails closed instead of wiping the
project. Do not weaken that guard; `tests/guard.test.mjs` pins every one of those
refusals and needs no database to run.

Migrations reach Cloud through the CLI, in a shell with no test variables exported:

```bash
supabase login                          # stores a token outside the repo
supabase link --project-ref <your-ref>  # once per clone
supabase db push                        # applies supabase/migrations/ in order
```

Credentials live in the CLI's own login or a gitignored `.env` — never in the repo, and
never in `supabase/config.toml`, which is committed. Project refs are not secret, but
they are not committed either: they name which database gets wiped, so they stay in the
environment where you can see them.

`0005_cron.sql` needs the `pg_cron` extension enabled on the project once
(Dashboard → Database → Extensions) before `db push` will succeed.

## Known unknowns

- **The suite has not yet run against Cloud.** The 63 cases passed on Postgres 15.8
  locally; the two Cloud projects may well be on a different major. Confirm the test and
  production projects run the *same* major as each other — that is the comparison that
  matters now, and `supabase/config.toml` no longer pins one.
- **Cloud is slower and shared.** The reset is a full schema drop and five migrations
  over the network on every run, and the concurrency case in the token tests was written
  against a loopback database. Watch for timeouts on the first Cloud run.
- ~~pg_cron may not install locally.~~ Moot: nothing is local. It is available and
  supported on Cloud, and must be enabled per project before `db push`.
- Points expiry is correct on *read* regardless (`customer_points_balance` filters on
  `expires_at`); the sweep exists to make the lapse an auditable ledger event.

## Not in this slice

Edge Functions (`whatsapp-webhook`, `send-notifications`), the React SPA, and Drive
integration are slices 2–4 in the design spec. Outbound WhatsApp messages are already
queued into `outbound_messages` by the billing functions, so wiring a BSP later is a
delivery job, not a redesign.
