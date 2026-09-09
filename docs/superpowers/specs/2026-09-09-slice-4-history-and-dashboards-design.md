# Slice 4 — Bill history, dashboards, and the settings merge

Written 2026-09-09, after slice 3 stage 3 shipped the four admin screens.

This slice is everything the vendor asked for that today's database can already answer.
The two requests it deliberately excludes — creating staff accounts, and translating item
names with AI — share one prerequisite that does not exist in this repo, and they are
specified separately in §9.

## 1. Why these four together

The vendor asked for six things. They split on a single line: whether they need a server.

Four need nothing new. Completed-bill history, dashboard totals, moving Staff under
Settings, and turning the item grid into a list are all reads and rearrangement over
tables and views that shipped in slice 1. They are specified here.

Two need a server-side function holding a secret. Creating a staff account requires the
`service_role` key; translating an item name requires an AI provider key. Neither can
live in a browser bundle — `web/src/config.ts` states the rule for the first, and the
second is the same rule with a different key. They are §9, and they are a separate slice.

Building the four first is not merely convenient sequencing. It puts the shop's own
numbers in front of the vendor before we spend a slice on infrastructure, and the history
screen is the first thing that will tell us whether the loyalty rules are behaving in the
real shop — which is how the `>=` bug in `0006` surfaced in the first place.

## 2. The item list (request 1)

`web/src/screens/bill/ItemGrid.tsx` renders `grid-cols-2` tiles. It becomes one row per
item: name via `itemName()`, price via `rupees()`, and current stock, coloured by the
existing `stockClass` thresholds. Tapping a row selects it and reveals the weight input
exactly as it does now.

Nothing about the weight field changes. It stays `inputMode="decimal"` on a real text
input, because scales report 1.35 and a stepper cannot express that.

Stock stays **shown and never enforced**. This is unchanged from §11a and is worth
restating because the list makes stock more prominent: `complete_bill()` clamps the
decrement at zero deliberately, and a row disabled here would be a weaker second copy of
a rule the database owns — wrong in exactly the case it appears to protect, when the shop
has produce the stock figure has not caught up with.

**A search box is not part of this.** One column doubles the scrolling, and for a shop
carrying thirty items that is a real cost at a busy counter. Search is the obvious
remedy, and it was raised and deliberately left out: the request was for a list, and
inventing an adjacent feature inside a layout change is how scope stops being legible.
If the scrolling turns out to hurt in use, search is a small follow-up with a clear
trigger — not a guess made in advance.

## 3. Completed bills (request 4)

A new screen at `/completed`, in the nav for **admin and biller**.

A biller completes bills and sees each total as they do it, so a record of what they
completed is theirs as much as the owner's. `bills_read` already permits any signed-in
staff member to read bills, so this is a nav decision, not an authorization one — the
policy would allow more, and as always the route list is politeness rather than
protection.

Rows show token number, customer name, total through `rupees()`, and the completion time,
newest first. Tapping a row shows that bill's line items from `bill_items`.

### It pages, and that is not optional

This is the first unbounded list in the application. Every other screen shows items,
staff or customers — tens of rows, bounded by how many vegetables a shop sells and how
many people work there. Completed bills grow without limit: sixty bills a day is roughly
eighteen hundred a month, and a "This month" filter that fetched all of them would pull
the shop's entire month onto a phone over a mobile connection.

Fifty rows a page, newest first, with an explicit "load more". Fifty is roughly a busy
shop's day, so the first page usually answers "what happened today" without a second
request. The cursor is
`(completed_at, id)` rather than an offset: `completed_at` alone is not unique — two
bills completed in the same clock tick would let an offset-paged list drop or repeat a
row at the page boundary, which is precisely the bug that would never be noticed in
testing and would quietly lose a bill in production.

## 4. Dashboards (request 5)

`/dashboards` stops being a `Placeholder`.

Money collected and bill count come from `v_payments_daily`, `v_payments_weekly` and
`v_payments_monthly`. Each already carries a `bucket` column, so a date range is a
`.gte()`/`.lte()` on `bucket` and needs nothing new.

### The problem the views have

`v_top_items` and `v_bought_together` have **no date dimension**. They group by
`vendor_id` and item, over all history. "Top items this week" is not a question the
current schema can answer.

Building the screen anyway would produce a date filter that governs the payment cards and
is silently ignored by the other two. That is worse than having no filter, because
nothing on the screen distinguishes the cards the filter reached from the cards it did
not, and the numbers look equally authoritative either way.

### Migration 0007

Two set-returning **functions** — `top_items_between(p_from, p_to)` and
`bought_together_between(p_from, p_to)` — added **alongside** the existing views rather
than replacing them.

Functions rather than views, because a view cannot take a parameter, and the alternative
(a view grouped by day that the client re-aggregates) would push the ranking back into
the browser — the very thing this section rejects. They are left as INVOKER rights, the
default: a plain function runs as its caller and inherits the RLS policies from `0002`,
which is the same property `security_invoker = true` buys the views. Neither may be
`SECURITY DEFINER`; that would hand every vendor everyone else's numbers.

Additive by design: no data is changed, no policy is touched, and `console.html` — which
reads the original eight views and stays published throughout — keeps working untouched.
The rule `0004` states for views applies here in its function form, and §7's tests pin
it: a caller from one vendor must never see another vendor's rows.

The alternative considered and rejected was aggregating in the browser: query
`bill_items` joined to `bills` across the range and compute the ranking client-side. It
needs no migration, but it pulls every line item in the period onto the phone to produce
a top-five, and reimplements in TypeScript an aggregation Postgres already does. The
database is the authority in this project; that posture is why the dashboards are views
in the first place.

## 5. Settings absorbs Staff (request 3, the half that is buildable)

`/settings` becomes a screen with two sections, Loyalty and Staff, reusing the existing
`Staff.tsx` unchanged. `/staff` leaves the nav.

The `/staff` route itself is **kept as a redirect to `/settings`** rather than removed. It
has been live and linkable since stage 3; a route that 404s is a worse answer than one
that takes you where the thing moved.

**This does not add users.** The screen keeps the note explaining that a person signs up
first and is then linked by hand, pointing at `docs/runbook-first-admin.md`. That note
comes out in §9's slice, not this one.

## 6. The shared date filter

One module, `web/src/dateRange.ts`, used by both `/completed` and `/dashboards`.

Presets — Today, This week, This month — plus a custom from–to. Presets exist because the
common question is asked one-handed at a counter; the custom range exists because "how
did last Diwali week go" is a real question that presets cannot express.

The module is pure: it maps a preset or a pair of dates to a concrete `{ from, to }`, and
it owns the boundary decisions so that two screens cannot disagree about what "this week"
means. Ranges are inclusive of both ends at day granularity.

Two decisions it must make explicitly rather than by accident:

- **Weeks start Monday**, matching `date_trunc('week', ...)` in `0004_views.sql`. A UI
  that started weeks on Sunday would disagree with the view it is filtering, and the
  numbers would be wrong in a way nobody would question.
- **A range where `from` is after `to`** is rejected in the UI rather than sent, because
  the query would succeed and return nothing, which reads as "no sales" rather than "bad
  input" — a false answer is worse than an error.

## 7. Testing

The shape slice 3 settled: pure logic with no mocks, screens stubbing only their data
module, component tests querying by `data-testid` because the suite runs in Marathi.

The two places bugs will actually live get real cases:

- **`dateRange.ts`** — each preset, a single-day range, a range spanning a month boundary,
  a range spanning a year boundary, and `from` after `to`.
- **Pagination** — that "load more" at a page boundary neither drops nor duplicates a row,
  including the case of two bills sharing a `completed_at`.

The `0007` views get tests in `tests/` against a real Postgres, as every migration does.
That suite is the only place the SQL runs: there is no Postgres on the development
machine, so **CI is the verifier, not a local run**. This was learned the hard way in
slice 3 — TypeScript 7 ships as a per-platform native binary, and a `tsc --noEmit` that
passed on Windows failed on CI's Linux build. Treat a local green as a smoke test.

## 8. What this slice does not change

- The end-to-end gap. Nothing here runs against real PostgREST or GoTrue; that is still
  closed only by a Cloud test project.
- Redemption. Still no requirement numbers a redemption screen.
- `console.html`. It stays published at `/console.html` through this slice. It can be
  retired once `/dashboards` demonstrably covers what it shows, which is a judgement to
  make after the vendor has used both — not a step in this plan.

## 9. Out of scope: the two requests that need a server

Specified here so the boundary is on the record, not to be built in this slice.

**Adding users from Settings (request 3, the other half).** `app_users.id` must equal an
existing `auth.users.id`, and creating one requires the `service_role` key, which carries
`bypassrls`. A copy of that key in a browser bundle is a full database compromise —
`web/src/config.ts` says so — so account creation must happen in a server-side function.
This is the Edge Function slice 2 was always meant to own, and it does not exist: there is
no `supabase/functions/` directory in this repository.

**AI translation of item names (request 6).** Same shape, different key: an AI provider
credential cannot live in the bundle either.

Its agreed behaviour, when built: the admin types **one** language, the other two are
proposed and shown **pre-filled and editable**, and nothing saves until the admin accepts.
Not silent auto-fill. The reason is recorded in §11b of the slice 3 spec — a shopkeeper
typing कोथिंबीर is the only native-quality Indian-language text this application contains,
because every string in `hi.json` and `mr.json` is AI-written and has never been reviewed
by a speaker. Auto-translating item names extends that unreviewed surface to the product
names customers actually read. Keeping a human who speaks the language in the loop is what
stops the backlog growing silently while looking like progress.

Both share one prerequisite — an Edge Function deployment path with secrets. Built once,
both features become small. That is the next slice.
