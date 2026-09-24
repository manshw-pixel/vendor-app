# Dues (udhaar) — design

**Date:** 2026-09-24
**Builds on:** `0021_payments_and_day_close.sql` (payment mode, day close)
**Migration:** `0022_dues.sql`

## Why

Since 0021 a bill can be completed on Credit, but nothing tracks what is owed afterwards.
When a customer pays back, the app cannot record it, and the cash they hand over
makes the day's count differ from expected cash with no explanation. The owner wants to record
repayments, have them count in the day's cash, and see who owes what.

## Decisions taken (with the owner, 2026-09-24)

| Question | Decision |
|---|---|
| How is a repayment applied? | A **running balance per customer**, like a paper khata. Any amount, not matched to bills. |
| Credit with no customer? | **Refused.** Credit needs a customer on the bill. Old customer-less credit bills are shown as "Unassigned credit" for the admin to attach. |
| Who records and reverses? | **Admin and biller** can both record and reverse a repayment. Every reversal keeps who, when and a required reason. |
| Existing khata udhaar? | **Opening balance** entry per customer, admin only, with a required note. Touches no day's cash. |
| Overpayment? | **Refused.** A repayment cannot exceed the balance. No advances. |
| Repayment modes | Cash, UPI, Card. Only cash counts toward expected cash. |
| Storage | **Derived balance.** Bills stay the source of credit charges; a new table holds only openings, repayments and reversals. |

## Data

### `dues_entries` (new)

`id uuid pk, vendor_id uuid not null references vendors on delete cascade,
customer_id uuid not null references customers,
kind text not null check (kind in ('opening','repayment')),
amount numeric(10,2) not null check (amount > 0),
mode text check (mode in ('cash','upi','card')),
note text, business_date date not null, created_by uuid not null references app_users,
created_at timestamptz not null default now(),
reversed_at timestamptz, reversed_by uuid references app_users, reverse_reason text`

- `check ((kind = 'repayment') = (mode is not null))`: a repayment has a mode, an opening has none.
- `check (kind <> 'opening' or coalesce(trim(note), '') <> '')`: an opening needs a note.
- `check ((reversed_at is null) = (reversed_by is null) and (reversed_at is null) = (reverse_reason is null))`.
- `business_date` is the Asia/Kolkata date of `created_at`, set by the writing function.
- Index `(vendor_id, customer_id)`, and `(vendor_id, business_date) where kind = 'repayment'`.
- RLS on. There is a read policy `vendor_id = current_vendor_id()` and **no** write policy. The functions below are the only
  writers, as with `bill_payments`.
- Rows are never deleted, except by `clear_vendor_data`.

### Balance

For one customer:

```
charges    = sum(bill_payments.amount) over that customer's bills with status 'done'
             and mode 'credit'  (a voided bill is no longer 'done', so it drops out)
           + sum(amount) of their un-reversed 'opening' entries
repaid     = sum(amount) of their un-reversed 'repayment' entries
balance    = charges - repaid
```

- **Positive:** the customer owes. **Zero:** settled. **Negative:** overpaid. That happens only when a
  credit bill is voided after being partly repaid. It is shown as "Overpaid" and a later credit
  bill uses it up naturally.
- **Oldest unpaid date:** order the charges by date (a credit bill by its completed date, an opening by its
  `business_date`). The oldest unpaid date is the date of the first charge whose running total exceeds `repaid`
  (FIFO). It is null when the balance is ≤ 0.
- One internal SQL function, `customer_due(p_vendor, p_customer)`, computes this, and every reader uses
  it so there is one definition.

## Server functions

All are `security definer set search_path = public`. Each gets `revoke all ... from public, anon`, then `grant
execute ... to authenticated`, following the 0021 pattern. Money inputs must be > 0 and exact to the paisa.

### `record_repayment(p_customer uuid, p_amount numeric, p_mode text, p_note text default null)`

- Admin or biller only.
- The customer must belong to the caller's vendor.
- The mode must be cash, UPI or card.
- **Lock order**, the same as `complete_bill`: vendor row `FOR SHARE`, then customer row `FOR UPDATE`. The first
  lock makes a concurrent `close_day` serialize with it. The second stops two tills from both taking the
  last ₹340.
- Refused with `'day is closed'` if today (IST) has an active close.
- Refused with `'more than the balance'` if `p_amount` > the balance. This also covers a balance of zero
  or below.
- Inserts a `repayment` entry for today and returns it.

### `record_opening_balance(p_customer uuid, p_amount numeric, p_note text)`

- Admin only.
- The note is required.
- Takes the customer lock `FOR UPDATE`.
- Inserts an `opening` entry dated today and returns it.
- Not subject to the day lock, because it moves no cash.

### `reverse_dues_entry(p_entry uuid, p_reason text)`

- The reason is required.
- **A repayment** can be reversed by an admin or biller. **An opening** can be reversed by an admin only.
- Refused with `'already reversed'` if the entry is already reversed.
- For a repayment: takes the vendor `FOR SHARE` lock and refuses with `'day is closed'` if the entry's
  `business_date` has an active close. A closed day's cash never changes.
- Stamps `reversed_at`, `reversed_by` and `reverse_reason`, and returns the row.

### `assign_credit_customer(p_bill uuid, p_customer uuid)`

- Admin only.
- The bill must be the caller's, with status `done`, a `credit` payment, and `customer_id is null`. Otherwise
  it is refused with `'bill cannot be assigned'`.
- Sets `bills.customer_id`. Awards no points retroactively and sends no message.
- It moves no cash, so a closed day does not block it.

### `dues_list()`

- For all staff of the vendor.
- Returns one row per customer whose balance ≠ 0: `customer_id, name, flat_no, mobile, balance,
  oldest_unpaid`.
- Sorted by balance descending, so overpaid customers come last.

### `unassigned_credit()`

- For admins.
- Returns done credit bills with no customer: `bill_id, token_no, completed_at, amount`, newest first.

### `customer_dues(p_customer uuid)`

For all staff. It returns:
- **The balance**, from `customer_due`.
- **A timeline, newest first.** Each row has `kind` ('credit_bill', 'opening', 'repayment'), `id`, `at`,
  `business_date`, `amount`, `mode`, `note`, `by_name`, and for bills `token_no`. Reversed entries are
  included with `reversed_at`, `reversed_by_name`, `reverse_reason` and `day_closed` (whether the entry's
  day has an active close, so the web can hide Reverse). Voided credit bills are not listed.

### Changes to existing functions

- **`complete_bill`:** after the mode check, when `p_payment_mode = 'credit'` and the bill's `customer_id` is null,
  it raises `'credit needs a customer'` (errcode 22023). The existing idempotency guard still runs first
  for an already-done bill, so a retry is unaffected. **Must be re-created from 0021's body** with only
  this change.
- **`expected_cash_for`:** adds the un-reversed cash repayments for that date. A reversal restores the
  figure, but it can only happen while the day is open.
- **`day_summary`:** gains `dues_cash, dues_upi, dues_card` and the matching counts, from that date's
  un-reversed repayments. `expected_cash` includes `dues_cash`. The return type changes, so it must be
  `drop function` + `create`, and its grants re-issued.
- **`clear_vendor_data`:** deletes `dues_entries` before `customers`.
- **`void_bill`:** unchanged. The balance is derived, so a voided credit bill drops out by itself.

## Web

### Dues list (`/dues`, in the admin and biller nav)

- Rows show the name, flat, the **amount owed** (or "Overpaid ₹X", muted), and "since 12 Sep" from `oldest_unpaid`.
- Search by name, flat or mobile, filtered on the client.
- The total outstanding appears at the top.
- **Admin only:** an "Unassigned credit (N) ₹X" row, shown only when N > 0. It opens a list of those bills. Each one
  has "Assign customer", which uses the customer picker Bill already uses (search by name, flat or mobile).

### Customer dues page (`/dues/:customerId`, unlisted route for admin and biller)

- The balance is at the top. Below it is the timeline: credit bills with the token and a link to `/receipt/:billId`,
  openings, repayments, and reversed entries struck through with the reason.
- **Received payment**, shown when the balance > 0: the amount is pre-filled with the balance, then Cash / UPI / Card
  (none preselected), then an optional note and Confirm. The button stays disabled until a mode is chosen and the amount is
  valid and ≤ the balance.
- **Add opening balance** (admin only): an amount and a required note.
- **Reverse** on each un-reversed repayment (admin, biller) and opening (admin), asking for a reason.
  It is hidden when `day_closed`.
- After any successful write, the page reloads from the server.

### Pending

- With no customer on the bill, the **Credit** button is disabled, with the hint "Add a customer to give credit".
- With a customer who owes more than zero, the confirm shows "Already owes ₹X", read from `customer_dues` (balance only).

### Close day

- Expected cash reads "Cash sales ₹A + Dues received in cash ₹B".
- The summary lists dues received by mode on separate lines from sales.

### Dashboard

- A new card: **Outstanding dues ₹X · N customers**, from `dues_list()`, linking to `/dues`. Admin only,
  as the dashboard is.

### Errors (`errors.ts`, en/hi/mr)

- `credit needs a customer` becomes `dues.needCustomer`.
- `more than the balance` becomes `dues.overBalance`.
- `already reversed` becomes `dues.alreadyReversed`.
- `bill cannot be assigned` becomes `dues.cannotAssign`.
- `day is closed` reuses the existing mapping.

## Testing

**DB:**
- Every function's role gate and input checks, and that nothing leaks across vendors.
- The balance across credit bills, openings, repayments and reversals.
- A voided credit bill after a partial repayment gives an overpaid (negative) balance, and a repayment against it is refused.
- The FIFO oldest-unpaid date.
- Two connections repaying the last amount concurrently: exactly one succeeds.
- A repayment racing a close: it is either counted in expected cash or refused.
- A repayment and a reversal on a closed day are refused.
- `expected_cash_for` and `day_summary` include cash repayments and exclude reversed ones.
- Credit without a customer is refused, while a retry of an already-done credit bill still succeeds.
- `assign_credit_customer` rules.
- Clearing data removes the entries.
- Direct writes to `dues_entries` are denied.

**Web:**
- The Dues list and Customer dues page, including role differences.
- The Pending credit gating and the "Already owes" line.
- The Close day breakdown, the dashboard card and every error mapping.

## Deploy

- No Edge Function changes.
- Apply 0022, then merge immediately. From the moment 0022 is applied, the old app's Close day still works, because
  its columns are a subset of the new `day_summary`. The old app can still offer Credit with no customer, but the server refuses it
  loudly, so there is no data harm.

## Out of scope

- WhatsApp reminders (WhatsApp is on hold).
- A printed repayment receipt.
- Advances.
- Showing dues to recorders.
- Interest.
- Editing an entry. Reverse and re-enter instead.
