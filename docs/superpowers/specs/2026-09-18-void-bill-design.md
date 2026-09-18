# Void a completed bill — design

**Date:** 2026-09-18. **Status:** approved in brainstorm, awaiting spec review.
**Slice:** second of the four complex slices (cost/margin → **void** → non-kg units → offline).

## Problem

Wrong bills happen at the counter. Today a completed bill cannot be cancelled, so stock,
points, history and the dashboards all drift from what actually happened.

## Decisions taken with the owner

| Question | Decision |
|---|---|
| Scope | **Whole-bill void only.** No partial returns in this slice. |
| Who | **Admin and biller.** |
| Points already spent | **Reverse the full award; the balance may go negative.** |
| Window | **Same calendar day as completion.** |

## Approach

A new `voided` bill status and one `security definer` function, `void_bill()`, that
reverses stock and points and stamps the bill in a single transaction. Nothing is
deleted: token, lines, receipt and customer history survive.

Every dashboard function, view, the completed list and the receipt lookup already filter
on `status = 'done'`, so a voided bill drops out of every figure with no change to those
queries. This is the reason a status was chosen over deleting the bill (destroys history,
orphans ledger rows) or a negative counter-bill (complicates every query and the receipt).

## Data model — migration `0017_void_bill.sql`

- `bills.status` check becomes `('recording','billed','done','voided')`. Drop and
  re-add the constraint; the existing `bills_vendor_status_idx` serves the new value.
- New nullable columns on `bills`: `voided_at timestamptz`, `voided_by uuid references
  app_users(id)` (no `on delete`, like `recorder_id`), `void_reason text`.
- Check: `status = 'voided'` iff `voided_at is not null`, and a voided bill has a
  non-blank `void_reason`.
- No new table. No RLS change: `bills_read` already lets staff read voided bills;
  writes happen only inside the function.

## Function `void_bill(p_bill_id uuid, p_reason text) returns void`

`security definer`, `set search_path = public`, granted to `authenticated` only
(created_by semantics need `auth.uid()`), revoked from `public` and `anon`.

Rules, in order:
1. `current_vendor_id()` null, or the bill not in the caller's vendor, or role not in
   (`admin`, `biller`) → raise with errcode `42501`.
2. Lock the bill row (`for update`). Not found → raise.
3. Already `voided` → return (idempotent; a double tap or retry is success).
4. Status not `done` → raise `P0001` `bill is not done`. `recording` bills are dropped by
   the existing recorder delete; `billed` bills are simply not completed.
5. Same-day check: `(completed_at at time zone 'Asia/Kolkata')::date =
   (now() at time zone 'Asia/Kolkata')::date`, else raise `P0001` `void window closed`.
   The timezone is fixed because every shop is in India; the comment says so. (The web
   client avoids a hardcoded zone for display; the server rule is a business rule.)
6. Reason: `length(btrim(p_reason)) > 0`, else raise `22023`.
7. Stock: for each line, `items.stock_kg += qty_kg`. No cap; stock is not bounded above.
   No `stock_movements` row is written: the bill itself is the record.
8. Points earned: for every `points_ledger` row with this `bill_id` and `points > 0`,
   insert a row with `-points`, same `customer_id`, same `expires_at`, `bill_id` = this
   bill. The balance may go negative.
9. Points spent: for every `points_ledger` row with this `bill_id` and `points < 0`
   (the redemption rows 0010 writes), insert a row with `-points` (a refund), same
   `expires_at`. Expired buckets are refunded too; they lapse naturally.
10. Notify: insert `outbound_messages` row `bill_voided` with payload
    `{token_no, total, points_reversed, points_refunded}` when the bill has a customer.
    The sender maps unknown template keys to "no template yet" and leaves the row
    pending; see the sender's `TEMPLATE_IDS` config.
11. Stamp: `status = 'voided'`, `voided_at = now()`, `voided_by = auth.uid()`,
    `void_reason = btrim(p_reason)`.

Costs on `bill_items.unit_cost` stay untouched; the status excludes them from margin.

## Function `voided_between(p_from, p_to) returns table (void_count bigint, voided_total numeric)`

Plain `language sql stable` (invoker rights, RLS applies). Counts bills with
`status = 'voided'` and `completed_at` in range, and sums their `total`. Grants like the
other analytics functions.

## Web

- `web/src/history.ts`: `listCompleted` keeps `status = 'done'`. New
  `listVoided(range)` returning voided bills with `voided_at`, `void_reason`,
  `voided_by` name (via `app_users(name)` embed), same paging shape. New `voidBill(id,
  reason)` calling the rpc. New `voidedBetween(range)`.
- `Completed.tsx`: each row completed today (compare in the browser's local date, same
  as the rest of the UI) shows a **Void** button for admin and biller. It opens a confirm
  block with a required reason field; Save is disabled while the reason is blank. On
  success the row is removed from the list and a toast-style line says "Bill {token}
  voided". Server refusals map through `describeError`: `void window closed` →
  `void.windowClosed`, `bill is not done` → `void.notDone`.
- A **Show voided** toggle at the foot of the list loads `listVoided(range)` and renders
  greyed rows with token, total struck through, reason, who and when.
- `Receipt.tsx` / `receipt.ts`: lookup no longer filters `status = 'done'`; it filters
  `status in ('done','voided')`. A voided bill renders the normal slip with a **VOIDED**
  banner and the reason, so a reprint cannot pass as a valid receipt.
- `Dashboards.tsx`: under bill count, a line "N voided · ₹X" when N > 0, from
  `voidedBetween`.
- i18n keys under `void.*` and `receipt.voided` in en/hi/mr, AI-written and flagged for
  native review like the rest.

## Testing

DB suite (`tests/void_bill.test.mjs`):
- recorder refused 42501; cross-vendor refused 42501; biller and admin allowed.
- `billed` bill refused; second void of the same bill is a no-op with no extra ledger
  rows or stock change.
- Same-day: a bill with `completed_at` set to yesterday (IST) is refused; today's passes.
  Set `completed_at` directly in SQL to avoid clock drift.
- Blank reason refused.
- Stock restored exactly by the line quantities.
- Award reversed: ledger sums to zero for that bill's award; balance negative when the
  customer already spent the points.
- Redemption refunded with matching `expires_at`.
- `bill_voided` message queued once, with the right payload.
- Voided bill absent from `collected_between`, `top_items_between`,
  `bought_together_between`, `v_payments_daily`, `v_top_items`.
- `voided_between` counts and sums, respects bounds, does not leak across vendors.
- Constraint: cannot set `status = 'voided'` without `voided_at`/reason (owner-role SQL).

Web suite: void button only on today's rows and only for admin/biller; reason required;
success removes the row; error keys mapped; voided list renders; receipt banner; dashboard
line appears only when count > 0.

## Deployment

0017 applied by hand on Cloud as one script, then push. Existing sender config needs a
`bill_voided` template only when WhatsApp goes live.

## Out of scope

Partial returns; un-voiding; editing a completed bill; voiding across days by admin
override; a stock movement row per void.
