# Vendor App — database foundation

The Postgres foundation for a vegetable & fruit vendor management app on **Supabase
Cloud**. One project serves many vendors, tenanted by `vendor_id`.

**Production is a Supabase Cloud project. Tests run against the machine's native
PostgreSQL** — no Docker, no Supabase CLI stack. The two never meet: the suite wipes its
database on every run, so it is barred from ever reaching Cloud. See
[Running the suite](#running-the-suite) and [Deploying](#deploying).

- Product spec: [`docs/product-spec.md`](docs/product-spec.md)
- Design: [`docs/design.md`](docs/design.md)
- Plan this implements: [`docs/plan-database-foundation.md`](docs/plan-database-foundation.md)

## ✅ Verified: 65 cases, 0 failures

`npm test` runs **65 cases, 0 failures** (exit 0) against native **PostgreSQL 17.9**,
with all five migrations applied from `supabase/migrations/` in filename order,
unmodified — the same files `supabase db push` sends to Cloud.

**RLS is genuinely exercised, not merely present.** Sessions connect as the owner and
then `set role authenticated` with `request.jwt.claims` set, so every policy applies. This
was confirmed by mutation rather than assumed: replacing `items_read`'s tenant check with
`using (true)` makes a cross-tenant read start returning rows, and restoring it blocks
them again. An earlier shim run on this project reported the schema healthy while
testing none of the security model, because it ran as superuser — superuser bypasses RLS
entirely.

Covered:

- **RLS.** Vendor A sees none of vendor B's rows on any of the nine tenant tables, and
  cannot insert or update into vendor B. The role guards hold: recorder and biller are
  refused item price changes, admin is allowed. The `points_ledger` is append-only to
  every role, `vendor_counters` is writable by none, and a recorder cannot append a line
  to an already-billed bill. An anonymous (`anon`) client sees nothing on any table.
- **The billing lifecycle** under RLS: sequential tokens with no collision across 20
  concurrent connections, the tenant and role guards on `issue_token` and `complete_bill`,
  stock decrements, vendor-configured points thresholds, the recomputed line-item total,
  and idempotency on both functions.
- **Points expiry.** `expire_points()` offsets lapsed points, leaves unexpired ones
  alone, and is idempotent across runs.
- **The eight dashboard views**, including that they are `security_invoker` and do not
  leak across vendors.
- **The reset guard** itself — six cases, no database needed.

### What the local suite does not cover

The stack has no PostgREST and no GoTrue, so those are stood in for by
[`tests/shim.sql`](tests/shim.sql) and [`tests/client.mjs`](tests/client.mjs). Honest
limits:

- **GoTrue.** No real signup, session, or JWT. `createUser` inserts into a shim
  `auth.users`; `signInWithPassword` sets claims without verifying a password. The suite
  tests what the database does with a caller's identity, not how that identity is
  established.
- **PostgREST.** The grant surface and its exact error codes are not exercised. The
  correspondence that matters does hold — a policy-blocked write raises 42501 and a
  policy-filtered read returns zero rows, on both — so `assertDenied` and
  `assertInvisible` keep their meanings.
- **`pg_cron`.** Not available on a native Windows build. `create extension pg_cron` is
  stripped and `cron.schedule` is shimmed, so the rest of `0005_cron.sql` still runs and
  registers its job — but nothing here proves pg_cron will *fire* it. The run prints what
  it skipped, above the results.
- **PostgreSQL 17.9 vs production's 17.6.** Same major, minor drift.

Closing these means running the suite against a disposable Supabase Cloud project, which
needs no code changes beyond pointing it there. That remains the eventual target.

## Running the suite

Needs the native PostgreSQL service (`postgresql-x64-17`) running, and a
`vendor_app_test` database. No Docker, no WSL, no Supabase CLI.

```bash
createdb vendor_app_test    # once; or via pgAdmin
npm install
npm test                    # the exit code is the gate -- never pipe it
```

`SUPABASE_DB_URL` defaults to
`postgresql://postgres:postgres@127.0.0.1:5432/vendor_app_test`, so normally nothing
needs exporting at all.

`tests/fixtures.mjs` drops and rebuilds the `public` schema from `supabase/migrations/`
on every run, so the suite is repeatable — which is also why the guard is strict about
*which* database it may touch. Other projects keep databases on this same server.

## Live

| URL | What |
|---|---|
| https://manshw-pixel.github.io/vendor-app/ | The SPA (`web/`) — **stage 1: the shell only** |
| https://manshw-pixel.github.io/vendor-app/console.html | The older single-file console |

Stage 1 of the SPA ships sign-in, role-based routing and the mr/hi/en language switch.
**Every screen behind the nav is a placeholder.** The console remains the way to see
dashboards until stage 4 builds them — see
[`docs/superpowers/specs/2026-09-08-slice-3-spa-design.md`](docs/superpowers/specs/2026-09-08-slice-3-spa-design.md)
for the staged plan.

Note the language switch honours the browser's language when it is one of the three
supported; Marathi is the default only when nothing else matches. A phone set to English
therefore opens in English, which is a stated preference rather than an absence of one.

## What is here

| Migration | Contents |
|---|---|
| `0001_schema.sql` | Ten tables, every one carrying `vendor_id` |
| `0002_rls.sql` | RLS on all ten, plus `current_vendor_id()` / `current_user_role()` |
| `0003_functions.sql` | `issue_token`, `complete_bill`, `customer_points_balance` |
| `0004_views.sql` | Eight dashboard views, all `security_invoker = true` |
| `0005_cron.sql` | `expire_points()` and its daily pg_cron schedule |

| Directory | Contents |
|---|---|
| `web/` | The React + Vite + TypeScript SPA (slice 3) |
| `console.html` | The single-file console that preceded it |
| `tests/` | The 65-case database suite, run against native PostgreSQL |

The security model in one line: **there is no application server**, so RLS is the entire
authorization layer, and the operations that must not be forgeable — token issuance,
stock decrements, points awards — live in `SECURITY DEFINER` functions that carry their
own role and tenant guards, because a definer function bypasses RLS.

## Deploying

**Deploys go to Cloud. Tests never do.** The suite in `tests/` begins by dropping the
`public` schema and deleting every auth user. Two independent things must hold before it
will run, because on a shared local server neither implies the other:

- the host is **loopback** — never Cloud, never a LAN box;
- the database is **`vendor_app_test`** — because other projects' databases live on this
  same PostgreSQL server (onevio-crm's `crm_test` among them), and the reset would drop
  their schema just as happily.

Setting `SUPABASE_PROD_PROJECT_REF` additionally lets a refusal name the production
project rather than merely calling it remote. A stale `SUPABASE_DB_URL` fails closed
instead of wiping something.

Do not weaken that guard; `tests/guard.test.mjs` pins every one of those refusals and
needs no database to run.

Migrations reach Cloud through the CLI, in a shell with no test variables exported:

```bash
supabase login                          # stores a token outside the repo
supabase link --project-ref <prod-ref>  # once per clone
supabase db push                        # applies supabase/migrations/ in order
```

**Deployed:** all five migrations are live on the production project
(`ap-northeast-1`, Postgres 17.6) and verified there — 10 tables, RLS on all 10,
19 policies, 8 `security_invoker` views, 4 functions, and the
`vendor-app-points-expiry` cron job at `0 1 * * *`.

The project is schema-complete but **empty**, and the first admin cannot be created
through the API: `app_users` writes require an existing admin of that vendor, and
`current_vendor_id()` reads from `app_users`. The first vendor and admin are inserted by
hand in the SQL editor after that person signs up — see
[`docs/runbook-first-admin.md`](docs/runbook-first-admin.md).

Credentials live in the CLI's own login or a gitignored `.env` — never in the repo, and
never in `supabase/config.toml`, which is committed. Project refs are not secret, but
they are not committed either: they name which database gets wiped, so they stay in the
environment where you can see them.

`0005_cron.sql` needs the `pg_cron` extension enabled on the project once
(Dashboard → Database → Extensions) before `db push` will succeed.

## Known unknowns

- **Production is in `ap-northeast-1` (Tokyo), not Mumbai.** Deliberate: the project was
  already created there and keeping it was preferred to recreating. With no app server,
  clients reach PostgREST directly, so this is roughly 100-150ms of round trip per query
  from India rather than 20-30. The region cannot be changed in place — moving it would
  mean a new project and a re-push. Worth revisiting if latency shows up in use.
- **The suite does not exercise PostgREST or GoTrue.** See
  [What the local suite does not cover](#what-the-local-suite-does-not-cover). Clients
  reach PostgREST directly in production with no app server in between, so that surface
  is not incidental — it is the runtime. A Cloud test project closes this.
- **`supabase/config.toml` is now vestigial.** Nothing runs `supabase start`. It is kept
  only because `project_id` is what `supabase link` writes against; its `[api]`, `[db]`
  and `[auth]` sections describe a stack that is never brought up.
- Points expiry is correct on *read* regardless (`customer_points_balance` filters on
  `expires_at`); the sweep exists to make the lapse an auditable ledger event.

## Not in this slice

Edge Functions (`whatsapp-webhook`, `send-notifications`), the React SPA, and Drive
integration are slices 2–4 in the design spec. Outbound WhatsApp messages are already
queued into `outbound_messages` by the billing functions, so wiring a BSP later is a
delivery job, not a redesign.
