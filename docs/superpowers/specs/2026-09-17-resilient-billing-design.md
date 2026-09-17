# Resilient billing: a bill that survives a lost reply

Slice B of four. Makes the line-write safe to repeat, and stops the completion screen
reporting failure for a sale that succeeded.

Not a numbered requirement. `docs/product-spec.md` fixes the token counter against
concurrent recorders (#12) but says nothing about a request whose reply is lost.

## Why this slice, and why it is smaller than it first looked

The four daily-use gaps were listed as receipt, network resilience, expiring-points
visibility, and margin. Slice A shipped the receipt.

**A correction belongs at the top of this document, because it changed the scope.** The
gap was originally described as "a dropped connection mid-bill is unhandled." That was
wrong. `Bill.tsx` already carries a resume state machine: it records what has landed, it
refuses to re-create a bill on retry, and after a lost `issue_token` reply it reads back
what the server actually wrote rather than inventing a token. The billing flow was
designed for this failure, and the slice is correspondingly narrow.

Four gaps were found on inspection. Two are worth building and two are not.

**Building — the `addLines` double-insert.** A lost reply after a committed insert leads
a retry to insert the same lines again. `issue_token` then recomputes a doubled total, a
doubled token is issued, and the customer is asked to pay twice for one basket. Nothing
can detect it afterwards: the doubled total *is* the total, on every screen and on the
printed receipt. `data.ts` and `Bill.tsx` both already name this and both already name
the fix — a replace-lines RPC, delete and insert in one transaction.

**Building — the completion read-back.** `Bill.tsx` reads back after a lost token reply;
`Pending.tsx` has no equivalent for `complete_bill`. On a lost reply it reports failure
for a sale that may well have committed. The risk is not the retry — `complete_bill` is
idempotent by guard — but the biller who believes the failure and re-records the sale by
hand, moving stock twice and awarding points twice.

**Not building — orphaned `recording` bills.** The resume pointer lives in React state, so
a reload mid-bill strands a bill in `recording` with its lines attached, invisible to
every screen. No customer is affected, no total is wrong, no stock moves. They are rows
nobody looks at, and the remedy — a cleanup query or an admin list — is no cheaper for
being built before anything needs it.

**Not building — automatic retry.** The staff member is at the counter and can press the
button. A retry layer over a flow that is already idempotent-by-guard buys a saved tap and
costs a new class of bug.

The work is precautionary: none of these has been reported in use. That is the reason for
cutting two of the four rather than building all of them.

## Decisions taken

**The client stops saying "add these lines" and starts saying "the lines are exactly
these."** This is the whole slice in one sentence. "Add" cannot be repeated safely — twice
said is twice inserted. "Set to exactly this" is idempotent by construction: called once or
five times with the same basket, the result is identical. Every retry problem here comes
from having modelled the operation as an append.

Two alternatives were weighed. An idempotency key plus a unique constraint works, but adds
a column, an index and a key lifecycle, and only makes a duplicate *detectable* — it never
expresses "the basket is exactly this," which is what the retry is trying to say.
`ON CONFLICT DO NOTHING` on a natural key is cheapest and wrong: two lines of the same item
at the same price are a legitimate basket (two separate weighings) and would be silently
collapsed.

**The RPC computes `line_total` server-side.** Today the client computes it and
`issue_token` sums the stored values, so a crafted request can set a bill's total to
anything. RLS stops another vendor's data being touched; it does not stop a recorder's own
client sending `line_total: 1` for 5 kg of tomatoes. Computing `round(qty_kg * unit_price,
2)` in the function closes that with no extra reads.

**`unit_price` is still taken from the request, not read from `items`.** Reading the live
price would close the hole completely but couples recording to the current price: an admin
editing a price mid-bill would change a basket already on screen. The price at the moment
of recording is the correct price, and the client holds it.

**An empty array is refused, not treated as "clear the bill."** `Bill.tsx` already disables
Done at zero lines, so an empty basket can only be a bug — and accepting it would let a
retry turn a real bill into a ₹0 one.

**`billHasLines` is deleted, not kept as a belt-and-braces check.** It exists only as the
mitigation this RPC replaces. Left in place beside the real fix, it invites a future caller
to reach for it again.

## The RPC

```sql
replace_bill_lines(p_bill_id uuid, p_lines jsonb) returns void
```

`p_lines` is a JSON array of `{ item_id, qty_kg, unit_price }`. No `line_total` — the
server computes it.

Guards, in order, each mirroring an existing function in `0003_functions.sql`:

1. **Bill exists**, locked `for update`, as in `issue_token` and `complete_bill`.
2. **Tenant.** A non-null `current_vendor_id()` must match the bill's vendor; null means a
   service-role caller and passes, exactly as the other two functions treat it.
3. **Role.** Admin or recorder. A biller has no business rewriting a basket.
4. **Status must be `recording`.** The most important guard. Without it a recorder could
   rewrite the lines of a `billed` bill — after the customer has been handed a token and
   told a total, and after the WhatsApp message quoting that total was queued. The bill's
   own lifecycle is what makes a destructive replace safe.
5. **Non-empty array**, per the decision above.

`SECURITY DEFINER`, `set search_path = public`, revoked from `public` and `anon`, granted
to `authenticated` — the shape every other function in this file takes.

### The rounding trap

`billing.ts` computes `line_total` as `Math.round(unitPrice * qtyKg * 100) / 100` on
floats. The RPC computes `round(qty_kg * unit_price, 2)` in exact numeric. These agree in
the ordinary case but can disagree by a paisa on a value landing exactly on a half, where
the float product may sit a hair below a midpoint the numeric one sits exactly on.

It matters because `runningTotal()` is what the recorder reads off the screen while
`issue_token` sums the stored rows: a disagreement means the token screen and the printed
receipt differ from the basket by a paisa.

The client keeps its `lineTotal` for display. A test asserts the two agree across awkward
values rather than assuming it. If they ever diverge, the database wins — it is the exact
one.

## Client changes

**`data.ts`** — `addLines` becomes `replaceBillLines(billId, lines)`, an `.rpc()` call. It
no longer takes `vendorId` (the function reads it from the bill) and no longer sends
`line_total`. `billHasLines` is deleted.

**`Bill.tsx`** — `confirm()` loses the three things that existed only because the write was
not idempotent: the `resuming` flag, the `alreadyLanded` check, and the `billHasLines`
round-trip. The call becomes unconditional on every attempt, first or fifth.

The resume state narrows with it. `written` is `{ billId, linesAdded }` today; nothing
needs `linesAdded` once the write is idempotent, so it becomes `{ billId }`. `billId` is
still required, because `createBill` is the one step that must not repeat — re-creating
would orphan the first bill in `recording` with its lines attached, and `issue_token`'s
guard cannot catch that, since it is a different bill.

The token read-back is untouched. It solves a different problem and this slice does not
improve on it.

**`Pending.tsx`** — on a `complete_bill` error, read the bill back before reporting
anything. `billToken()` already returns `token_no` and `status`, so it is reused rather
than a second near-identical read being added.

- `done` — it worked and the reply was lost. Show the normal completion and read the
  points as usual.
- `billed` — it genuinely failed. Report the failure, as today.
- the read itself fails — say plainly that we do not know, as `Bill.tsx` does with its
  token-unknown message. Do not claim success and do not claim failure. A biller told "we
  are not sure" checks the completed list; a biller told "failed" re-records the sale.

The net shape: one new migration, one deleted client function, one deleted branch, one
state machine with one fewer axis, and one screen reusing a read that already exists. The
resilience gets simpler rather than gaining another layer — which is the sign it is the
right fix.

## Testing

**Database**, where the real assurance lives:

- Calling it twice with the same basket leaves two lines, not four. **This is the test the
  slice exists for.**
- Calling it with a different basket replaces rather than accumulates.
- A `billed` bill and a `done` bill are both refused.
- An empty array is refused.
- Another vendor's bill is refused; a biller is refused.
- A request sending a forged `line_total` has the correct figure stored.
- Rounding agreement against the JavaScript across awkward values (`0.125`, `1.005`,
  `33.33 × 3`).

**Web:**

- Pressing Done twice after a failure sends the replace twice and creates one bill.
- The completion screen treats a lost reply on an already-`done` bill as success, and a
  genuinely-failed one as failure.
- The "we do not know" state renders when the read-back itself fails.

`Bill.test.tsx` mocks `addLines` and `billHasLines` today, so its retry tests change with
this slice. They must keep asserting that a second Done produces only one bill, and must
newly assert that it does not produce doubled lines — the assertion nothing can make today.

**Not covered, and stated plainly:** an actual mid-flight network drop. Every test here
simulates a lost reply; none pulls a cable. The database tests make the function provably
safe to repeat, which is the part that matters, but end-to-end behaviour on a genuinely
flaky link is verified by reasoning, not by a test.

## Not in this slice

- **Orphaned `recording` bills** and any cleanup or admin view of them.
- **Automatic retry or backoff** anywhere in the flow.
- **Reading `unit_price` from `items`**, and with it the last of the forged-request
  surface.
- **The `issue_token` read-back**, which already exists and is not improved here.
- Slices C (expiring-points visibility, largely absorbed by Slice A) and D (purchase cost
  and margin), each of which gets its own spec.
