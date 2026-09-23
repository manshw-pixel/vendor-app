# Payment mode and day close — design

**Date:** 2026-09-23
**Slice:** 1 of 2. Slice 2 (offline-tolerant billing, feature #10) is designed separately
and builds on this one.
**Migration:** `0021_payments_and_day_close.sql`

## Why

Bills store only a total. The owner cannot reconcile the cash drawer against what went to
UPI, and nothing marks a day as finished. This slice records how each bill was paid and
adds an end-of-day close that compares expected cash against counted cash and then locks
the day.

## Decisions taken (with the owner, 2026-09-23)

| Question | Decision |
|---|---|
| Split payments? | One mode per bill for now, stored as a `bill_payments` row so splits need no migration later. |
| Credit (udhaar)? | A tag only. A credit bill is excluded from expected cash. No settle action; that is feature #2. |
| What does close lock? | Hard close. No bill completions or voids on a closed date. Admin-only reopen, logged. |
| Expected cash | Sum of the day's cash payments. No opening float, no payouts. |
| Unclosed days | Warning banner for admin and biller. Never blocks billing. |
| Pending tokens at close | Carry over. They count on the date they are completed. |

## Data

### `bill_payments` (new)

`id uuid pk, vendor_id uuid not null, bill_id uuid not null references bills,
mode text not null check (mode in ('cash','upi','card','credit')),
amount numeric(10,2) not null check (amount >= 0), created_at timestamptz default now(),
created_by uuid`

- `created_by` is nullable: `complete_bill` still accepts a service-role caller, which has
  no `auth.uid()`.

- `unique (bill_id)`: exactly one row per bill for now. Allowing splits later means
  dropping this constraint and nothing else.
- `amount` is the bill's payable total after any points redemption.
- RLS: readable by the vendor's own staff. Writable by no client role; only
  `complete_bill` (security definer) inserts. Same pattern as `points_ledger` and
  `stock_movements`.
- A void does not delete the row. Voided bills are already excluded from every figure,
  and the payment is excluded with its bill.
- Bills completed before 0021 have no row. They are reported as **Not recorded**. No
  backfill: guessing "cash" would inflate expected cash.

### `day_closes` (new)

`id uuid pk, vendor_id uuid not null, business_date date not null,
expected_cash numeric(10,2) not null, counted_cash numeric(10,2) not null,
difference numeric(10,2) not null, note text, closed_by uuid not null,
closed_at timestamptz not null default now(), reopened_by uuid, reopened_at timestamptz,
reopen_reason text`

- `business_date` is the Asia/Kolkata calendar date, matching `void_bill`.
- A partial unique index on `(vendor_id, business_date) where reopened_at is null` allows
  at most one active close per day, while keeping every earlier close and reopen as
  history.
- Check: a non-null `reopened_at` requires `reopened_by` and a non-blank `reopen_reason`.
- RLS: readable by the vendor's own staff. Written only through the functions below.

## Functions

### `complete_bill(p_bill_id, p_biller_id, p_redeem_points, p_payment_mode)`

- New **required** `p_payment_mode text`. It is refused when missing or not one of the
  four modes. An old browser tab calling without it fails loudly instead of recording
  nothing.
- Inserts one `bill_payments` row in the same transaction, `amount` = the payable total.
- Refuses with a distinct error (`day_closed`) when today (Asia/Kolkata) has an active close
  for the vendor.
- Otherwise unchanged. The redefinition starts from the latest body (0016) and changes
  nothing else.

A total fully covered by points (payable ₹0) still requires a mode and records amount 0.

### `void_bill`

Also refuses with `day_closed` when the bill's completion date has an active close. It is
already limited to the day the bill was completed, so this ends that window early. Editing
a completed bill is void-then-rebuild and is covered by the same check. The rebuilt bill
goes through Pending → Complete and picks its own mode.

### `issue_token`

Unchanged. A token issued after close carries over and is completed on a later date.

### `close_day(p_date date, p_counted_cash numeric, p_note text) returns day_closes`

- Admin or biller of the caller's vendor. Recorder and cross-tenant callers are refused.
- Refused when `p_date` is in the future or already has an active close (`already_closed`).
- `expected_cash` is computed on the server: the sum of `bill_payments.amount` where
  `mode = 'cash'`, for bills of this vendor with `status = 'done'`, not voided, completed on
  `p_date` (Asia/Kolkata). The client never supplies it.
- `difference = counted_cash - expected_cash`. When it is non-zero, a non-blank `p_note` is
  required.
- `p_counted_cash >= 0`, at most two decimals.
- A past unclosed date can be closed later (anyone with the role), so a missed close can be
  done afterwards.
- Takes the vendor row `for update` first. `complete_bill` and `void_bill` take it `for
  share` before their lock check, so a completion racing a close either lands before the
  close computes expected cash or is refused with `day_closed`, never slips in between.

### `reopen_day(p_date date, p_reason text)`

Admin only, non-blank reason. Stamps `reopened_by/at/reason` on the active close. Nothing is
deleted. A later `close_day` inserts a fresh row with a recomputed `expected_cash`, which
reflects any void made while the day was open again.

### `day_summary(p_date date)`

Returns what the close screen needs in one call: per-mode totals and bill counts (cash,
upi, card, credit, not recorded) for completed, non-voided bills on that date; expected
cash; the count of pending (`billed`) tokens; and the active close if one exists.
Security invoker, scoped by RLS.

### `unclosed_days()`

Past dates (before today, Asia/Kolkata) with at least one completed non-voided bill and
no active close, newest first, limited to the last 30 days, and never before
`vendors.day_close_from`. Drives the banner.

`vendors.day_close_from date not null default (now() at time zone 'Asia/Kolkata')::date`
is set to the migration date for existing shops and to the creation date for new ones.
Without it, the day 0021 ships every shop would be told thirty past days are not closed.

### `payment_split_between(p_from, p_to)`

Per-mode total and bill count for completed, non-voided bills in the window, with
`unrecorded` for bills that have no payment row. Security invoker. Feeds the dashboard.

## Screens

### Pending: completing a bill (biller)

- Four large buttons: **Cash · UPI · Card · Credit**. None preselected.
- **Complete** stays disabled until a mode is selected. With Credit it reads
  "Complete on credit".
- The receipt prints the mode: "Paid: UPI" or "On credit".

### Close day (new, admin and biller)

- Top: the date and its status: *Open*, or *Closed at 8:12pm by X*.
- The split: Cash / UPI / Card / Credit / Not recorded, each with total and bill count.
- **Expected cash** shown large, then a **Counted cash** input and a live difference: green
  at zero, amber otherwise. When non-zero, a note is required.
- "Carried over: N pending tokens" when N > 0.
- **Close day** asks for confirmation: "No more sales or voids today after this".
- Below: the last 14 closed days with difference and who closed them, and any past
  unclosed days. Admin sees **Reopen** (with reason) on closed days. Admin and biller see
  **Close** on a past unclosed day, which loads that day into the panel above; the banner
  sends both roles here, so both must be able to act on it.

### Banner

When `unclosed_days()` is non-empty, admin and biller see "22 Sep is not closed" (the
oldest date, plus "and N more" when several) on every screen, linking to Close day.
Recorders never see it. It never blocks anything.

### Dashboard

The Collected card gains a payment-mode split for the selected range. Credit is labelled
as not yet collected. Not recorded appears only when non-zero.

### Errors

`day_closed` shows as "Today is closed. Ask an admin to reopen it." `already_closed` also
gets its own message. Both in en, hi and mr.

## Out of scope

- Split payments (the schema allows them; the UI does not).
- Settling credit bills, the dues list, reminders (feature #2).
- Opening float, cash payouts and expenses.
- Matching individual UPI or card transactions.
- Offline billing (slice 2). Its design must decide how a queued bill that syncs after its
  day was closed is treated.

## Testing

**DB suite**
- `bill_payments`: direct insert refused for every role; invisible across vendors.
- `complete_bill`: refuses a missing or invalid mode; writes exactly one row with the
  payable amount, including amount 0 when points cover the bill; idempotent re-call writes
  no second row.
- `close_day`: admin and biller allowed, recorder and cross-tenant refused; expected cash
  counts only cash, excludes voided bills and bills with no payment row, respects the
  Asia/Kolkata boundary; refuses a double close, a future date and a missing note on a
  non-zero difference.
- `reopen_day`: admin only, reason required, history kept; a re-close inserts a new row
  with recomputed expected cash.
- Lock: on a closed date `complete_bill` and `void_bill` raise `day_closed`;
  `issue_token` succeeds.
- `day_summary` and `unclosed_days`: correct figures; no cross-vendor leakage;
  `unclosed_days` ignores dates before `day_close_from`.
- A completion blocked on a close in progress is refused once the close commits.
- `clear_vendor_data` removes the shop's payments and closes, so a cleared shop is not left
  with today locked.

**Web tests**
- Complete disabled until a mode is picked; Credit relabels the button; the mode is passed
  to the RPC.
- Close-day difference colour and the note-required rule.
- Banner shown to admin and biller, hidden from recorder.
- `day_closed` and `already_closed` translated in all three languages.
- Dashboard split, including Not recorded only when non-zero.
- Receipt prints the mode.

## Deploy

Same order as always: functions → `0021` applied on Cloud → git push. `complete_bill`'s new
required argument means the web app and the migration must go out together; a gap between
them breaks billing.
