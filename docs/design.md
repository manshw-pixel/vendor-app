# Vegetable & fruit vendor app

Date: 2026-09-07
Status: approved for implementation

## Problem

Each vegetable and fruit vendor runs their shop on paper. Prices and stock live in a
notebook, bills are handwritten, the queue at the billing counter has no order to it, and
loyalty is a promise nobody can audit. There is no way to answer "what sold most last
week", "which two items do people buy together", or "am I about to run out of onions".

`SKILLVendor.md` is the authoritative product spec for the app that replaces that. This
document is the technical design for building it. It does not re-open the decisions locked
there — Supabase Cloud, one project tenanted by `vendor_id`, RLS everywhere,
three roles, pg_cron and Edge Functions instead of n8n, WhatsApp via a BSP, Drive for
images and PDFs only. It settles how those decisions become code, and records the four
choices the spec left to the builder.

The app is **per-vendor private tooling**, not a buyer-facing marketplace. Every vendor
runs the same deployment; RLS is what keeps vendor A from ever seeing vendor B.

## Goals

- A vendor's staff can price items, track stock in kg, record a bill, issue a token, take
  payment, and have the customer's points appear — correctly under concurrency.
- Vendor isolation and role separation are enforced by the database and proven by tests,
  not asserted by the UI.
- Every requirement in `SKILLVendor.md` (#1–#20, #19 intentionally absent) has a named
  home in the schema, a function, a view, or a screen.
- WhatsApp is wired in later without redesign.

## Non-goals

- Payments. The customer pays cash or UPI at the counter; the app records the total, it
  does not move money.
- A buyer-facing app or web storefront. Customers touch this system only through WhatsApp.
- Multi-shop-per-vendor, or inventory purchasing/supplier workflows.
- Offline-first operation. The counter is assumed online; degraded-network handling is a
  later concern.
- Anything in the `onevio-crm` project that shares this directory. The two are unrelated.

## Four choices the spec left open

| Choice | Decision | Why |
|---|---|---|
| Location | New self-contained `vendor-app/` subfolder | This directory already holds `onevio-crm` (FastAPI + esbuild). Keeping the vendor app in its own tree means its `supabase/`, tests and build never tangle with that project, and it can be lifted into its own repo unchanged. |
| WhatsApp sequencing | Queue events now, wire the BSP later | Meta business verification and template approval take days-to-weeks. Deferring the *sender* costs one adapter interface; deferring the *events* would cost a redesign. |
| Frontend | React + Vite + TypeScript, supabase-js, react-i18next, Tailwind | A private authenticated staff tool with no server of its own. Next.js's SSR and route handlers earn nothing here; `onevio-crm`'s vendored-UMD esbuild setup is a rough DX for a multi-screen i18n app. |
| First slice | Database foundation, no frontend | `SKILLVendor.md` build order step 3 — "verify RLS with two vendors and each role before anything else". A UI built on unproven isolation is a UI that has to be re-audited. |

## Architecture

One Supabase Cloud project. A single React SPA is the only client. There is no
application server of ours: the SPA talks to Postgres through PostgREST carrying the
signed-in user's JWT.

Two consequences drive everything below.

**RLS is the entire authorization layer.** Not a defence-in-depth layer behind an API that
also checks — the only one. Every table has RLS enabled and policies written against the
JWT's vendor and role. A missing policy is not a degraded experience, it is a data breach
between vendors.

**Anything that must not be forgeable is a `SECURITY DEFINER` function.** Token issuance,
stock decrements and points awards are never client-side writes. The client may *call*
`issue_token` and `complete_bill`; it has no write policy on `vendor_counters`,
`points_ledger`, or `items.stock_kg` at all. This is what stops a recorder from opening
devtools and awarding themselves 10,000 points.

```
vendor-app/
  supabase/
    migrations/
      0001_schema.sql      tables, constraints, indexes
      0002_rls.sql         enable RLS + policies on every table
      0003_functions.sql   issue_token, complete_bill, customer_points_balance
      0004_views.sql       dashboard views (security_invoker = true)
      0005_cron.sql        pg_cron: points expiry sweep, daily rollup
    functions/
      whatsapp-webhook/    inbound bot  (#17 balance, #20 suggestions)
      send-notifications/  drains outbound_messages (#13, #16, #18)
  web/                     React + Vite + TS SPA
  tests/
    rls/                   two vendors x three roles isolation suite
    functions/             concurrency and idempotency tests
```

## Data model

Tables are as `SKILLVendor.md` lists them. Every table carries `vendor_id`, denormalised
onto child tables (`bill_items` included) so each policy is a plain column check rather
than a join — a join in a policy is both slower and easier to get subtly wrong.

`vendors`, `vendor_counters`, `app_users`, `items`, `customers`, `bills`, `bill_items`,
`points_ledger`, `stock_requests` carry the columns named in the spec.

Two additions the spec implies but does not name:

**`outbound_messages`** — `id, vendor_id, customer_id, template_key, payload jsonb,
status ('pending'|'sent'|'failed'), attempts, created_at, sent_at, last_error`.

Every message the app initiates (#13 token, #16 points, #18 in-stock) is an *insert into
this table inside the transaction that caused it*. Delivery is then a separate concern
that can fail, retry, and be observed without ever corrupting a bill. If we called the
Meta API inline from `complete_bill`, a WhatsApp outage would roll back completed sales.

**`item_pair_counts`** — a view, not a table. Recomputing #8 on read is cheap at a single
vendor's data volume, and a materialised pair table is a cache to invalidate for no gain.

### Row shapes worth pinning down

- `customers.name`, `flat_no`, `mobile` are all `NOT NULL` (#11). Mobile is stored
  normalised to E.164 so the WhatsApp webhook can look a customer up by sender number.
- `bills.status` is an enum-checked text: `recording` → `billed` → `done`. Transitions
  happen only inside the two functions.
- `points_ledger` is append-only: no update or delete policy exists for any role.
  Redemptions are negative rows. A balance is a `sum`, never a stored counter — a stored
  counter is the thing that drifts and cannot be audited.

## The billing lifecycle

Two functions own it, and nothing else mutates a bill's terminal state.

**`issue_token(bill_id)`** — called by the recorder when the basket is final (#12).

```sql
update vendor_counters
   set last_token = last_token + 1
 where vendor_id = v
returning last_token
```

Atomic under `UPDATE … RETURNING`; the row lock serialises concurrent recorders. The spec
is explicit that `max(token_no) + 1` in app code is forbidden, and this is why: two
recorders pressing Done in the same second would otherwise hand two customers the same
token. The function sets `status = 'billed'`, stamps `token_no`, and inserts the #13
token-and-total message into `outbound_messages`.

**`complete_bill(bill_id)`** — called by the biller when payment is taken (#14).

In one transaction: decrement `items.stock_kg` by each line's `qty_kg`; read *this
vendor's* `points_threshold_1/2` and `points_reward_1/2` (#5, #15 — thresholds are vendor
config, not constants, even though they default to 600→50 and 1000→100); insert one
`points_ledger` row with `expires_at = now() + redeem_days`; set `status = 'done'` and
`completed_at`; queue the #16 points message.

All of it or none of it. A bill that is `done` with stock unadjusted, or points awarded
twice, is the failure mode this design exists to prevent — so `complete_bill` is
idempotent by guard: it takes the bill row `FOR UPDATE` and returns early unless the
status is still `billed`.

## Roles

Enforced in policies against the caller's role, resolved from `app_users`:

- **admin** — items, prices, stock, vendor config, and creating recorder/biller users
  (#2–#5). No billing.
- **recorder** — creates customers, creates and edits bills while `recording`, calls
  `issue_token` (#12). Cannot complete a bill or touch stock.
- **biller** — calls `complete_bill` (#14). Cannot alter basket lines.

The UI hides what a role cannot do, but hiding is a courtesy; the policy is the rule.

## Dashboards and notifications

All dashboard reads are SQL views with `security_invoker = true`, so a view inherits the
caller's RLS instead of leaking across vendors under the definer's rights.

- **#6 payments collected** — daily/weekly/monthly sums over `bills where status='done'`.
- **#7 most items sold** — `sum(qty_kg)` grouped by item over `bill_items`.
- **#8 bought-together** — self-join `bill_items a, b on a.bill_id = b.bill_id and
  a.item_id < b.item_id`, restricted to `done` bills, grouped by the pair, with
  `having count(distinct bill_id) >= 3`. The threshold of 3 is fixed by the spec.
- **#9 low-stock bell** — Supabase Realtime subscription on `items` where `stock_kg < 10`.
  The threshold is fixed by the spec at 10 kg.
- **#10 out-of-stock requests** — count over `stock_requests`, fed by #20.
- **#18 in-stock** — qualifies when `stock_kg > 0`.

## WhatsApp, deferred but not designed around

`send-notifications` is an Edge Function that drains `outbound_messages` where
`status = 'pending'`, behind one interface:

```ts
sendMessage(to: E164, templateKey: string, vars: Record<string, string>): Promise<Result>
```

Two implementations. `log` writes to the function log and marks the row sent — the default
until Meta approves. `meta-cloud` posts to the Cloud API, activated by the presence of
`WHATSAPP_PHONE_NUMBER_ID` and `WHATSAPP_TOKEN`. Swapping them is configuration, not a
code change, and the queue means nothing is lost in between.

`whatsapp-webhook` handles inbound: a customer asking their balance (#17) gets
`sum(points) where expires_at > now()` plus the days remaining to the earliest future
`expires_at`; a customer naming an item we do not stock (#20) gets a `stock_requests` row.
Both are replies inside the 24-hour session window, so neither needs an approved template
— which is why the bot can be built and tested before verification completes.

**Open, owner to supply:** BSP choice (Meta Cloud API is the default) and the opt-in
policy for #18 broadcasts, which are marketing-category templates under Meta's rules and
therefore rate-limited and opt-in only. Neither blocks slice one.

## Testing

The RLS suite is a deliverable of slice one, not a follow-up. It runs against a real
PostgreSQL with the real policies applied and real role-switched sessions, because a
mocked database cannot test the one thing that matters here. It runs on the machine's
native PostgreSQL rather than a container; PostgREST and GoTrue are stood in for, which
is a named gap rather than a hidden one — see the README. The suite wipes its database on
every run, so it is guarded against ever reaching the production Cloud project.

It seeds **two vendors × three roles** and asserts table by table that:

- A session as vendor A reads zero rows belonging to vendor B, on every table.
- A session as vendor A cannot insert or update a row carrying vendor B's `vendor_id`.
- Each role is refused writes outside its remit — a recorder cannot complete a bill,
  a biller cannot change prices, neither can write `points_ledger` directly.

Function tests cover the two races that actually bite:

- **Concurrent `issue_token`** — N parallel calls yield N distinct tokens, no gaps that
  matter and no duplicates.
- **Double `complete_bill`** — calling it twice on one bill awards points once and
  decrements stock once.

Both are SQL tests runnable against the local stack, wired into CI so a dropped policy
turns the suite red rather than shipping.

## Build slices

**Slice 1 — database foundation.** Migrations `0001`–`0005`, the three functions, the
dashboard views, and the RLS and concurrency suites, green. No frontend. This is the
review checkpoint: isolation is proven before anything is built on top of it.

**Slice 2 — Edge Functions.** `whatsapp-webhook` and `send-notifications` with the `log`
sender, plus the pg_cron points-expiry sweep. Testable end to end without Meta.

**Slice 3 — the SPA.** Auth and role routing, i18n (mr/hi/en), item and stock admin,
customer creation, the recorder bill flow with edit-before-Done, the biller completion
screen, dashboards, and the low-stock bell.

**Slice 4 — Drive.** Produce images and generated bill PDFs. Drive is storage, never the
database — that was evaluated and rejected in the product spec.

Meta business verification and template approval start now, in parallel, because they gate
slice 2's switch from `log` to `meta-cloud` and nothing else.
