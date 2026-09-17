# The printed receipt

Slice A of four. Gives the customer something to walk away with: a 58mm slip
carrying the token, the lines, what was paid, and what the points did.

Not a numbered requirement. `docs/product-spec.md` mentions bill PDFs only in
passing, under the Drive leg of the build order, and never says the customer
receives anything at the counter at all.

## Why this slice, and why now

The four gaps a working shop hits first, in descending frequency: a receipt
(every bill), a network blip mid-bill (every few bills on a bad day), points
expiring unannounced (every repeat customer), and margin (never during a sale).
All four are in scope; this is the first.

It goes first for three reasons. It is self-contained — no other slice depends
on it, and it depends on none. It is the highest-frequency gap: today a customer
pays and the token exists only on a screen they do not hold. And it drags in,
almost free, the visible half of gap three — the expiry line on the slip is the
first time a customer is told their points have a deadline.

It also goes before the resilience work deliberately. Slice B touches the
`complete_bill` call path, which is the same call this slice renders from.
Building B first would mean rewriting A's assumptions about when a bill is
final.

## Decisions taken

**One HTML render, printed through the OS print dialog — not an ESC/POS
driver.** Three options were weighed. Web Bluetooth with raw ESC/POS bytes gives
byte-level control, but does not exist in Safari/iOS, locking the counter to
Chrome on Android permanently; worse, thermal printers' built-in fonts are
codepage-based and generally carry no Devanagari, so every Marathi or Hindi slip
would have to be rendered to a bitmap — a sub-project of its own. No printer at
all, with the customer photographing a screen, is free but a poor counter
experience in a queue and leaves the vendor no paper trail. The chosen option
renders once as a narrow print-styled page: that single render is simultaneously
the on-screen slip, what `window.print()` sends to a paired thermal printer, and
the source a later PDF/Drive slice will consume. Devanagari works because the
browser shapes the text, not the printer firmware.

The known cost: many cheap Indian thermal printers need their vendor's Android
print-service app installed before they appear in the print dialog. That is a
one-time setup step, not a code problem, but it means printer choice is not
arbitrary — pick a model with a documented Android print service.

**Informal receipt, not a GST tax invoice.** A tax invoice would pull in a
GSTIN on the vendor row, a legally-sequential invoice number separate from the
token counter (tokens are per-day and operational), HSN codes per item, a
per-line taxable-value/CGST/SGST breakdown, and retention and cancellation
rules. Fresh unbranded produce is largely nil-rated and small shops are commonly
under the registration threshold, so this is moot until a vendor is registered.
The slip is designed so those fields are a later extension, not a rewrite.

**Staff-only, at a stable URL.** The slip carries the customer's name, flat
number and points balance. A public unguessable link would make it sendable but
would publish a home address to anyone who ever receives the link. Staff-only
now; a thin public variant — token, lines, total, no flat and no balance — is a
later addition the render is structured to allow.

**Points earned is read from the ledger, never recomputed client-side.** A
client-side copy of the threshold rule would drift from `complete_bill` the
first time a vendor tunes their config in Settings.

**No auto-print on completion.** A print dialog firing by itself mid-queue is
worse than a button, and it would fire again on every retry of a flaky
`complete_bill` — which Slice B is about to make more common.

**No reprint counter and no DUPLICATE marking.** Reprint is reopening the URL.
The reasons to mark duplicates are all tax-document reasons, ruled out above.

## What the slip looks like

58mm is about 32 characters. Items take two lines because a Marathi name and
three numbers do not fit on one.

```
--------------------------------
        ताजी भाजी मार्केट
      Shop 12, Kothrud, Pune
         98765 43210
--------------------------------
Token         #0147
17-09-2026          7:42 PM
Sunita Kale          Flat B-304
--------------------------------
टोमॅटो
  2.5 kg x  40.00     100.00
कांदा
  1.0 kg x  32.00      32.00
बटाटा
  3.0 kg x  28.00      84.00
--------------------------------
Items: 3          Subtotal 216.00
Points redeemed         - 50.00
Total                    166.00
Paid                     166.00
--------------------------------
Points earned                0
Balance                    260
Expires 02-10-2026 (15 days)
--------------------------------
   Served by Sunil · धन्यवाद!
--------------------------------
```

Item names follow the app's current language; numbers stay Latin, because
Devanagari digits are unreadable to a chunk of customers and to any price check.
The `Points earned 0` above is correct, not a bug — see below.

The language limit, stated plainly: the slip renders in the language the device
is set to, so a Marathi-speaking customer served on an English-set device gets
an English slip. A per-customer language preference is a `customers` column
nobody has asked for.

## Where the data comes from

Four of the five pieces already exist.

- **Bill header** — `bills`: `token_no`, `completed_at`, `total`,
  `redeemed_points`.
- **Lines** — `billLines()` in `web/src/history.ts`: qty, unit price, line
  total, and item names in all three languages.
- **Customer** — `customers(name, flat_no)`, already joined in `BILL_COLS`.
- **Balance and expiry** — the `customer_points_balance(uuid)` RPC, which
  already returns `balance` and `days_left`.
- **Shop header — missing.** `vendors` has `name` and the loyalty config, no
  address and no phone.

Two reads are new: `points_ledger` filtered to this `bill_id` with `points > 0`,
and a join from `bills.biller_id` to `app_users.name` for the "Served by" line.
The join goes in a receipt-specific `RECEIPT_COLS` rather than `BILL_COLS`, so
the history list does not pay for a column it never renders.

### Schema change

One migration adds `vendors.address` and `vendors.phone`, both nullable `text`,
and Settings grows two fields. Nullable so existing vendor rows stay valid; the
slip omits a blank line rather than printing an empty one.

### The two traps

**`bills.total` stores the NET.** `0010_points_redemption.sql` says so on the
column comment, and `history.ts` repeats it: the gross is
`total + redeemed_points`. A slip that prints `total` as the subtotal shows the
discount twice. Computed once, named `gross`, never inline in JSX.

**PostgREST serialises `numeric` as a string.** `total` and `line_total` arrive
as text. Coerced at the module boundary so nothing downstream does string
arithmetic and prints `216.0050`.

### Points are earned after redemption

`complete_bill` measures the thresholds against `v_net`, the amount actually
paid, and 0010 documents why: on the gross, a customer near a threshold could
redeem to stay above it and earn again on money they never handed over — points
minting points. So a ₹216 bill that redeems ₹50 earns nothing, and the slip says
so. This is the first time that rule becomes visible to a customer.

## Shape of the code

A new `web/src/receipt.ts` beside `history.ts`, `data.ts` and `admin.ts` — a
fourth sibling, for the reason the other three exist: a small surface the
screens stub in tests. It exports `loadReceipt(billId)` returning a finished
`Receipt` object, already coerced and already carrying `gross`. The screen does
no arithmetic and no null-juggling.

Like its siblings, nothing in it filters by vendor. RLS scopes every query; a
client-side filter would be a weaker second copy of the policy.

`web/src/screens/Receipt.tsx` renders that object once. A `@media print` block
is the only thing separating screen from paper — no second printable component,
because that is the duplication that drifts.

- `@page { size: 58mm auto; margin: 0 }`. Height `auto`: a slip has no page
  length, and a fixed one ejects a blank second page.
- `width: 58mm` on the receipt root.
- A monospace stack with an **explicit Devanagari fallback**. Most monospace
  stacks carry no Devanagari and the browser silently substitutes a proportional
  face, which breaks column alignment on exactly the lines holding item names.
  The deliberate fallback is what makes the two-line item layout hold.
- On screen, the same block centred on a plain background: what the biller sees
  is the slip.

Printing is `window.print()` on a route rendering the receipt and nothing else —
no nav shell, no buttons in the output.

## Route and access

`/receipt/:billId`, added to `BY_ROLE` for `admin` and `biller` but **not
`recorder`**: a recorder hands off at the token stage, never sees money, and has
no reason to read a points balance.

`routes.ts` says it in its own header and it holds here — these guards are UX,
not security. What stops a biller opening another vendor's receipt is RLS on
`bills`, `bill_items`, `customers` and `points_ledger`. This slice adds no
table, so it inherits that boundary rather than needing a new one. The one
assertion worth a test rather than a comment: `customer_points_balance` is
`SECURITY DEFINER` and deliberately crosses tenants when `current_vendor_id()`
is null; from a signed-in biller it is non-null, so the guard fires.

`canAccess` matches exact paths, so a parameterised route needs a small change
there. That is the one piece of existing code this slice modifies rather than
adds to.

The route is not in the nav. It is reached from a bill: a Print button on
Completed, and on the confirmation after `complete_bill` succeeds.

## Testing

- **DB:** `vendors.address` and `phone` exist, are nullable, and an existing
  vendor row survives the migration.
- **`receipt.ts`:** `gross = total + redeemed_points`, redeemed and not;
  numeric-as-string coercion; `points_earned` reads the positive ledger row and
  is 0 when there is none; a **null-customer** bill renders as a walk-in with no
  name, flat or points block; a null biller name does not blank the slip.
- **Render:** three-language item name selection; the redemption line appears
  only when `redeemed_points > 0`; the expiry line is absent at zero balance.

The null-customer case is the likeliest to bite — every existing screen joins
`customers` optionally, and the receipt must too.

**Not covered, and no test will cover it:** whether the slip physically prints
correctly on a 58mm roll. That needs paper. It is the slice's one manual
verification step and belongs in the runbook.

## Not in this slice

- **PDF generation and Drive upload.** The browser's print dialog already offers
  Save as PDF; a server-side pipeline plus Drive OAuth is a slice of its own.
  The receipt route is exactly the input that slice will need, so nothing here
  is wasted.
- **A public or sendable receipt link**, and with it the WhatsApp delivery of
  one. WhatsApp remains on hold for want of a number.
- **Per-customer language preference.**
- Slices B (resilient billing), C (the rest of expiring-points visibility) and
  D (purchase cost and margin), each of which gets its own spec.
