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
with all seven migrations applied from `supabase/migrations/` in filename order,
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
| https://manshw-pixel.github.io/vendor-app/ | The SPA (`web/`) — **stages 1-3** |
| https://manshw-pixel.github.io/vendor-app/console.html | The older single-file console |

**Working today:** sign-in, role-based routing, the mr/hi/en language switch, the whole
billing flow — a recorder picks or creates a customer, taps item tiles, enters weights, sees a
running total, presses Done and gets a token; a biller works the queue of billed bills,
completes one, and sees the points that were actually awarded — and, as of stage 3, admin
screens for items and stock, customers, and loyalty settings. As of slice 4, the SPA also
has a completed-bill history at `/completed` (date-filtered, paged) and a dashboards screen
at `/dashboards` (money collected, bill count, top items, bought-together pairs, all
governed by the same date filter). Staff management is folded into `/settings` rather than
its own screen; `/staff` now redirects there. **No screen in the SPA is a placeholder any
more.** `console.html` stays published at `/console.html` — it is not retired in this
slice; whether to retire it is a judgement to make after the vendor has used both.

**What stage 3 does not do, on purpose:**

- **Staff cannot be invited from the SPA.** A person signs up on their own, then an admin
  links their `app_users` row by hand in the SQL editor — see
  [`docs/runbook-first-admin.md`](docs/runbook-first-admin.md). Self-service account
  creation is slice 2's Edge Function, and it does not exist yet.
- **Removing someone from the Staff screen deletes only their `app_users` row.** Their
  sign-in account is not touched; they simply stop resolving to a shop and land on the
  "not linked" screen. And because `bills.recorder_id` and `bills.biller_id` reference
  `app_users` with no `ON DELETE` clause, removing anyone who has ever recorded or
  completed a bill fails with a foreign-key violation — the UI reports this with a
  specific message telling the admin to change the person's role instead of removing
  them. In a shop that has been running a while, that's most of the staff.
- **Stock is set as an absolute figure, and a save overwrites.** A save landing while a
  bill is completing overwrites that bill's decrement. Accepted deliberately, not
  overlooked: `complete_bill()` remains the sole authority for decrements, and the fix if
  the race is ever actually observed is a delta RPC, not a lock.
- **Loyalty settings apply only to bills completed from now on.** `points_ledger` is
  append-only; changing a threshold does not recompute points already awarded.

**What slice 4 does not do, on purpose:**

- **Staff still cannot be invited from the SPA**, even now that Staff lives inside
  `/settings` rather than its own screen — the form and its rules are unchanged, only its
  location moved. Self-service account creation still waits on the Edge Function slice.
- **Item names still require all three languages typed by hand** at `/items`; nothing in
  this slice adds translation help.
- **Dashboard money totals are computed by comparing instants against `bills`, not by
  reading `v_payments_daily`.** That view buckets with `date_trunc('day', completed_at)`,
  which resolves in the database server's timezone — UTC on Supabase — while the shops are
  at UTC+5:30. A sale at 02:00 IST is 20:30 the previous day in UTC, so a UTC-bucketed view
  would attribute the first five and a half hours of every Indian day to the day before.
  The three payment views (`v_payments_daily` among them) remain, and still serve
  `console.html`.

### What has and has not been proven

The suite is **210 web tests plus the 65-case database suite**, both gating every push. But
`supabase-js` is mocked at the `data.ts` / `history.ts` boundary in every SPA test, so **no
part of the SPA has run against real PostgREST or GoTrue.** Stage 1 shipped two Critical
bugs that only a real sign-in would have caught; stage 2 merged before its walkthrough was
done. Stage 3 widened what this leaves uncovered rather than closing it: `vendors`, `items`
and `app_users` are written from the client, and the policies those writes depend on
(`vendors_admin_update`, `items_admin_write`, `users_admin_write`) are covered by
`tests/rls.test.mjs` against a real database, but — like everything else in this list —
have never been exercised through PostgREST or GoTrue. **Slice 4 widens the gap again**:
migration `0007` adds three RPCs the dashboards call directly. Two of them,
`top_items_between` and `collected_between`, ARE exercised through a real PostgREST client
in `tests/analytics.test.mjs` — those are the cross-tenant isolation tests, and they are
the most load-bearing checks on the branch. `bought_together_between` is not: it is only
ever called through a mock in `Dashboards.test.tsx`.

The first thing to check against the live database, nominated independently by two reviewers:
the `customers(name, flat_no)` **embed shape** in the biller's queue. A cast in `Pending.tsx`
erases it, and if PostgREST returns an array rather than an object, every row silently shows
`—` where the customer's name belongs. Silent-and-wrong, and unreachable by any mock.

### Two behaviours worth knowing

**The app opens in English on an English-language phone.** `resolveLang` honours a supported
browser language, and Marathi is the default only when nothing else matches — a phone set to
English is a stated preference, not an absence of one.

**The Hindi and Marathi strings have never been read by a native speaker.** Every one was
written by an AI, including the stage-3 strings for items, customers, staff and settings,
and now the slice-4 strings for completed-bill history and dashboards — the backlog grows
with every stage. They need a Marathi speaker before shop staff use this;
the words `token`, `basket` and `points` were deliberately left transliterated (टोकन,
बास्केट, पॉइंट्स) on the grounds that this is how Indian retail staff speak, and that
judgement in particular wants confirming.

One open question for that reviewer, noted rather than guessed at: **the Marathi sentence
terminator.** `mr.json` ends its sentences with a full stop, `hi.json` with a danda (।).
Slice 4 briefly introduced two danda-terminated Marathi strings and they were normalised
back to full stops for consistency with the other forty-five — but consistency is not the
same as correctness, and nobody on this project can say which is right.

### Known limits in the billing flow

Both are deferred deliberately, and neither needs a migration to fix later:

- **Write idempotency is mitigated, not solved.** If `addLines` commits but its response is
  lost, a retry checks for existing rows first — which narrows the window rather than closing
  it, because check-then-insert is not atomic. The real fix is a replace-lines RPC. Note a
  `unique (bill_id, item_id)` constraint would be **wrong**: a recorder can legitimately weigh
  the same item twice into one basket.
- **A reload between a failed write and its retry orphans a `recording` bill.** Inert today —
  every consumer filters on status, and the counter, stock, points and all four dashboard views
  were checked — but the first history screen that forgets to filter will show phantom ₹0 bills.
  `bills_recorder_delete` already exists, so a cleanup surface needs no migration.

## What is here

| Migration | Contents |
|---|---|
| `0001_schema.sql` | Ten tables, every one carrying `vendor_id` |
| `0002_rls.sql` | RLS on all ten, plus `current_vendor_id()` / `current_user_role()` |
| `0003_functions.sql` | `issue_token`, `complete_bill`, `customer_points_balance` |
| `0004_views.sql` | Eight dashboard views, all `security_invoker = true` |
| `0005_cron.sql` | `expire_points()` and its daily pg_cron schedule |
| `0006_points_threshold_inclusive.sql` | Fixes the points-threshold comparison to be inclusive |
| `0007_analytics_by_date.sql` | `top_items_between` and `bought_together_between` RPCs — the date dimension `v_top_items` / `v_bought_together` never had |

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

**Deployed:** the first five migrations are live on the production project
(`ap-northeast-1`, Postgres 17.6) and verified there — 10 tables, RLS on all 10,
19 policies, 8 `security_invoker` views, 4 functions, and the
`vendor-app-points-expiry` cron job at `0 1 * * *`.

**Migration `0007` must be pushed** (`supabase db push`) for the dashboards screen to work
at all — it adds the `top_items_between`, `bought_together_between` and `collected_between`
RPCs the dashboards call directly, and the Pages workflow deploys only the SPA, never migrations. `0006` (the
points threshold) may still be unpushed too; check before assuming either has landed.

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
