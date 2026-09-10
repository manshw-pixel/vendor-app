# Redeeming loyalty points at the counter

**Status:** design, not built.

## What the vendor asked for

> While billing if points want to be encashed by customer. 1 point = 1 rupee. If yes
> subtract the total and update the points for customer.

At payment, the biller can apply some of the customer's points to the bill. One point is
one rupee off. The customer pays the remainder; their balance drops by what they spent.

## Where this happens, and why there

The recorder builds the basket and issues a token; the **biller** takes payment from the
Pending queue, and `complete_bill()` is what moves stock and awards points. Redemption goes
in the same transaction, for the same reason those already are: it is the moment money
changes hands, and there is no window in which a discount is promised but unapplied.

Recording the intent at basket time and applying it at payment was considered and rejected:
it is two screens, two states, and a stale proposal to reconcile if the customer never
returns to pay.

## The part that is not obvious: expiry

`points_ledger` is append-only and a balance is a sum:

```sql
select coalesce(sum(points), 0) from points_ledger
 where customer_id = $1 and expires_at > now()
```

Every row needs an `expires_at`, and rows leave the sum once it passes. That makes both
obvious ways to record a redemption wrong, in opposite directions:

- **Give the redemption row a normal expiry** (say 30 days out). When it passes, the `-40`
  drops out of the sum and **the customer silently gets the spent points back** -- and keeps
  getting them back. There is a passing test for redemptions today
  (`points_balance.test.mjs:29`) and it cannot catch this: it uses a future expiry and never
  advances time.
- **Give the redemption row no expiry at all** (`infinity`). Now the `-40` outlives the
  `+100` it was spent from, so once the earned batch expires **the balance goes negative**
  and the customer owes points they never borrowed.

**A redemption row inherits the expiry of the points it consumes.** Redemption is FIFO over
expiry buckets, and consuming across two buckets writes two rows:

```
earn +100 exp day 30      redeem 120  ->  -100 exp day 30
earn  +50 exp day 60                      -20  exp day 60
```

Every negative row now leaves the sum at the same instant as the points it cancelled, so the
balance is correct at every point in time rather than only on the day it was written. The
ledger stays append-only, which its own comment in `0001_schema.sql` insists on.

A bucket is an `expires_at` value, not a row: a batch already partly spent has
`sum(points)` remaining at that expiry. The consumption query is therefore
`group by expires_at having sum(points) > 0 order by expires_at`.

### The cost of this model

`days_left` comes from `min(expires_at)` over unexpired rows. A fully-consumed batch still
has both its rows in the table until they expire, so a customer can be told "expires in 3
days" about points they have already spent. The **balance** is right; the **date** can be
pessimistic. Fixing it means tracking consumption per batch rather than deriving it, which
is a larger change than this feature earns. Recorded here so it is a known limit rather
than a surprise.

## Schema

**`bills.redeemed_points integer not null default 0 check (redeemed_points >= 0)`.**

**`bills.total` stores the NET** -- the cash actually taken. A `1000` bill with `100`
redeemed stores `900` and `redeemed_points = 100`.

This needs no dashboard changes, and that is worth stating because it looks like it should.
`top_items` / `top_items_between` sum `bill_items.line_total`, so item revenue stays the
gross value of goods sold, which is correct. Only the `collected` views and
`collected_between()` sum `bills.total`, and those answer "how much money came in" -- which
after a redemption is the net. Both numbers stay true without touching either.

## `complete_bill()` gains a third parameter

```
complete_bill(p_bill_id uuid, p_biller_id uuid default null, p_redeem_points integer default 0)
```

**Migration `0010` must `drop` then `create`, NOT `create or replace`.** Adding a parameter
creates a second function rather than replacing the first, and PostgREST resolves overloads
by argument name -- the resulting ambiguity surfaces as "function not found", which is
exactly the failure that took down the live dashboard when `0007` sat unpushed. The old
two-argument signature is dropped explicitly.

Order of operations inside:

1. Lock the bill (`for update`) -- unchanged.
2. Existing tenant and role guards -- unchanged. Only an admin or biller completes a sale.
3. The already-`done` early return -- unchanged, and load-bearing here: it is what stops a
   retried request redeeming a second time.
4. Compute `v_gross` from `bill_items`, never from `bills.total` -- unchanged, and for the
   same reason as before: a recorder could have set `bills.total` to anything while the bill
   was still `recording`.
5. If `p_redeem_points > 0`: **lock the customer row** (`select 1 from customers where
   id = ... for update`), read the balance, cap, write the FIFO rows.
6. `v_net := v_gross - v_redeemed`.
7. Stock decrement -- unchanged.
8. Points earned, computed on **`v_net`** (see below).
9. `update bills set total = v_net, redeemed_points = v_redeemed, status = 'done', ...`.

### Why the customer row is locked, not the ledger rows

Two tills completing two bills for the same customer at once must not both spend the same
points. Locking the customer's existing `points_ledger` rows does not prevent it -- row locks
do not block a concurrent INSERT, and each transaction would read a balance that ignores the
other's pending redemption. Locking the `customers` row serialises any two redemptions for
that customer, which is the actual invariant.

### The cap

`v_redeemed := least(p_redeem_points, balance, floor(v_gross))`, enforced in the function,
not merely in the form.

`floor` because points are whole rupees and a `99.50` bill can absorb at most `99`. This is
also what keeps the `total >= 0` check constraint on `bills` satisfiable -- the cap is the
constraint's guard, so the two must not drift apart.

A request above the cap is **clamped, not refused.** The biller is at a counter with a
customer; failing the sale because the customer misremembered their balance by ten points is
worse than applying what they actually have. The function returns what it applied.

### Points earned are computed on the net

A `1000` bill with `100` redeemed earns on `900`.

Points reward money spent. On the gross, a customer sitting near a threshold could redeem to
stay above it and earn repeatedly on money they never paid -- a loop that mints points out of
points. `0006` already made both thresholds inclusive; this keeps the rule explicable at the
counter: *you earn on what you pay.*

## Client changes

- **`listPending`** also selects `customer_id`. The Pending row needs it to read a balance,
  and `PendingBill` does not carry it today.
- **The Pending screen** gains, per bill: the customer's balance
  (`customer_points_balance()`, which already exists and is already tenant-guarded), a points
  input, and a confirm that reads *"Collect ₹900 -- ₹100 paid from points"* so the biller
  says the right number out loud.
- **`completeBill(billId)`** takes an optional points argument.
- **`pointsForBill()` must filter `points > 0`.** It currently selects every ledger row for a
  bill to report "you earned N points". After this change a redeemed bill has BOTH its award
  row and its negative redemption rows under the same `bill_id`, and the sum would
  under-report -- or go negative on a bill that earned nothing. Redemption rows keep their
  `bill_id` deliberately: it is the only record of which sale spent which points.

## Testing

The database suite carries this feature. The tests that earn their place:

- **The expiry test.** Earn 100 expiring in 30 days, redeem 40, then advance past that
  expiry and assert the balance is **0** -- not `-40` (immortal redemption row) and not `+60`
  (phantom refund). Neither failure is caught by anything today.
- **FIFO across buckets.** Two batches with different expiries, one redemption spanning both:
  assert two negative rows are written, with the right amounts against the right expiries.
- **The cap**, three ways: above balance, above the bill total, and against a `99.50` bill
  where `floor` decides.
- **Points earned on the net**, not the gross -- a bill that would cross a threshold gross but
  not net must not award.
- **A retry does not redeem twice** -- call `complete_bill` on an already-`done` bill and
  assert the balance is unchanged.
- **Cross-vendor refusal**, as every other function in this file has.
- **`pointsForBill` reports only the award**, on a bill that both earned and redeemed.

Web tests cover the Pending screen's input, the confirm's arithmetic, and that a failed
completion does not claim points were spent.

## Deployment

Migration `0010` replaces the function that awards points and moves stock. It joins `0009`
(clear data) and the `admin-delete-user` function in the queue. Deploy with the suite green
and nobody mid-sale.

## Deliberately not in this slice

- **Refunding a redemption.** Undoing a completed sale is not a flow this app has at all;
  adding one for points only would be half a feature.
- **Expiring points on a schedule during redemption.** `expire_points()` (`0005`) already
  runs nightly and writes its own offsetting rows; redemption reads the same unexpired
  buckets and needs no coordination with it.
- **Per-batch consumption tracking**, which would make `days_left` exact. Noted above as a
  known limit.
