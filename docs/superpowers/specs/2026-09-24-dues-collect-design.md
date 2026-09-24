# Dues follow-up: credit that shrinks when paid, and collecting a due with the next bill — design

**Date:** 2026-09-24
**Builds on:** `0021_payments_and_day_close.sql`, `0022_dues.sql` (live)
**Migration:** `0023_dues_collect.sql`

## Why

The owner asked for two changes after using the Dues slice:

1. **Credit should show what is still uncollected.** A day's "Credit (not yet collected)" line kept showing the credit given even after the customer paid it back. The repayment appeared on a separate "Dues · UPI" line instead of on the UPI line.
2. **Collect an old due with the next bill.** When a customer who owes money comes back to buy, the biller should be able to take the old due together with the new bill.

## Decisions taken (with the owner, 2026-09-24)

| Question | Decision |
|---|---|
| What does a day's Credit line mean? | **Credit given that day that is still uncollected, as of now.** When the customer pays, whenever that happens, that day's Credit line goes down. A payment clears the oldest credit first (FIFO), as in a khata. |
| Where does a repayment count? | On the **day it is received**, under the mode it was paid in (Cash, UPI or Card). The separate "Dues · mode" lines go away; each mode line includes that day's dues, with a note "incl. ₹X dues". |
| Opening balances | Belong to no day's sales. They are allocated first in FIFO order by date, so paying them moves no day's Credit line. They still count under the mode on the day the money is received. |
| Closed days | A closed day's **Credit** figure may still change, because it is computed and never stored. Its **cash count** never changes, because `day_closes` stores it. |
| Dashboard | The split follows the same rules for the selected range. |
| Collecting a due with a bill | At **Pending**, when completing the bill, one server call. The due is recorded as a repayment, never as a sale. |
| Collect on a credit bill? | **No.** The option is hidden when the mode is Credit, and the server refuses it. |

## Data

### `dues_entries.bill_id` (new column)

`bill_id uuid references bills(id) on delete set null`. It is nullable, and set only on a repayment collected together with a bill, so the slip can print it.
- `on delete set null`: `clear_vendor_data` deletes bills before dues entries, and those entries are deleted anyway.
- A void never deletes a bill, so the link stays.

### Credit still uncollected (new internal function)

`credit_open()` has invoker rights, so RLS scopes it. It returns one row per done credit bill that has a customer: `bill_id, customer_id, business_date, amount, open`.

```
charges  = the customer's done credit bills (amount = bill_payments.amount, at = completed_at)
           + their un-reversed openings (amount, at = created_at)
paid     = sum of their un-reversed repayments
running  = cumulative sum of charges ordered by at (ties broken by id)
open(i)  = greatest(0, least(amount_i, running_i - paid))
```

- Only the credit-bill rows are returned; openings take part in the allocation but are not returned.
- An overpaid customer, where `paid ≥ charges`, has every `open = 0`.
- A credit bill with no customer (unassigned, from before 0022) cannot be repaid, so `open = amount`. It is included through a union branch.

### `day_summary` (redefined, drop + create)

It keeps every existing column with the **same meaning**: `cash`, `upi` and `card` are still sales only, and `credit` is still credit given. It appends:
- `credit_open numeric` and `credit_open_count bigint`: the sum of `open` over that day's credit bills, and the number of those bills with `open > 0`.

The `dues_*` columns stay. `expected_cash` is unchanged.

Because existing columns keep their meaning, a tab that has not reloaded is unaffected. The **web** does the merging:
- A mode line's total is `split[m] + dues[m]`, and its count is bills + payments.
- The Credit line is `credit_open`.

### `payment_split_between(p_from, p_to)` (create or replace, same return type)

It keeps its rows and adds four:
- `dues_cash`, `dues_upi` and `dues_card`: un-reversed repayments whose `created_at` is in the range;
- `credit_open`: `open` summed over the credit bills completed in the range, with the count of those still open.

The old web ignores modes it doesn't know.

### `complete_bill` gains `p_collect_due numeric default 0`

The signature changes, so it is **drop + create**, as in 0021. A caller that doesn't send the new argument still resolves, because the argument has a default.

Its body is byte-for-byte 0022's, except for these additions after the day-closed check:

- `p_collect_due` must be `>= 0` and exact to the paisa. `0` means "none". Otherwise:
  - The mode must be cash, UPI or card. If it isn't, raise `'a due can only be collected in cash, upi or card'`.
  - The bill must have a customer. If it doesn't, raise `'credit needs a customer'`; the existing mapping already covers this.
  - Lock the customer `FOR UPDATE`. The existing redemption path takes the same lock, and taking it twice in one transaction is harmless. The order is bill, then vendor, then customer, the same as `record_repayment`'s vendor-then-customer, so no cycle is possible.
  - If `p_collect_due > customer_due(customer)`, raise `'more than the balance'`. The balance is read before this bill counts, and this bill is never credit.
  - `created_by = coalesce(auth.uid(), p_biller_id)`. If that is null, raise `'a due needs a signed-in biller'`.
  - Insert a `repayment` in `dues_entries`, with `mode = p_payment_mode`, `amount = p_collect_due`, `bill_id = p_bill_id`, `business_date` = today (IST) and `note = null`.
- The idempotency guard still returns early for an already-done bill. A retry after a lost reply therefore records the due **once**, because the first attempt's transaction already did.

### `customer_dues` and `clear_vendor_data`

- `customer_dues`: unchanged.
- `clear_vendor_data`: unchanged. It already deletes `dues_entries`. Check that the `on delete set null` foreign key doesn't block its bill deletes.

### Voids

Voiding a bill that collected a due does **not** reverse the due payment: the money was received. Staff reverse the repayment separately if it was wrong, on the customer's dues page, with the usual rules.

## Web

### Close day

- Each Cash, UPI and Card line shows `split[m].total + dues[m].total` and a combined count. The count label stays `close.bills` if there are no dues; otherwise use a new key `close.billsAndPayments` ("{{bills}} bills, {{payments}} payments"). When `dues[m].total > 0`, add the note `close.inclDues` ("incl. {{amount}} dues").
- The Credit line shows `credit_open` and `credit_open_count`, and keeps the "(not yet collected)" note.
- The separate `close-dues-*` lines are **removed**.
- The "Cash sales ₹A + Dues received in cash ₹B" breakdown stays.

### Dashboard

- Mode lines are `split[m] + split['dues_'+m]`.
- The Credit line is `split.credit_open`.
- The "(not yet collected)" note stays.

### Pending

When the customer owes money (`owes > 0`) and the chosen mode is not Credit, the confirm shows:
- a checkbox, **"Also collect previous due"**, unchecked by default;
- an amount input, pre-filled with `owes` and editable. It must be > 0 and ≤ `owes`, using `parseAmount` from `duesRules`.

When the box is ticked:
- the confirm button reads **"Collect {{total}}"**, where total = the bill's net after points + the due;
- the call sends `p_collect_due`.

Picking Credit hides the section and sends nothing.

Refusals use the existing mappings:
- `more than the balance` maps to `dues.overBalance`;
- `credit needs a customer` maps to `dues.needCustomer`;
- the two new messages map to `dues.collectModeOnly` and `error.unknown`. The signed-in guard is unreachable from the web.

### Receipt

When a bill has an un-reversed repayment with `bill_id` = this bill, the slip prints, after the Paid row:
- "Previous due paid ₹X";
- "Total collected ₹(net + X)".

It is read in `receipt.ts` through `dues_entries(amount, reversed_at)` embedded on the bill. That embed needs the foreign-key hint `dues_entries!dues_entries_bill_id_fkey`.

## Testing

**DB:**
- `credit_open` FIFO:
  - an opening is allocated first;
  - a partial payment leaves the oldest bill partly open;
  - full payment brings every bill to 0;
  - an overpaid customer has everything at 0;
  - an unassigned credit bill has `open = amount`;
  - a voided credit bill is excluded;
  - nothing leaks across vendors.
- `day_summary`: `credit_open` falls after a later repayment, including after that day is closed, while the closed `expected_cash` is untouched.
- `payment_split_between`: the new rows.
- `complete_bill` with `p_collect_due`:
  - it records one repayment linked to the bill;
  - the repayment counts in expected cash;
  - a retry records nothing more;
  - it refuses over the balance, the Credit mode, no customer, a closed day and a sub-paisa amount;
  - a call without the argument still works, as an old tab would make it.

**Web:**
- the Close day merged lines and the credit-open figure;
- the dashboard merged split;
- Pending's collect section: shown or hidden, amount validation, the button total, and the argument sent;
- the receipt lines;
- every new i18n key in en, hi and mr.

## Deploy

- No Edge Function changes.
- Apply 0023, then merge.
- Old tabs are safe:
  - `day_summary` and `payment_split_between` only gained columns or rows, with the old meanings unchanged;
  - `complete_bill` defaults the new argument.

## Out of scope

- A partial-payment allocation that the user chooses bill by bill (FIFO only).
- Collecting a due without a bill at Pending (the Dues page already does that).
- Showing on the dues timeline which bill a repayment came with.
