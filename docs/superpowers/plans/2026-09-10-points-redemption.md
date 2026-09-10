# Points Redemption Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** At payment, a biller can apply some of a customer's loyalty points to the bill at 1 point = ₹1; the customer pays the remainder and their balance drops by what they spent.

**Architecture:** Redemption happens inside `complete_bill()` — the same transaction that already moves stock and awards points — so a discount can never be promised but unapplied. `points_ledger` stays append-only: a redemption writes negative rows FIFO over expiry buckets, **each inheriting the `expires_at` of the points it consumes**, so every negative row leaves the balance sum at the same instant as what it cancelled. `bills.total` stores the net (cash taken) and a new `redeemed_points` column records what was applied.

**Tech Stack:** PostgreSQL 17 (plpgsql, `SECURITY DEFINER`), the bespoke node runner in `tests/`, React 19 + TypeScript 7, vitest 5.

**Spec:** `docs/superpowers/specs/2026-09-10-points-redemption-design.md`

## Global Constraints

- **1 point = ₹1.** Points are integers; money is `numeric(10,2)`.
- **The cap is `least(p_redeem_points, balance, floor(v_gross))`, enforced in the function**, not merely in the form. `floor` because a ₹99.50 bill can absorb at most 99 whole points, and because `bills.total` carries a `check (total >= 0)` that the cap is the guard for.
- **A request above the cap is clamped, never refused.** The biller is at a counter with a customer; failing a sale because the customer misremembered their balance is worse than applying what they have.
- **Points earned are computed on the NET total.** On the gross, a customer near a threshold could redeem to stay above it and earn repeatedly on money they never paid.
- **A redemption row inherits the `expires_at` of the batch it consumes.** Never `now() + interval` (silently refunds the points later), never `infinity` (drives the balance negative once the earned batch expires).
- **`points_ledger` is append-only.** Never `UPDATE` or `DELETE` a ledger row; a balance is always a sum.
- **`v_gross` is recomputed from `bill_items`, never read from `bills.total`** — a recorder could have set that to anything while the bill was `recording`.
- **Migrations are append-only.** Never edit `0001`–`0009`.
- Roles are exactly `'admin' | 'recorder' | 'biller'`; only admin or biller may complete a sale.
- Every user-facing string is a key present in all three of `web/src/i18n/{en,hi,mr}.json`. `hi.json` ends sentences with a danda (`।`); `mr.json` uses a full stop.
- This codebase writes comments explaining WHY, not what.

---

## File Structure

**Created:**
- `supabase/migrations/0010_points_redemption.sql` — the `redeemed_points` column, the dropped 2-arg `complete_bill`, and the 3-arg replacement carrying FIFO redemption.
- `tests/redemption.test.mjs` — the database suite for redemption. Kept separate from `complete_bill.test.mjs`, which already covers that function's other duties and should stay readable.

**Modified:**
- `tests/run.mjs` — import the new test file.
- `web/src/data.ts` — `listPending` selects `customer_id`; `completeBill` takes points; `pointsForBill` filters `points > 0`; `PendingBill` gains `customer_id`.
- `web/src/screens/Pending.tsx` — balance display, points input, confirm arithmetic.
- `web/src/i18n/{en,hi,mr}.json` — new keys.
- `web/src/__tests__/Pending.test.tsx` — the screen's new behaviour.
- `web/src/__tests__/data.test.ts` — the three changed data functions.

---

### Task 1: Migration 0010 — the column and FIFO redemption

**Files:**
- Create: `supabase/migrations/0010_points_redemption.sql`
- Create: `tests/redemption.test.mjs`
- Modify: `tests/run.mjs` (add the import beside the other test files)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: column `bills.redeemed_points integer not null default 0 check (redeemed_points >= 0)`; SQL function `complete_bill(p_bill_id uuid, p_biller_id uuid default null, p_redeem_points integer default 0) returns void`. The old two-argument signature no longer exists.

- [ ] **Step 1: Write the failing test**

Create `tests/redemption.test.mjs`. Note the house idioms: `once()` defers seeding because `run.mjs` imports test files *before* `bootstrap()` rebuilds the schema, and each case builds its own vendor so ledger assertions never see another case's writes.

```javascript
import { test, assert, assertEqual, once } from "./framework.mjs";
import { sql } from "./fixtures.mjs";
import { seedTwoVendors } from "./seed.mjs";

const getWorld = once(seedTwoVendors);

/**
 * A vendor with one item, one customer and one `billed` bill of the given total.
 * Mirrors complete_bill.test.mjs's billedBill(): its own vendor per case, so stock and
 * ledger assertions are never polluted by a neighbour.
 */
async function billedBill({ total, stockKg = 100, qtyKg = 5, vendorOverrides = {} }) {
  const { rows: [v] } = await sql(`insert into vendors (name) values ('Redeem Co') returning id`);
  for (const [col, val] of Object.entries(vendorOverrides)) {
    await sql(`update vendors set ${col} = $1 where id = $2`, [val, v.id]);
  }
  const { rows: [c] } = await sql(
    `insert into customers (vendor_id, name, flat_no, mobile)
     values ($1,'RC','E-1', '+91955550' || floor(random()*10000)::text) returning id`, [v.id]);
  const { rows: [i] } = await sql(
    `insert into items (vendor_id, name_en, price, stock_kg) values ($1,'Onion',40,$2) returning id`,
    [v.id, stockKg]);
  const { rows: [b] } = await sql(
    `insert into bills (vendor_id, customer_id, total, status)
     values ($1,$2,$3,'recording') returning id`, [v.id, c.id, total]);
  await sql(`insert into bill_items (bill_id, vendor_id, item_id, qty_kg, unit_price, line_total)
             values ($1,$2,$3,$4,40,$5)`, [b.id, v.id, i.id, qtyKg, total]);
  await sql(`select issue_token($1)`, [b.id]);
  return { vendorId: v.id, customerId: c.id, billId: b.id };
}

/** Gives a customer a batch of points expiring in `inDays`. */
const grant = (w, points, inDays) => sql(
  `insert into points_ledger (vendor_id, customer_id, points, expires_at)
   values ($1,$2,$3, now() + ($4 || ' days')::interval)`,
  [w.vendorId, w.customerId, points, String(inDays)]);

/** The balance exactly as the app computes it. */
const balance = async (customerId) => {
  const { rows: [r] } = await sql(`select * from customer_points_balance($1)`, [customerId]);
  return r.balance;
};

const billRow = async (billId) => {
  const { rows: [r] } = await sql(`select total, redeemed_points, status from bills where id = $1`,
    [billId]);
  return r;
};

test("redeeming subtracts from the bill and from the balance", async () => {
  const w = await billedBill({ total: 500 });
  await grant(w, 100, 30);

  await sql(`select complete_bill($1, null, $2)`, [w.billId, 40]);

  const b = await billRow(w.billId);
  assertEqual(Number(b.total), 460, "the bill should record the net actually collected");
  assertEqual(b.redeemed_points, 40, "the bill should record what was applied");
  assertEqual(await balance(w.customerId), 60, "the balance should drop by what was spent");
});

test("a redemption row expires WITH the points it consumed, not later", async () => {
  // THE test for this feature. A redemption row given its own future expiry drops out of
  // the balance sum when it passes and silently REFUNDS the spent points. The existing
  // redemption case in points_balance.test.mjs cannot catch this: it never advances time.
  const w = await billedBill({ total: 500 });
  await grant(w, 100, 30);

  await sql(`select complete_bill($1, null, $2)`, [w.billId, 40]);
  assertEqual(await balance(w.customerId), 60, "precondition: 60 left before expiry");

  // Move every one of this customer's ledger rows into the past by 31 days, which is what
  // the passage of time does to them. The earned batch and its redemption must leave the
  // sum together.
  await sql(`update points_ledger set expires_at = expires_at - interval '31 days'
              where customer_id = $1`, [w.customerId]);

  assertEqual(await balance(w.customerId), 0,
    "after the batch expired the balance must be 0 -- not 40 (refunded) and not -40");
});

test("a redemption never drives the balance negative once the batch expires", async () => {
  // The opposite failure to the one above: a redemption row with no expiry (or a far one)
  // outlives the batch it was spent from, and the customer ends up owing points.
  const w = await billedBill({ total: 500 });
  await grant(w, 100, 30);
  await sql(`select complete_bill($1, null, $2)`, [w.billId, 100]);
  assertEqual(await balance(w.customerId), 0, "precondition: fully spent");

  await sql(`update points_ledger set expires_at = expires_at - interval '31 days'
              where customer_id = $1`, [w.customerId]);

  assertEqual(await balance(w.customerId), 0, "the balance must not go negative");
});

test("redemption consumes the soonest-expiring points first, across batches", async () => {
  const w = await billedBill({ total: 500 });
  await grant(w, 100, 10);   // expires first
  await grant(w, 50, 60);

  await sql(`select complete_bill($1, null, $2)`, [w.billId, 120]);

  assertEqual(await balance(w.customerId), 30, "150 granted minus 120 spent");

  // Two negative rows, one per bucket consumed, each carrying that bucket's expiry.
  const { rows } = await sql(
    `select points, expires_at from points_ledger
      where customer_id = $1 and points < 0 order by expires_at`, [w.customerId]);
  assertEqual(rows.length, 2, "should write one negative row per bucket consumed");
  assertEqual(rows[0].points, -100, "the soonest bucket should be drained first");
  assertEqual(rows[1].points, -20, "the remainder comes from the later bucket");
});

test("the sooner batch expiring leaves exactly the later batch's remainder", async () => {
  // Proves the pairing holds per bucket, not just in aggregate: after the 10-day batch and
  // its -100 both lapse, what is left is 50 - 20 from the 60-day batch.
  const w = await billedBill({ total: 500 });
  await grant(w, 100, 10);
  await grant(w, 50, 60);
  await sql(`select complete_bill($1, null, $2)`, [w.billId, 120]);

  await sql(`update points_ledger set expires_at = expires_at - interval '11 days'
              where customer_id = $1`, [w.customerId]);

  assertEqual(await balance(w.customerId), 30, "only the later bucket's remainder survives");
});

test("redeeming more than the balance applies only what the customer has", async () => {
  // Clamped, not refused: a customer misremembering their balance must not fail the sale.
  const w = await billedBill({ total: 500 });
  await grant(w, 30, 30);

  await sql(`select complete_bill($1, null, $2)`, [w.billId, 200]);

  const b = await billRow(w.billId);
  assertEqual(b.redeemed_points, 30, "only the 30 they had");
  assertEqual(Number(b.total), 470, "and the bill reflects exactly that");
  assertEqual(await balance(w.customerId), 0, "spent down to nothing, never below");
});

test("redeeming more than the bill applies only what the bill can absorb", async () => {
  const w = await billedBill({ total: 100 });
  await grant(w, 500, 30);

  await sql(`select complete_bill($1, null, $2)`, [w.billId, 500]);

  const b = await billRow(w.billId);
  assertEqual(b.redeemed_points, 100, "capped at the bill");
  assertEqual(Number(b.total), 0, "a bill can be paid entirely in points");
  assertEqual(await balance(w.customerId), 400, "the rest stays with the customer");
});

test("a part-rupee bill absorbs only whole points", async () => {
  // total >= 0 is a check constraint on bills; floor() is what keeps the cap from
  // violating it, so the two must not drift apart.
  const w = await billedBill({ total: 99.5 });
  await grant(w, 500, 30);

  await sql(`select complete_bill($1, null, $2)`, [w.billId, 500]);

  const b = await billRow(w.billId);
  assertEqual(b.redeemed_points, 99, "99 whole points, not 99.5");
  assertEqual(Number(b.total), 0.5, "half a rupee still to pay");
});

test("points are earned on what was paid, not on the bill before redemption", async () => {
  // Thresholds 600/50 and 1000/100 are the vendor defaults. A 620 bill with 40 redeemed
  // pays 580, which is under the first threshold: it must earn nothing. Awarding on the
  // gross would let a customer redeem to stay above a threshold and earn repeatedly on
  // money they never paid.
  const w = await billedBill({ total: 620 });
  await grant(w, 40, 30);

  await sql(`select complete_bill($1, null, $2)`, [w.billId, 40]);

  const { rows: [r] } = await sql(
    `select coalesce(sum(points),0)::int as p from points_ledger
      where bill_id = $1 and points > 0`, [w.billId]);
  assertEqual(r.p, 0, "580 paid is under the 600 threshold, so nothing is earned");
});

test("a bill that still clears the threshold after redeeming does earn", async () => {
  // The other half of the rule, so the test above is not passing for the trivial reason
  // that redemption suppresses points entirely.
  const w = await billedBill({ total: 700 });
  await grant(w, 40, 30);

  await sql(`select complete_bill($1, null, $2)`, [w.billId, 40]);

  const { rows: [r] } = await sql(
    `select coalesce(sum(points),0)::int as p from points_ledger
      where bill_id = $1 and points > 0`, [w.billId]);
  assertEqual(r.p, 50, "660 paid still clears 600, so the first tier is earned");
});

test("completing an already-done bill again does not redeem twice", async () => {
  // complete_bill is idempotent by guard, and that guard is what makes a retried request
  // (double tap, network retry) safe now that money is involved.
  const w = await billedBill({ total: 500 });
  await grant(w, 100, 30);

  await sql(`select complete_bill($1, null, $2)`, [w.billId, 40]);
  const after = await balance(w.customerId);

  await sql(`select complete_bill($1, null, $2)`, [w.billId, 40]);

  assertEqual(await balance(w.customerId), after, "the second call must change nothing");
  assertEqual((await billRow(w.billId)).redeemed_points, 40, "and must not double the record");
});

test("redeeming zero leaves the ledger untouched", async () => {
  const w = await billedBill({ total: 500 });
  await grant(w, 100, 30);

  await sql(`select complete_bill($1)`, [w.billId]);

  assertEqual(await balance(w.customerId), 100, "nothing spent");
  const { rows } = await sql(
    `select count(*)::int as n from points_ledger where customer_id = $1 and points < 0`,
    [w.customerId]);
  assertEqual(rows[0].n, 0, "no negative row should be written for a zero redemption");
});

test("a bill with no customer cannot redeem", async () => {
  // bills.customer_id is nullable -- a walk-in has no loyalty account to spend from.
  const { rows: [v] } = await sql(`insert into vendors (name) values ('Walkin Co') returning id`);
  const { rows: [i] } = await sql(
    `insert into items (vendor_id, name_en, price, stock_kg) values ($1,'Onion',40,100) returning id`,
    [v.id]);
  const { rows: [b] } = await sql(
    `insert into bills (vendor_id, total, status) values ($1,500,'recording') returning id`, [v.id]);
  await sql(`insert into bill_items (bill_id, vendor_id, item_id, qty_kg, unit_price, line_total)
             values ($1,$2,$3,5,40,500)`, [b.id, v.id, i.id]);
  await sql(`select issue_token($1)`, [b.id]);

  await sql(`select complete_bill($1, null, $2)`, [b.id, 40]);

  const { rows: [r] } = await sql(`select total, redeemed_points from bills where id = $1`, [b.id]);
  assertEqual(Number(r.total), 500, "nothing to redeem against, so the full total stands");
  assertEqual(r.redeemed_points, 0, "and nothing is recorded as redeemed");
});

test("a recorder still cannot complete a bill, redemption or not", async () => {
  // The role guard predates this feature and must survive it: complete_bill is admin or
  // biller only.
  const world = await getWorld();
  const w = await billedBill({ total: 500 });
  await grant(w, 100, 30);
  await sql(`update app_users set vendor_id = $1 where id = $2`,
    [w.vendorId, world.a.recorderId]);

  const { error } = await world.a.clients.recorder
    .rpc("complete_bill", { p_bill_id: w.billId, p_redeem_points: 40 });
  assert(error, "a recorder must not be able to complete a sale");

  assertEqual(await balance(w.customerId), 100, "and must not have spent anything");
});
```

Add the import to `tests/run.mjs`, after the `clear_vendor_data` line:

```javascript
import "./redemption.test.mjs";
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test` (from the repository root)
Expected: FAIL — `column "redeemed_points" does not exist`, and `function complete_bill(uuid, unknown, integer) does not exist`.

- [ ] **Step 3: Write the migration**

Create `supabase/migrations/0010_points_redemption.sql`:

```sql
-- Redeeming loyalty points at the counter: 1 point = 1 rupee off the bill.
--
-- Applied inside complete_bill() because that is already the transaction that moves stock
-- and awards points -- the moment money changes hands. A discount applied anywhere else
-- would leave a window in which it is promised but unapplied.
alter table bills
  add column redeemed_points integer not null default 0 check (redeemed_points >= 0);

comment on column bills.redeemed_points is
  'Points spent on this bill. bills.total stores the NET actually collected, so gross = total + redeemed_points.';

-- DROP then CREATE, not CREATE OR REPLACE. Adding a parameter makes a SECOND function
-- rather than replacing the first, and PostgREST resolves overloads by argument name --
-- the resulting ambiguity reads as "function not found", which is exactly the failure
-- that left the live dashboard broken while 0007 sat unpushed.
--
-- Existing callers passing only p_bill_id keep working: arguments 2 and 3 have defaults.
drop function if exists complete_bill(uuid, uuid);

create function complete_bill(
  p_bill_id uuid,
  p_biller_id uuid default null,
  p_redeem_points integer default 0
) returns void
  language plpgsql security definer set search_path = public as $$
declare
  v_bill      bills%rowtype;
  v_vendor    vendors%rowtype;
  v_points    integer := 0;
  v_gross     numeric;
  v_net       numeric;
  v_redeemed  integer := 0;
  v_balance   integer := 0;
  v_want      integer;
  v_take      integer;
  v_bucket    record;
begin
  select * into v_bill from bills where id = p_bill_id for update;
  if not found then
    raise exception 'bill % not found', p_bill_id;
  end if;

  -- Same trust decision as issue_token(): a null current_vendor_id() means the caller has
  -- no end-user session (service role / superuser), which is allowed; a non-null one must
  -- own this bill, and if it's an end user, only admin or biller may complete a sale.
  if current_vendor_id() is not null and current_vendor_id() <> v_bill.vendor_id then
    raise exception 'bill % does not belong to your vendor', p_bill_id;
  end if;
  if current_vendor_id() is not null and current_user_role() not in ('admin', 'biller') then
    raise exception 'role % may not complete bills', current_user_role();
  end if;

  -- Idempotent by guard: a retried request (double click, network retry) must not award
  -- points twice, decrement stock twice, or -- now that money is involved -- redeem twice.
  -- Already-done is success, not an error.
  if v_bill.status = 'done' then
    return;
  end if;
  if v_bill.status <> 'billed' then
    raise exception 'bill % is %, expected billed', p_bill_id, v_bill.status;
  end if;

  select * into v_vendor from vendors where id = v_bill.vendor_id;

  -- #3 (forgeable total): recompute the authoritative total from the line items rather
  -- than trusting bills.total, which a recorder could set to anything while the bill was
  -- still 'recording'. This is what the points decision (and the stored total) is based on.
  select coalesce(sum(line_total), 0) into v_gross from bill_items where bill_id = p_bill_id;

  v_want := greatest(coalesce(p_redeem_points, 0), 0);

  if v_want > 0 and v_bill.customer_id is not null then
    -- Lock the CUSTOMER, not their ledger rows. Two tills completing two bills for the
    -- same customer at once must not both spend the same points, and a row lock on the
    -- existing ledger rows would not prevent that: row locks do not block a concurrent
    -- INSERT, so each transaction would read a balance blind to the other's redemption.
    perform 1 from customers where id = v_bill.customer_id for update;

    select coalesce(sum(points), 0)::integer into v_balance
      from points_ledger
     where customer_id = v_bill.customer_id and expires_at > now();

    -- floor() because points are whole rupees: a 99.50 bill absorbs at most 99. It is
    -- also what keeps bills' check (total >= 0) satisfiable, so the cap and the constraint
    -- must not drift apart.
    v_redeemed := least(v_want, greatest(v_balance, 0), floor(v_gross)::integer);

    -- Clamped, never refused. The biller is at a counter with a customer; failing the sale
    -- because they misremembered their balance by ten points is the worse outcome.
    if v_redeemed > 0 then
      -- FIFO over expiry BUCKETS, not rows: a batch already partly spent has sum(points)
      -- remaining at that expiry. Each negative row inherits the bucket's expires_at, so
      -- it leaves the balance sum at the same instant as the points it cancelled. Given a
      -- normal future expiry instead, the row would lapse on its own and silently refund
      -- the spent points; given none, it would outlive its batch and drive the balance
      -- negative. Both are wrong, in opposite directions.
      v_take := v_redeemed;
      for v_bucket in
        select expires_at, sum(points)::integer as remaining
          from points_ledger
         where customer_id = v_bill.customer_id and expires_at > now()
         group by expires_at
        having sum(points) > 0
         order by expires_at
      loop
        exit when v_take <= 0;
        insert into points_ledger (vendor_id, customer_id, bill_id, points, expires_at)
        values (v_bill.vendor_id, v_bill.customer_id, p_bill_id,
                -least(v_take, v_bucket.remaining), v_bucket.expires_at);
        v_take := v_take - least(v_take, v_bucket.remaining);
      end loop;
    end if;
  end if;

  v_net := v_gross - v_redeemed;

  -- Stock (#3). greatest(...,0) keeps the non-negative check from turning an
  -- over-sold line into a hard failure at the counter with a customer waiting.
  update items i
     set stock_kg = greatest(i.stock_kg - agg.qty, 0)
    from (select item_id, sum(qty_kg) as qty
            from bill_items where bill_id = p_bill_id group by item_id) agg
   where i.id = agg.item_id;

  -- Points (#15). Thresholds and rewards are this vendor's config, never constants.
  -- Both comparisons are >=: a spend that reaches a target earns that target's reward.
  --
  -- Measured against v_net, the amount actually PAID. On the gross, a customer sitting
  -- near a threshold could redeem to stay above it and earn again on money they never
  -- handed over -- points minting points.
  if v_net >= v_vendor.points_threshold_2 then
    v_points := v_vendor.points_reward_2;
  elsif v_net >= v_vendor.points_threshold_1 then
    v_points := v_vendor.points_reward_1;
  end if;

  if v_points > 0 and v_bill.customer_id is not null then
    insert into points_ledger (vendor_id, customer_id, bill_id, points, expires_at)
    values (v_bill.vendor_id, v_bill.customer_id, p_bill_id, v_points,
            now() + (v_vendor.redeem_days || ' days')::interval);

    -- #16: tell the customer their points, queued in the same transaction.
    insert into outbound_messages (vendor_id, customer_id, template_key, payload)
    values (v_bill.vendor_id, v_bill.customer_id, 'points_awarded',
            jsonb_build_object('points', v_points, 'total', v_net,
                               'redeemed', v_redeemed,
                               'expires_in_days', v_vendor.redeem_days));
  end if;

  -- #7 (forgeable attribution): prefer the real signed-in caller over the client-supplied
  -- argument. p_biller_id only applies for a service-role caller, which has no auth.uid().
  update bills
     set status = 'done',
         completed_at = now(),
         total = v_net,
         redeemed_points = v_redeemed,
         biller_id = coalesce(auth.uid(), p_biller_id, biller_id)
   where id = p_bill_id;
end $$;

revoke all on function complete_bill(uuid, uuid, integer) from public, anon;
grant execute on function complete_bill(uuid, uuid, integer) to authenticated;
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: PASS — 104 passed, 0 failed (89 existing + 15 new). Every pre-existing `complete_bill` test must still pass: they call `select complete_bill($1)`, which resolves to the new signature via its defaults.

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/0010_points_redemption.sql tests/redemption.test.mjs tests/run.mjs
git commit -m "feat(db): redeem loyalty points against a bill at 1 point per rupee"
```

---

### Task 2: The data layer

**Files:**
- Modify: `web/src/data.ts` (`PendingBill`, `listPending`, `completeBill`, `pointsForBill`)
- Modify: `web/src/__tests__/data.test.ts`

**Interfaces:**
- Consumes: `complete_bill(p_bill_id, p_biller_id, p_redeem_points)` from Task 1.
- Produces:
  - `PendingBill` gains `customer_id: string | null`
  - `completeBill(billId: string, redeemPoints?: number)`
  - `customerBalance(customerId: string)` — new, wrapping the existing `customer_points_balance` RPC
  - `pointsForBill` unchanged in signature, but now returns only rows with `points > 0`

- [ ] **Step 1: Write the failing test**

Add to `web/src/__tests__/data.test.ts` (match the file's existing mock style for `supabase`):

```typescript
describe("the billing data layer, with redemption", () => {
  it("sends the points to complete_bill under the parameter name the function declares", async () => {
    // PostgREST resolves the overload by argument NAME. A mismatch here reads as
    // "function not found", which is how migration 0007 broke the live dashboard.
    await completeBill("b1", 40);
    expect(rpc).toHaveBeenCalledWith("complete_bill", { p_bill_id: "b1", p_redeem_points: 40 });
  });

  it("omits the points entirely when none are redeemed", async () => {
    // The function defaults p_redeem_points to 0; sending an explicit 0 is equivalent but
    // sending undefined is not, so the no-redemption path must not send the key at all.
    await completeBill("b1");
    expect(rpc).toHaveBeenCalledWith("complete_bill", { p_bill_id: "b1" });
  });

  it("asks for the customer id in the pending queue", async () => {
    // The screen needs it to read a balance; PendingBill did not carry one before.
    await listPending();
    expect(select).toHaveBeenCalledWith(expect.stringContaining("customer_id"));
  });

  it("reads only the AWARD rows for a bill, never the redemption rows", async () => {
    // After this feature a redeemed bill carries both its award row and its negative
    // redemption rows under the same bill_id. Summing all of them would under-report what
    // the customer earned, or go negative on a bill that earned nothing.
    await pointsForBill("b1");
    expect(gt).toHaveBeenCalledWith("points", 0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd web && npx vitest run src/__tests__/data.test.ts`
Expected: FAIL — `completeBill` takes one argument, the select omits `customer_id`, and `pointsForBill` applies no `gt` filter.

- [ ] **Step 3: Change the data layer**

In `web/src/data.ts`:

```typescript
export type PendingBill = {
  id: string;
  token_no: number;
  total: number;
  // Needed to read a loyalty balance before completing. Nullable because a walk-in bill
  // has no customer, and therefore nothing to redeem against.
  customer_id: string | null;
  customers: { name: string; flat_no: string } | null;
};
```

```typescript
export async function listPending() {
  return supabase
    .from("bills")
    .select("id, token_no, total, customer_id, customers(name, flat_no)")
    .eq("status", "billed")
    .order("token_no", { ascending: false });
}

/**
 * Completes a sale, optionally spending some of the customer's points on it.
 *
 * p_redeem_points is omitted rather than sent as 0 when nothing is redeemed: the function
 * defaults it, and the parameter names must match 0010_points_redemption.sql exactly --
 * PostgREST resolves the overload by argument name and a mismatch reads as
 * "function not found".
 */
export async function completeBill(billId: string, redeemPoints?: number) {
  const args: Record<string, unknown> = { p_bill_id: billId };
  if (redeemPoints && redeemPoints > 0) args.p_redeem_points = redeemPoints;
  return supabase.rpc("complete_bill", args);
}

/** The customer's unexpired points balance. Already tenant-guarded inside the function. */
export async function customerBalance(customerId: string) {
  return supabase.rpc("customer_points_balance", { p_customer_id: customerId });
}
```

And `pointsForBill` gains the filter, with its doc comment extended:

```typescript
/** What complete_bill() actually AWARDED for this bill, not a client-side recompute of the
 *  vendor's threshold. Filtered on bill_id only for the tenant -- RLS (points_read) already
 *  scopes the read, so a second vendor filter here would be a weaker client-side copy of
 *  the policy. Zero rows is legitimate: a bill under the vendor's first threshold earns no
 *  points and complete_bill() writes no row for it.
 *
 *  points > 0 matters since redemption existed: a redeemed bill carries its award row AND
 *  its negative redemption rows under this same bill_id, and summing both would report the
 *  customer earned less than they did -- or a negative number on a bill that earned nothing. */
export async function pointsForBill(billId: string) {
  return supabase.from("points_ledger").select("points").eq("bill_id", billId).gt("points", 0);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd web && npx vitest run src/__tests__/data.test.ts`
Expected: PASS. If the file's `supabase` mock has no `gt`, add it to the chain the same way `eq` is mocked.

- [ ] **Step 5: Commit**

```bash
git add web/src/data.ts web/src/__tests__/data.test.ts
git commit -m "feat: carry redeemed points through the billing data layer"
```

---

### Task 3: The Pending screen

**Files:**
- Modify: `web/src/screens/Pending.tsx`
- Modify: `web/src/i18n/en.json`, `web/src/i18n/hi.json`, `web/src/i18n/mr.json`
- Modify: `web/src/__tests__/Pending.test.tsx`

**Interfaces:**
- Consumes: `completeBill(billId, redeemPoints?)`, `customerBalance(customerId)`, `PendingBill.customer_id` from Task 2.
- Produces: no new exports.

**Behaviour:** when a biller opens the confirm for a bill that has a `customer_id`, the screen reads that customer's balance and offers a points input, defaulting to empty. The confirm states what will be collected and what is coming from points. A bill with no `customer_id`, or a customer with a zero balance, shows no input at all — there is nothing to spend.

- [ ] **Step 1: Write the failing test**

Add to `web/src/__tests__/Pending.test.tsx`, following that file's existing mock style:

```typescript
describe("redeeming points at the counter", () => {
  it("offers no points input for a walk-in bill", async () => {
    // customer_id is null: there is no loyalty account to spend from.
    listPending.mockResolvedValueOnce({
      data: [{ id: "b1", token_no: 7, total: 500, customer_id: null, customers: null }],
      error: null,
    });
    render(<Pending />);
    fireEvent.click(await screen.findByTestId("pending-complete-b1"));
    expect(screen.queryByTestId("redeem-input")).toBeNull();
  });

  it("offers no points input when the customer has none", async () => {
    customerBalance.mockResolvedValueOnce({ data: [{ balance: 0, days_left: null }], error: null });
    render(<Pending />);
    fireEvent.click(await screen.findByTestId("pending-complete-b1"));
    await waitFor(() => expect(customerBalance).toHaveBeenCalled());
    expect(screen.queryByTestId("redeem-input")).toBeNull();
  });

  it("sends the points the biller entered", async () => {
    render(<Pending />);
    fireEvent.click(await screen.findByTestId("pending-complete-b1"));
    fireEvent.change(await screen.findByTestId("redeem-input"), { target: { value: "40" } });
    fireEvent.click(screen.getByTestId("pending-confirm-b1"));
    await waitFor(() => expect(completeBill).toHaveBeenCalledWith("b1", 40));
  });

  it("completes with no points when the field is left empty", async () => {
    render(<Pending />);
    fireEvent.click(await screen.findByTestId("pending-complete-b1"));
    await screen.findByTestId("redeem-input");
    fireEvent.click(screen.getByTestId("pending-confirm-b1"));
    await waitFor(() => expect(completeBill).toHaveBeenCalledWith("b1", 0));
  });

  it("shows the biller what to actually collect", async () => {
    // The number they say out loud. Getting this wrong at the counter is the whole risk of
    // the feature.
    render(<Pending />);
    fireEvent.click(await screen.findByTestId("pending-complete-b1"));
    fireEvent.change(await screen.findByTestId("redeem-input"), { target: { value: "40" } });
    expect((await screen.findByTestId("redeem-summary")).textContent ?? "").toMatch(/460/);
  });

  it("will not let the biller type more points than the customer has", async () => {
    // The function clamps server-side too, but a form that accepts 500 and then collects a
    // different number than it displayed would be worse than one that refuses to show it.
    render(<Pending />);
    fireEvent.click(await screen.findByTestId("pending-complete-b1"));
    fireEvent.change(await screen.findByTestId("redeem-input"), { target: { value: "999" } });
    expect((screen.getByTestId("redeem-summary").textContent ?? "")).toMatch(/460|500/);
    fireEvent.click(screen.getByTestId("pending-confirm-b1"));
    await waitFor(() => expect(completeBill).toHaveBeenCalled());
    const sent = completeBill.mock.calls[0]?.[1] as number;
    expect(sent).toBeLessThanOrEqual(100);
  });
});
```

The file's existing mock of `../data` needs `customerBalance` added, defaulting to a balance of 100:

```typescript
const customerBalance = vi.fn(async (..._a: unknown[]) =>
  ({ data: [{ balance: 100, days_left: 12 }], error: null }));
```

and the default `listPending` mock row needs `customer_id: "c1"`.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd web && npx vitest run src/__tests__/Pending.test.tsx`
Expected: FAIL — there is no `redeem-input`, and `completeBill` is called with one argument.

- [ ] **Step 3: Add the redemption controls**

In `web/src/screens/Pending.tsx`, when a bill's confirm opens:

- if `bill.customer_id` is null, skip the balance read entirely and render no input;
- otherwise call `customerBalance(bill.customer_id)`, store `balance`;
- if `balance <= 0`, render no input;
- otherwise render an input (`data-testid="redeem-input"`, `inputMode="numeric"`) and a summary line (`data-testid="redeem-summary"`);
- clamp the parsed value to `Math.min(balance, Math.floor(bill.total))` for both the summary and the value sent;
- pass the clamped number to `completeBill(bill.id, points)`.

The clamp mirrors the function's own cap. Add a comment saying so, and saying which is authoritative: the function's, because the form's is a courtesy that a stale balance can make wrong.

- [ ] **Step 4: Add the translation keys**

Add to all three of `web/src/i18n/{en,hi,mr}.json`. English wording:

```
pending.balance:       "{{points}} points available"
pending.redeem:        "Points to use"
pending.redeemSummary: "Collect ₹{{net}} — ₹{{used}} paid from points"
pending.redeemAll:     "Use all"
```

Translate faithfully into `hi.json` and `mr.json`. **Follow each file's own terminator convention** — `hi.json` uses the danda (`।`), `mr.json` a full stop — and keep the app's existing transliterations (पॉइंट्स). These are AI-written like every Indian-language string in this project and have never been reviewed by a speaker; that is a tracked, project-wide gap, not a blocker for this task.

- [ ] **Step 5: Run tests and verify key parity**

Run: `cd web && npx vitest run src/__tests__/Pending.test.tsx`
Expected: PASS.

Then verify the three locale files still parse and hold identical key sets:

```bash
cd "D:/AI Project/vendor-app" && python -c "
import json,io
def keys(o,p=''):
    out=set()
    for k,v in o.items(): out |= keys(v,p+k+'.') if isinstance(v,dict) else {p+k}
    return out
en=keys(json.load(io.open('web/src/i18n/en.json',encoding='utf-8')))
for l in ('hi','mr'):
    o=keys(json.load(io.open(f'web/src/i18n/{l}.json',encoding='utf-8')))
    assert en==o, (l, sorted(en^o))
print('parity ok:', len(en))"
```

- [ ] **Step 6: Commit**

```bash
git add web/src/screens/Pending.tsx web/src/i18n/ web/src/__tests__/Pending.test.tsx
git commit -m "feat: let a biller spend a customer's points on the bill"
```

---

### Task 4: Full verification and the deploy note

**Files:**
- Modify: `docs/runbook-first-admin.md`

- [ ] **Step 1: Run every suite and the type check**

Record the actual output; do not claim any result you did not see:

```bash
cd "D:/AI Project/vendor-app" && npm test
cd "D:/AI Project/vendor-app/web" && npm test
cd "D:/AI Project/vendor-app/web" && npx tsc --noEmit
```

Expected: 104 passed in the database suite; the web suite fully green; `tsc` exit 0.

`tsc` passing locally is **not** evidence CI will pass: TypeScript 7 is a per-platform native binary and the Linux CI build has previously rejected code Windows accepted.

- [ ] **Step 2: Document the redemption rule**

Add a short section to `docs/runbook-first-admin.md` covering: 1 point = ₹1, applied by the biller at payment; the cap (balance, bill, whole points) is enforced by the function and a request above it is clamped rather than refused; points are earned on the amount actually paid; and that `bills.total` stores the net while `redeemed_points` records what was applied, so gross = `total + redeemed_points`.

State the known limit plainly: `days_left` can name a date belonging to a batch that is already fully spent, because consumption is derived rather than tracked. The balance is always right; the date can be pessimistic.

- [ ] **Step 3: Commit**

```bash
git add docs/runbook-first-admin.md
git commit -m "docs: how points redemption behaves at the counter"
```

- [ ] **Step 4: Hand over the deployment**

Do **not** run this. It targets the vendor's Cloud project. Migration `0010` replaces the function that awards points and moves stock, so it goes out with the suite green and nobody mid-sale. It joins `0009` and the `admin-delete-user` function already waiting in the queue:

```bash
supabase functions deploy admin-delete-user
supabase db push                              # migrations 0009 and 0010
```

Then merge and push the client.

---

## Self-Review

**Spec coverage.** Ledger model and FIFO bucket consumption → Task 1 (migration + the two expiry tests + the FIFO test). `bills.redeemed_points` and net `total` → Task 1. `drop`-then-`create` → Task 1 step 3, with the reason. Customer-row lock → Task 1 step 3. The cap including `floor` → Task 1, three tests. Clamp-not-refuse → Task 1, the over-balance test. Points on net → Task 1, both directions. `listPending` carrying `customer_id`, `completeBill` taking points, `pointsForBill` filtering `points > 0` → Task 2. Pending screen → Task 3. Dashboards needing no change → asserted implicitly by the untouched analytics tests staying green in Task 4; no code change was specified because none is needed. `days_left` known limit → Task 4 step 2. Deployment → Task 4 step 4. Nothing in the spec is unclaimed.

**Placeholders.** None. Task 3 step 3 describes the screen's behaviour in prose rather than full JSX, because `Pending.tsx`'s existing structure is what the controls must fit into and a fabricated copy of that file would be worse guidance than the precise list of required test ids, data flow and clamp rule given there. Every test id it names is asserted by Task 3 step 1's tests.

**Type consistency.** `redeemPoints?: number` in Task 2 is consumed as `completeBill(bill.id, points)` in Task 3. `customerBalance` returns the RPC's `{ balance, days_left }` shape in both. `PendingBill.customer_id` is `string | null` in Task 2 and null-checked in Task 3. `p_bill_id` / `p_biller_id` / `p_redeem_points` are spelled identically in the migration, the data layer and its test.

**One risk worth naming.** Task 1 drops a function that production is actively using. Between `drop` and `create` inside the same migration transaction the function does not exist, so a sale completing at that exact instant fails — which is why Task 4 says to deploy with nobody mid-sale. `supabase db push` runs each migration in a transaction, so the window is milliseconds and the failure mode is a refused completion the biller can retry, not a corrupted bill.
