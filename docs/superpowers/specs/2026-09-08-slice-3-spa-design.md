# Slice 3 — the staff SPA

**Status:** design, approved 2026-09-08. Not yet implemented.

**Scope:** the eight items `docs/design.md` lists for slice 3 — auth and role routing,
i18n (mr/hi/en), item and stock admin, customer creation, the recorder bill flow with
edit-before-Done, the biller completion screen, dashboards, and the low-stock bell.

**Depends on:** slice 1 (deployed and verified on production). Slice 2 (Edge Functions) is
*not* built and is not a blocker — the billing functions already queue rows into
`outbound_messages` inside their own transaction, so nothing sends and nothing is lost.

**Supersedes for the frontend:** `console.html`, which stays available at `/console.html`
as a fallback but is not extended further.

---

## 1. Context and constraints

Three facts drive every decision below. All three are inherited, not chosen here.

**There is no application server.** The SPA talks to Postgres through PostgREST carrying
the signed-in user's JWT. Every read and write is subject to RLS.

**RLS is the entire authorization layer**, not a layer behind an API that also checks.
This has a direct consequence for the UI: a route guard, a hidden button and a disabled
field are all *conveniences*. None of them is a control. The code must say so where it
would otherwise be tempting to read a guard as protection.

**Anything unforgeable is a `SECURITY DEFINER` function.** The client may call
`issue_token` and `complete_bill`; it has no write policy on `vendor_counters`,
`points_ledger`, or `items.stock_kg` at all.

### Usage context

Mobile-first: recorders and billers work on Android phones in the shop, one-handed, while
weighing produce, on mobile data that drops. Admin may use a larger screen occasionally,
but there is no desktop-only affordance.

### Online-only, failing honestly

Token numbers are issued atomically in the database and can never be generated offline, so
offline bill submission is not attempted. Instead:

- an offline banner appears when `navigator.onLine` is false;
- **Done is disabled while offline**, rather than failing after the recorder has told the
  customer a token is coming;
- transient failures retry;
- bill lines live in local state, so a failed call never destroys typed work.

Rejected: draft-offline-and-sync (a token arriving after the customer has walked to the
counter is worse than a clear refusal) and full offline-first with an IndexedDB mirror
(fights the RLS-only architecture, since every policy decision is server-side).

---

## 2. Stack

| Choice | Decision | Why |
|---|---|---|
| Build | Vite + React 18 + TypeScript, in `web/` | As `docs/design.md` specifies. |
| Styling | Tailwind | Same. |
| i18n | `react-i18next` | Same. |
| Data | `supabase-js` v2 | Same. |
| Routing | React Router | Role-based route trees; see §4. |

The single-file UMD approach used by `console.html` and by `onevio-crm` is deliberately
**not** carried forward. It was right for a quick console and is wrong for a multi-screen
i18n app — which is the reasoning already recorded in `docs/design.md`.

---

## 3. Session and identity

A `SessionProvider` at the root:

1. subscribes to `supabase.auth.onAuthStateChange`;
2. on a session, loads the caller's `app_users` row joined to `vendors`;
3. exposes `{ userId, vendorId, role, vendorName, loyalty }` to the tree.

`app_users` is the *only* source of role and tenant. It is what `current_vendor_id()` and
`current_user_role()` resolve from, so a UI that decided role any other way could disagree
with the database.

**The no-row case must be explicit.** An account can exist in Auth and have no `app_users`
row — that is exactly the state a new staff member is in before an admin maps them. Every
query then returns empty, which reads like a broken app. The SPA shows a specific message
naming the cause and pointing at `docs/runbook-first-admin.md`, rather than an empty
dashboard.

---

## 4. Screens

| Role | Screens |
|---|---|
| `recorder` | New bill, customers |
| `biller` | Pending bills → complete |
| `admin` | Items & stock, customers, staff, loyalty config, dashboards, low-stock bell |

Admin may also record and issue tokens: the policies permit `('admin','recorder')` for
bill creation and `issue_token`, so the UI follows the policy rather than narrowing it.

---

## 5. The billing flow

The riskiest part of the slice, and the one where the UI must respect the database rather
than reimplement it.

### Recorder

1. Pick an existing customer, or create one. **Name, flat no and mobile are all mandatory**
   (#11), and `(vendor_id, mobile)` is unique — a duplicate mobile must be reported as
   "this customer already exists", not as a raw constraint violation.
2. Create the `bills` row with `status='recording'`.
3. Add `bill_items` lines. Freely editable while recording (#12).
4. **Done** → `rpc('issue_token', { p_bill_id })` → display the returned token number
   large enough to read across a counter.

Three constraints the UI must honour:

- **`vendor_id` must be sent explicitly** on `bills`, `bill_items` and `customers`. The
  column is `not null` with no default. This is safe rather than a trust hole: each
  policy's `WITH CHECK` requires it to equal `current_vendor_id()`, so a forged value is
  refused by the database. (This exact omission was a live bug in `console.html`.)
- **The client's `total` is ignored.** `issue_token` recomputes it from the line items
  precisely because a recorder can set `bills.total` to anything while the bill is still
  recording. The running total in the UI is feedback, never the authority, and the total
  shown after Done must come from the server's response.
- **Done is a one-way door.** Once `issue_token` moves the bill to `billed`, the policies
  no longer permit edits. The UI confirms *before* Done and offers no undo it cannot
  deliver.

### Biller

List `status='billed'` → `rpc('complete_bill', { p_bill_id })` → show points awarded and
the resulting stock movement. `complete_bill` is idempotent, so a double tap is safe —
but the button still disables on submit, because a spinner is cheaper than explaining
idempotency to a biller.

---

## 6. Creating staff — a constraint worth stating plainly

Requirement #4 has the admin creating recorder and biller users. The SPA **cannot do that
the obvious way.** Creating a user through GoTrue's admin API needs the `service_role`
key, and that key must never reach a browser: it bypasses RLS entirely, so shipping it in
the SPA would hand every visitor the whole database.

Three ways out, and the choice matters:

1. **Self-signup, admin maps.** The new staff member signs up themselves with the public
   anon key; the admin then inserts their `app_users` row, which `users_admin_write`
   already permits. Works today, needs no new infrastructure, and keeps the
   `service_role` key server-side where it belongs. Cost: a two-step dance, and public
   signup must stay enabled on the project.
2. **An Edge Function holding `service_role`.** The admin posts an email; the function
   creates the user and the `app_users` row atomically. The right long-term answer, but it
   is slice 2 infrastructure and pulls Edge Function deployment into slice 3.
3. **Manual, via the Supabase dashboard.** What was done for the first admin
   (`docs/runbook-first-admin.md`). Fine for one person, not a product.

**Decision: option 1 for slice 3**, with option 2 recorded as the successor once slice 2
exists. The admin's staff screen therefore *maps and manages* staff — assigning roles,
listing them, changing a role — rather than creating accounts. The screen must say so, or
an admin will look for a "create user" button that cannot exist.

## 7. Low-stock bell

Requirement #9: notify when any item drops below 10 kg. `v_low_stock` already encodes the
threshold, so the client neither hardcodes 10 nor filters client-side.

A bell in the header shows the count from `v_low_stock`, and opens the list. Refreshed on
navigation and after any stock write, rather than by polling on a timer: stock changes
only when someone in this shop completes a bill or edits an item, so a poll would mostly
ask a question whose answer nobody changed.

Supabase Realtime is deliberately not used here. It is a second delivery path to keep
working, for a number that is already accurate the next time the user touches the app.

## 8. i18n

`mr` / `hi` / `en`, **default Marathi**, choice persisted in `localStorage`.

Item names are **data, not UI strings**: `items` already carries `name_en`, `name_hi` and
`name_mr`. So:

- the admin item form takes all three names;
- item display picks the column matching the active language, falling back to `name_en`
  when a translation is empty (both translated columns default to `''`).

`console.html` exposes only `name_en`; the SPA must not inherit that limitation.

---

## 9. Errors

- RLS denials are rendered in plain language ("your role cannot change prices"), not as a
  raw Postgres string. The raw message stays available for debugging.
- A policy-filtered read returns *zero rows*, not an error. Empty states say which it is —
  "no bills yet" differs from "you cannot see these", and conflating them hides bugs.
- Network failures retry; the failure surface distinguishes "offline" from "the server
  refused".

---

## 10. Testing, and one honest gap

**Vitest** covers pure logic: line totals, the points preview, form validation, the
name-by-language fallback. These run anywhere, in CI, with no database.

**End-to-end testing is blocked, and this spec does not pretend otherwise.** A meaningful
E2E test drives a real browser through a real login against real PostgREST and GoTrue.
The local harness has none of those — `tests/shim.sql` stands in for them precisely
because Docker is unavailable on this machine. The options were:

- mock `supabase-js` — rejected. It would test the mock, not the policies, and produce
  green that means nothing.
- stand up a Cloud test project — the real answer, deferred to when one exists.

So: Vitest for logic, the existing 65 database cases keep gating CI, and E2E is recorded
as outstanding rather than faked. This is the same gap already named in `README.md` under
"What the local suite does not cover", and it is closed by the same action.

---

## 11. Delivery

Staged, billing first, each stage shipping to the live URL.

| Stage | Contents |
|---|---|
| 1 | Vite scaffold, auth, role routing, i18n skeleton. Takes over `/`. |
| 2 | Recorder bill flow + biller completion. |
| 3 | Admin: items and stock (all three names), customers, staff, loyalty config. |
| 4 | Dashboards + low-stock bell. |

Billing goes first because it is what the shop runs on and the riskiest to get wrong;
finding a flaw there in stage 2 is much cheaper than finding it after three other stages
are built on the same assumptions.

**The console survives the transition.** `console.html` is published at `/console.html`
and stays there, so the dashboards it already provides remain reachable during stages 1–3,
when the SPA has not yet built its own. The workflow currently publishes it at both `/`
and `/console.html`; stage 1 drops the `/` copy.

---

## 11a. Stage 2 screen design

Added 2026-09-08, after stage 1 shipped. §5 settles the data flow and the constraints the
database imposes; this settles the screens, which is where the ergonomics live.

### Bill (recorder, and admin — the policies permit both)

One screen, three phases.

**1. Customer.** Search by mobile or name. No match offers an inline create form: name,
flat no and mobile, all mandatory (#11). `(vendor_id, mobile)` is unique, so a duplicate
must be reported as "this customer already exists" with an offer to use that customer —
never as a raw constraint violation.

**2. Items.** A grid of large tiles, each showing the item name in the active language via
`itemName()`, the price per kg, and the **current stock**. Tap a tile, a numeric input
takes the weight, confirm, and the line is appended.

The weight field is a real `inputMode="decimal"` input, not a stepper or a custom keypad.
Scales produce 1.35kg; fixed-step controls cannot express that without irritating the
person holding the bag.

**3. Basket.** The lines with a running total. Tapping a line edits its weight or removes
it — free editing while the bill is `recording` is requirement #12, and the policies allow
it precisely until `issue_token` runs. **Done** raises a confirm, then calls
`issue_token`, then shows the token number full-screen, large enough to read across a
counter. The only action on that screen is "start new bill": a recorder is working a
queue, not filing a document.

### Pending (biller)

Bills at `status='billed'`, newest first, each row showing token number, customer name and
total. Tap a row, confirm, `complete_bill` runs, and the result shows the points awarded
and the stock movement. `complete_bill` is idempotent so a double tap is harmless, but the
button still disables on submit — a spinner is cheaper than explaining idempotency to a
biller mid-queue.

### Stock is shown, not enforced

Tiles display current stock and colour a low or zero one. The UI does **not** block adding
more than the stock on hand.

`complete_bill` clamps the decrement at zero deliberately. A client-side block would be a
second, weaker copy of a rule the database already owns — and it would be wrong in the
real case it appears to protect against, where the shop genuinely has produce the stock
figure has not caught up with. The database is the authority; the tile is information.

### Not built in stage 2

- Deleting a bill. The policy permits it while `recording`, but nothing in the spec asks
  for it. Abandoning a bill leaves a `recording` row, which is harmless, invisible to the
  dashboards (they count completed bills) and available later if cleanup is ever wanted.
- Redemption. See §12.

### Testing

Pure logic — line totals, the running total, weight validation, duplicate-mobile
detection — is Vitest with no mocks, as in stage 1. The flow itself gets component tests
with a mocked `supabase` client, mocking confined to those files. The E2E gap of §10 is
unchanged: still no PostgREST or GoTrue in the test environment, still closed only by a
Cloud test project.

## 11b. Stage 3 screen design

Added 2026-09-09, after stage 2 shipped. Four admin screens. §5 settles the data flow;
this settles what each screen owns and, more usefully, what it deliberately does not.

### Where the code lives

`data.ts` stays the billing flow's file — its header says so, and the rule it states (no
client-side vendor filter, because RLS already scopes every read) carries over unchanged.
Admin calls go in a new `web/src/admin.ts` with the same shape. The split is not
ceremony: two focused files are easier to hold in one head than one file doing both, and
the screens stub `admin.ts` in tests exactly as the billing screens stub `data.ts`.

`/items`, `/customers` and `/staff` already exist in `routes.ts` as `Placeholder`s.
Stage 3 adds `/settings`, admin-only.

`/customers` stays in the recorder's nav as well as the admin's. `customers_write` really
does permit `('admin','recorder')` (0002_rls.sql), so this is one screen for both roles,
not two screens with a role branch. As always, the nav guard is politeness; the policy is
the authorization.

### Items and stock

The list shows **all** items, inactive ones included. `listItems()` filters
`is_active = true` for the bill grid on purpose, so admin needs its own `listAllItems()`
— an admin who cannot see a deactivated item cannot bring it back. Each row carries the
three names, price, stock and active state, with low and zero stock coloured as the bill
tiles colour them.

The create/edit form takes `name_en`, `name_hi`, `name_mr`, `price` and `stock_kg`.

**All three names are mandatory**, though the columns default to `''`. Two reasons. A
shopkeeper typing कोथिंबीर is the only native-quality Indian-language text this
application will ever contain — every other `hi` and `mr` string in `web/src/i18n/` is
AI-written and has never been reviewed by a speaker. And `itemName()` has no honest
fallback for a blank: showing the English name to a Marathi-speaking customer is the
failure the three columns exist to prevent, and a blank filled in "later" never is.

**Stock is an absolute figure that overwrites**, not a delta. The vendor weighs what is on
the table; asking them to subtract is asking them to redo arithmetic the scale already
did.

This means a save that lands while a bill is completing overwrites that bill's decrement.
That is accepted, not overlooked. `complete_bill()` remains the authority for decrements;
this screen is a correction, and a vendor recounting a crate is not racing a biller in
any real shop. The fix, if it ever matters, is an RPC that applies a delta inside one
transaction — worth building when the race is observed, not before.

Items are **deactivated, never deleted**. `bill_items.item_id` references them, so a
delete would either fail on the FK or destroy the history the dashboards read.

### Customers

Searchable list, reusing `matchCustomers()` from `customers.ts` rather than growing a
second search with different behaviour. Tapping a row opens name, flat no and mobile for
editing, and shows the customer's balance from `customer_points_balance(id)`.

A duplicate mobile is reported the way `CustomerStep` already reports it — "this customer
already exists", with an offer to open that customer — never as a raw constraint
violation. `(vendor_id, mobile)` is unique and the edit path can collide with it just as
the create path can.

No delete. A customer carries bills and an append-only ledger; `customers_write` would
permit the delete, and it would cascade `points_ledger` and orphan `bills.customer_id`.
One mistap is not an acceptable price for a feature nothing asked for.

### Staff

The `app_users` roster: name and role, with an admin able to rename someone or change
their role.

**No invite, and the screen says why.** `app_users.id` must equal an existing
`auth.users.id`, and creating auth accounts is slice 2's Edge Function (§6), which does
not exist. A screen that appeared to invite someone and silently could not would be worse
than one that admits the seam. The note points at `docs/runbook-first-admin.md`, which
already describes the sign-up-then-link procedure.

Two guards:

- An admin cannot demote or remove **themselves**. This is the single action that locks a
  vendor out of its own tenant — `users_admin_write` needs `current_user_role() = 'admin'`,
  so the last admin who demotes themselves leaves nobody able to undo it, and the repair
  is hand-written SQL against production.
- Removal raises a confirm.

Removing an `app_users` row does not delete the auth account; the person simply stops
resolving to a vendor. That is the correct behaviour here and the screen's wording should
not imply otherwise.

### Settings

The vendor's own row: `points_threshold_1`, `points_reward_1`, `points_threshold_2`,
`points_reward_2`, `redeem_days`. All required, all numeric, thresholds positive, and
`points_threshold_2 > points_threshold_1`.

The screen states that changes apply to bills completed **from now on**. `points_ledger`
is append-only and nothing recomputes past awards — a vendor who raises a reward and
expects yesterday's customers to benefit is going to be wrong, and the place to tell them
is the screen, not a support conversation.

`/settings` is a route rather than a panel on `/items` because the next piece of
per-vendor configuration — the vendor name, at minimum — has nowhere else to go, and
loyalty rules filed under produce read as misplaced.

### Not built in stage 3

- Inviting or creating staff accounts. Slice 2's Edge Function owns it.
- Deleting customers or items. See above; deactivation covers the real case.
- Redemption. Unchanged from §12 — no requirement numbers a redemption screen.
- Stock requests. `stock_requests` has a read policy, an admin delete policy and a
  counts view, but no requirement in this slice asks for a screen; it belongs with the
  dashboards in stage 4.

### Testing

Pure logic — settings validation, item form validation, the self-demotion check, search
filtering — is Vitest with no mocks, as in stages 1 and 2. Each screen gets a component
test with `admin.ts` stubbed, mocking confined to those files.

The E2E gap of §10 is unchanged: still no PostgREST and no GoTrue in the test
environment, still closed only by a Cloud test project. Stage 3 writes to `vendors`,
`items` and `app_users` for the first time from the client, so the policies those writes
depend on (`vendors_admin_update`, `items_admin_write`, `users_admin_write`) are covered
by `tests/rls.test.mjs` against a real database but have never been exercised through
PostgREST.

The new `hi` and `mr` strings are AI-written and unreviewed, like every other string in
those files.

---

## 12. Out of scope

- The billing flow's WhatsApp *delivery* — slice 2 owns the sender. The SPA's writes queue
  `outbound_messages` rows by way of the database functions and nothing more.
- Drive images and bill PDFs — slice 4.
- Creating auth accounts from the SPA — see §6; that is slice 2's Edge Function.
- Redemption UI. The ledger supports negative rows and `customer_points_balance` reports a
  balance, but no requirement numbers a redemption screen; adding one here would be
  inventing scope.
