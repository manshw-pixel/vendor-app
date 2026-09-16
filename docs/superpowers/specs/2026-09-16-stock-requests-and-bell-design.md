# Stock requests, the low-stock bell, and the pair-name fix

Closes requirements #9, #10 and #20 from `docs/product-spec.md`, and fixes an
i18n bug in the bought-together dashboard card.

## Why this slice, and why now

#20 was specified as customers suggesting items to the WhatsApp bot, feeding the
#10 out-of-stock dashboard. WhatsApp is on hold: the owner has no spare phone
number, and will not migrate an in-use one onto the API, which is a one-way move
that ends app chat on that number. Both halves of WhatsApp — the approved-template
outbound sender and the unbuilt inbound webhook — need that number.

The demand data #10 exists to show does not, though. A recorder at the counter
hears "do you have dragon fruit?" all day. Logging it there captures walk-ins who
would never message a bot, which is arguably the better source.

Three requirements are each partly built and blocked on nothing external:

- **#20** `stock_requests` has had its schema, RLS and view since migration 0001.
  Nothing has ever written a row.
- **#10** `v_stock_request_counts` is correct and unread by any code. Because
  nothing writes requests, it is structurally guaranteed to return zero forever.
- **#9** `v_low_stock` exists; `Items.tsx:168` prints an inline "low" label. That
  is a column annotation, not the notification the requirement asked for.

## Decisions taken

**Staff log requests from a dedicated screen, not inline on the bill.** A
bill-attached entry point only fires while a bill is open, and a customer who
asks and walks out without buying is exactly the one worth counting. The table's
`customer_id` is already nullable, so adding bill-attached logging later needs no
schema change.

**Requests carry a status; they are never deleted.** `0002_rls.sql:103` grants
admin a DELETE and its comment says "staff may clear handled ones" — but
`v_stock_request_counts` counts rows. Stock dragon fruit because eleven people
asked, clear those eleven, and the dashboard reports that nobody ever wanted it.
The two needs on these rows differ: staff want a worklist, #10 wants durable
demand history. A status column serves both; deletion serves neither.

**The bell polls; it does not use Realtime.** The spec suggested a Realtime
subscription on `items`. Stock crosses 10 kg a few times a day, and an admin who
learns of it four minutes later restocks at the same moment as one told
instantly. Realtime buys nothing operationally here and costs the riskiest part
of the slice: a Realtime policy that mishandles `vendor_id` is a cross-tenant
leak, the one failure the RLS suite exists to prevent.

## Migration `0013_stock_requests_worklist.sql`

Add the status column, defaulting to `open`:

```sql
alter table stock_requests
  add column status text not null default 'open'
    check (status in ('open', 'handled'));
```

No production rows exist to backfill — nothing has ever inserted. Carry a
`comment on column` recording that `v_stock_request_counts` ignores status by
design, because handling a request does not un-ask it.

Add the insert policy, which does not exist today:

```sql
create policy stock_requests_staff_insert on stock_requests for insert to authenticated
  with check (vendor_id = current_vendor_id()
              and current_user_role() in ('recorder', 'admin'));
```

Add an update policy for the same two roles. It permits editing `item_name` as
well as `status`: the count view groups on `lower(item_name)`, so a typo
fragments the data and a recorder should be able to repair it. Column-level
grants would narrow this to `status` alone, but no migration in this project
issues explicit grants and this is not the place to introduce the pattern.

Drop `stock_requests_admin_delete`. This is the point of the decision above; a
button that silently destroys the #10 data is worse than no button.

Reject blank names with `check (length(btrim(item_name)) > 0)`, with the client
trimming and collapsing whitespace before insert.

Add a date-ranged reader, deliberately the same shape as `top_items_between()`
in `0007_analytics_by_date.sql`:

```sql
create function stock_requests_between(p_from timestamptz, p_to timestamptz)
  returns table (item_name text, request_count bigint, last_requested_at timestamptz)
```

`language sql stable`, invoker rights so RLS applies, ordered by count descending,
limit 10. `Dashboards.tsx` carries a date filter that every other card respects;
a card ignoring it would read as broken. `v_stock_request_counts` is left alone.

**Not in scope: canonicalising item names.** "dragon fruit" and "dragonfruit"
will count separately. Synonym tables and trigram matching are speculative until
real staff entry proves messy; the typo-edit path is the cheap mitigation.

## The pair-name fix

`bought_together_between()` selects `ia.name_en`/`ib.name_en`
(`0007_analytics_by_date.sql:59`) and `Dashboards.tsx:126` renders them raw,
while the Top Items card directly above correctly uses `itemName(i, lang)`. A
Marathi admin sees Marathi in one card and English in the next.

Return all three name columns per side and run both through `itemName()`. This
needs **DROP then CREATE** — Postgres will not let `create or replace` change a
return type — but the argument list is unchanged, so the PostgREST overload
ambiguity that `0010_points_redemption.sql:12` warns about does not arise. Rides
along in 0013.

## Frontend

**`web/src/screens/Requests.tsx`**, route `/requests`, in `routes.ts` under
`recorder` and `admin`. As that file's header comment insists, route guards are
UX; the policy in 0013 is the security boundary.

A text input and a Log button; below, open requests newest-first, each with a
"Mark handled" action. Handled requests collapse behind a toggle rather than
disappearing, so staff can see what was dealt with.

Customer attribution stays out of v1. Forcing a recorder to find or create a
customer record before logging "someone asked for dragon fruit" is the friction
that makes a feature go unused.

**`web/src/requests.ts`** — `logRequest()`, `openRequests()`, `markHandled()`,
shaped like `customers.ts`. Trimming and whitespace collapse live here rather
than in the component, so they are testable without rendering.

**`Dashboards.tsx`** gains a fourth card fed by `stock_requests_between(range)`,
using the existing `Card` component, the existing range, and folding its error
into the existing first-error-wins handling.

**`useLowStock()`** queries `v_low_stock` on mount, on window focus, and every
five minutes, returning a count. `Shell.tsx` renders it as a badge on the Items
nav link for admin only, inside the existing `routesForRole(role)` map. The
threshold stays in the view; the client never learns the number 10.

**i18n keys** across `en.json`, `hi.json`, `mr.json`. The hi and mr strings will
be AI-written like the existing 204 and are to be labelled unreviewed, not
presented as translated.

## Testing

`tests/stock_requests.test.mjs`, in the style of the existing RLS tests:

- Recorder and admin insert; biller is refused; cross-tenant insert is refused;
  an anon client sees nothing.
- Status flips `open` to `handled`; the check constraint rejects other values.
- Blank and whitespace-only names are rejected.
- Admin delete is now refused — dropping that policy is a deliberate behaviour
  change and deserves a pin.
- `stock_requests_between()`: date bounds, ordering, no cross-vendor leak.

`web/src/__tests__/requests.test.ts` covers normalisation and the pure parts of
the data module, plus a case pinning that pair names localise — the regression
that prompted this slice.

**Honest limit:** the polling hook and the badge render are covered by nothing,
the same position as the rest of the UI. The count query is a view the database
suite already exercises.

## Scope

One migration; one new screen; one new data module; three touched files
(`routes.ts`, `Shell.tsx`, `Dashboards.tsx`); i18n keys; two test files.
