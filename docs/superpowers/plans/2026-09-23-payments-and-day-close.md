# Payment Mode and Day Close Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Record how every bill was paid (Cash / UPI / Card / Credit), and let an admin or biller close the day against counted cash, which then locks completions and voids for that date.

**Architecture:** One migration, `0021_payments_and_day_close.sql`, built up over Tasks 1-3. `complete_bill` gains a required payment mode and writes a `bill_payments` row in its own transaction. A `day_closes` table, written only by `close_day`/`reopen_day`, is checked by `complete_bill` and `void_bill` under a vendor-row lock. The web adds a mode picker to Pending, the mode to the receipt, a Close day screen, an unclosed-days banner and a dashboard split.

**Tech Stack:** Postgres 17 (Supabase Cloud; tests on native PostgreSQL via `tests/run.mjs`), plpgsql, React 19 + react-router 7 + i18next, Vitest 5 + Testing Library, TypeScript 7.

**Spec:** `docs/superpowers/specs/2026-09-23-payments-and-day-close-design.md`

## Global Constraints

- Branch: `payments-and-day-close`. Never commit to `main`.
- DB suite: `npm test` at the repo root. Web suite: `npm test` in `web/`. Type check: `npx tsc --noEmit` in `web/`. **Never pipe a test command — the exit code is the gate.**
- Every calendar-day rule uses `(ts at time zone 'Asia/Kolkata')::date`, the same as `void_bill`.
- Payment modes are exactly `cash`, `upi`, `card`, `credit`, in that display order. `unrecorded` is a reporting label for bills with no payment row, never a stored mode.
- New tables have RLS enabled with a read policy `vendor_id = current_vendor_id()` and **no** write policy; security-definer functions are the only writers.
- Every function gets `revoke all ... from public, anon;` then `grant execute ... to authenticated` (plus `service_role` on read functions), as in 0016/0017.
- plpgsql refusals raised with a message the web matches on: `'day is closed'` and `'day already closed'`.
- Every i18n key is added to `en.json`, `hi.json` and `mr.json` together — `i18n-billing.test.ts` fails on any key-structure difference. Hindi sentences end with `।`, Marathi with `.`, matching the existing files.
- PostgREST returns `numeric` as a string. Every monetary value from the database passes through `Number()` before arithmetic or `rupees()`.
- Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **Deploy day banner flood.** The day 0021 ships, every past day with bills would count as unclosed. Expected: no banner until the first real business day after deploy. Pinned by `vendors.day_close_from` and the Task 3 test "unclosed_days ignores days before day_close_from".
2. **A completion racing a close.** A biller completes a bill at the same moment another closes the day. Expected: the sale is either counted in expected cash or refused with "day is closed", never silently after the count. Pinned by the Task 2 two-connection test.
3. **An old browser tab** still running the pre-0021 app calls `complete_bill` without a mode. Expected: a loud refusal, bill stays pending. Pinned by the Task 1 test "a missing mode is refused and nothing moves".
4. **A retried completion after close.** A biller's completion commits, the reply is lost, the day is closed, and the retry arrives. Expected: success (idempotent), not "day is closed". Pinned in the Task 2 lock test.
5. **Clear all data after closing today.** An admin closes today, then uses Settings → Clear all data. Expected: today is open again, not locked with no bills. Pinned by the Task 3 clear_vendor_data test.

---

## File Structure

| File | Responsibility |
|---|---|
| `supabase/migrations/0021_payments_and_day_close.sql` (create) | Both tables, `complete_bill`, `void_bill`, `close_day`, `reopen_day`, `day_summary`, `unclosed_days`, `payment_split_between`, `clear_vendor_data`, `vendors.day_close_from` |
| `tests/payments.test.mjs` (create) | Payment rows, mode validation, split function |
| `tests/day_close.test.mjs` (create) | Close/reopen, lock, summary, unclosed days, clear |
| `tests/run.mjs` (modify) | Register both files |
| existing `tests/*.test.mjs` (modify) | Pass a payment mode to every `complete_bill` call |
| `web/src/payments.ts` (create) | `PaymentMode`, `PAYMENT_MODES` — pure, importable from anywhere without mocks |
| `web/src/data.ts` (modify) | `completeBill(billId, mode, redeemPoints?)` |
| `web/src/screens/Pending.tsx` (modify) | Mode picker in the confirm dialog |
| `web/src/errors.ts` (modify) | `close.dayClosed`, `close.alreadyClosed` |
| `web/src/receipt.ts`, `web/src/screens/Receipt.tsx` (modify) | Print the mode |
| `web/src/closeRules.ts` (create) | Pure: parse counted cash, difference, latest close per date, date formatting |
| `web/src/dayClose.ts` (create) | API: summary, close, reopen, recent closes, unclosed days, change event |
| `web/src/screens/CloseDay.tsx` (create) | The Close day screen |
| `web/src/routes.ts`, `web/src/App.tsx` (modify) | `/close` for admin and biller |
| `web/src/components/UnclosedBanner.tsx` (create), `web/src/components/Shell.tsx` (modify) | The banner |
| `web/src/history.ts`, `web/src/screens/Dashboards.tsx` (modify) | Payment split on the Collected card |
| `web/src/i18n/{en,hi,mr}.json` (modify) | New keys |
| `README.md` (modify) | Coverage notes |

---

### Task 1: Payments table and `complete_bill` with a required mode

**Files:**
- Create: `supabase/migrations/0021_payments_and_day_close.sql`
- Create: `tests/payments.test.mjs`
- Modify: `tests/run.mjs` (add import)
- Modify: `tests/complete_bill.test.mjs`, `tests/redemption.test.mjs`, `tests/void_bill.test.mjs`, `tests/clear_vendor_data.test.mjs`, `tests/amend_pending_bill.test.mjs`, `tests/cost_snapshot.test.mjs`, `tests/platform_owner.test.mjs`, `tests/void_analytics.test.mjs`, `tests/item_units_functions.test.mjs`

**Interfaces:**
- Consumes: `current_vendor_id()`, `current_user_role()` (0002/0019), the 0016 body of `complete_bill`.
- Produces:
  - table `bill_payments(id, vendor_id, bill_id unique, mode, amount, created_by, created_at)`
  - `complete_bill(p_bill_id uuid, p_biller_id uuid default null, p_redeem_points integer default 0, p_payment_mode text default null) returns void` — null/unknown mode raises `'a payment mode is required'` (22023)
  - `payment_split_between(p_from timestamptz, p_to timestamptz) returns table (mode text, total numeric, bill_count bigint)` — `mode` is one of the four or `'unrecorded'`, ordered by mode

- [ ] **Step 1: Write the failing tests**

Create `tests/payments.test.mjs`:

```js
import { test, assert, assertDenied, assertEqual, assertInvisible, once } from "./framework.mjs";
import { sql } from "./fixtures.mjs";
import { seedTwoVendors } from "./seed.mjs";

const getWorld = once(seedTwoVendors);

// A bill in `billed` status (token issued), for vendor v's seeded item. qty x price is
// the payable total when nothing is redeemed.
async function billedBill(v, { qty = 5, price = 40 } = {}) {
  const { rows: [b] } = await sql(
    `insert into bills (vendor_id, customer_id, recorder_id, total, status)
     values ($1,$2,$3,0,'recording') returning id`, [v.vendorId, v.customerId, v.recorderId]);
  await sql(`insert into bill_items (bill_id, vendor_id, item_id, qty_kg, unit_price, line_total)
             values ($1,$2,$3,$4,$5,$6)`, [b.id, v.vendorId, v.itemId, qty, price, qty * price]);
  await sql(`select issue_token($1)`, [b.id]);
  return b.id;
}
const payments = async (billId) => (await sql(
  `select mode, amount, created_by from bill_payments where bill_id = $1`, [billId])).rows;
const status = async (billId) => (await sql(`select status from bills where id = $1`, [billId])).rows[0].status;

test("completing with a mode writes one payment row for the amount collected", async () => {
  const w = await getWorld();
  const id = await billedBill(w.a);   // 5 x 40 = 200
  const { error } = await w.a.clients.biller.rpc("complete_bill", { p_bill_id: id, p_payment_mode: "upi" });
  assert(!error, `refused: ${error?.message}`);
  const rows = await payments(id);
  assertEqual(rows.length, 1, "one payment row");
  assertEqual(rows[0].mode, "upi", "mode");
  assertEqual(Number(rows[0].amount), 200, "amount");
  assertEqual(rows[0].created_by, w.a.billerId, "created_by is the caller");
});

test("a missing mode is refused and nothing moves", async () => {
  const w = await getWorld();
  const id = await billedBill(w.a);
  const { error } = await w.a.clients.biller.rpc("complete_bill", { p_bill_id: id });
  assert(error && /payment mode is required/.test(error.message), `expected a refusal, got ${error?.message ?? "success"}`);
  assertEqual(await status(id), "billed", "bill must stay pending");
  assertEqual((await payments(id)).length, 0, "no payment row");
});

test("an unknown mode is refused", async () => {
  const w = await getWorld();
  const id = await billedBill(w.a);
  const { error } = await w.a.clients.biller.rpc("complete_bill", { p_bill_id: id, p_payment_mode: "cheque" });
  assert(error && /payment mode is required/.test(error.message), `expected a refusal, got ${error?.message ?? "success"}`);
  assertEqual(await status(id), "billed", "bill must stay pending");
});

test("the amount is what was collected after points, including zero", async () => {
  const w = await getWorld();
  await sql(`insert into points_ledger (vendor_id, customer_id, points, expires_at)
             values ($1,$2,500, now() + interval '30 days')`, [w.a.vendorId, w.a.customerId]);
  const partly = await billedBill(w.a);            // 200, redeem 50
  await sql(`select complete_bill($1, null, 50, 'cash')`, [partly]);
  assertEqual(Number((await payments(partly))[0].amount), 150, "200 - 50 points");
  const wholly = await billedBill(w.a, { qty: 1 }); // 40, redeem 40
  await sql(`select complete_bill($1, null, 40, 'cash')`, [wholly]);
  const rows = await payments(wholly);
  assertEqual(rows.length, 1, "a fully-redeemed bill still records its mode");
  assertEqual(Number(rows[0].amount), 0, "amount 0");
});

test("a retried completion writes no second payment row", async () => {
  const w = await getWorld();
  const id = await billedBill(w.a);
  await sql(`select complete_bill($1, p_payment_mode => 'cash')`, [id]);
  await sql(`select complete_bill($1, p_payment_mode => 'upi')`, [id]);
  const rows = await payments(id);
  assertEqual(rows.length, 1, "still one row");
  assertEqual(rows[0].mode, "cash", "the first completion's mode stands");
});

test("nobody may write a payment directly", async () => {
  const w = await getWorld();
  const id = await billedBill(w.a);
  for (const role of ["admin", "biller", "recorder"]) {
    const { error } = await w.a.clients[role].from("bill_payments").insert({
      vendor_id: w.a.vendorId, bill_id: id, mode: "cash", amount: 1,
    });
    assertDenied(error, `${role} inserted a payment`);
  }
});

test("payments are invisible across vendors", async () => {
  const w = await getWorld();
  const id = await billedBill(w.b);
  await sql(`select complete_bill($1, p_payment_mode => 'cash')`, [id]);
  const { data } = await w.a.clients.admin.from("bill_payments").select("*").eq("bill_id", id);
  assertInvisible(data, "A saw B's payment");
});

test("a voided bill keeps its payment row", async () => {
  const w = await getWorld();
  const id = await billedBill(w.a);
  await sql(`select complete_bill($1, p_payment_mode => 'cash')`, [id]);
  const { error } = await w.a.clients.biller.rpc("void_bill", { p_bill_id: id, p_reason: "wrong customer" });
  assert(!error, error?.message);
  assertEqual((await payments(id)).length, 1, "payment row kept");
});

test("payment_split_between groups by mode, skips voided bills and reports unrecorded", async () => {
  // Its own world: the split sums the whole shop's window.
  const w = await seedTwoVendors();
  const done = async (mode, qty) => {
    const id = await billedBill(w.a, { qty });
    await sql(`select complete_bill($1, p_payment_mode => $2)`, [id, mode]);
    return id;
  };
  await done("cash", 5);                       // 200
  await done("cash", 1);                       // 40
  await done("upi", 2);                        // 80
  const voided = await done("cash", 3);        // 120, voided below
  await w.a.clients.biller.rpc("void_bill", { p_bill_id: voided, p_reason: "test" });
  const old = await done("card", 4);           // 160, then its payment removed: a pre-0021 bill
  await sql(`delete from bill_payments where bill_id = $1`, [old]);

  const { data, error } = await w.a.clients.admin.rpc("payment_split_between", {
    p_from: new Date(Date.now() - 3600e3).toISOString(),
    p_to: new Date(Date.now() + 3600e3).toISOString(),
  });
  assert(!error, error?.message);
  assertEqual(
    data.map((r) => [r.mode, Number(r.total), Number(r.bill_count)]),
    [["cash", 240, 2], ["unrecorded", 160, 1], ["upi", 80, 1]],
    "split",
  );
  const { data: other } = await w.b.clients.admin.rpc("payment_split_between", {
    p_from: new Date(Date.now() - 3600e3).toISOString(),
    p_to: new Date(Date.now() + 3600e3).toISOString(),
  });
  assertEqual(other, [], "B sees none of A's split");
});
```

In `tests/run.mjs`, add after `import "./create_item_with_cost.test.mjs";`:

```js
import "./payments.test.mjs";
```

- [ ] **Step 2: Run the suite to verify the new tests fail**

Run: `npm test`
Expected: the `payments.test.mjs` cases FAIL (e.g. `relation "bill_payments" does not exist`, `function payment_split_between ... does not exist`). Everything else passes.

- [ ] **Step 3: Write the migration's first section**

Create `supabase/migrations/0021_payments_and_day_close.sql`:

```sql
-- Payment mode and day close.
-- Spec: docs/superpowers/specs/2026-09-23-payments-and-day-close-design.md

-- ---------------------------------------------------------------------------
-- Payments
-- ---------------------------------------------------------------------------

create table bill_payments (
  id         uuid primary key default gen_random_uuid(),
  vendor_id  uuid not null references vendors(id) on delete cascade,
  -- Cascade: a payment means nothing without its bill, and clear_vendor_data deletes bills.
  bill_id    uuid not null references bills(id) on delete cascade,
  mode       text not null check (mode in ('cash', 'upi', 'card', 'credit')),
  amount     numeric(10,2) not null check (amount >= 0),
  -- Nullable: complete_bill still accepts a service-role caller, which has no auth.uid().
  -- No ON DELETE, like bills.biller_id: a staff member with history stays.
  created_by uuid references app_users(id),
  created_at timestamptz not null default now(),
  -- One row per bill for now. Allowing split payments later means dropping this and
  -- nothing else.
  constraint bill_payments_one_per_bill unique (bill_id)
);
create index bill_payments_vendor_idx on bill_payments(vendor_id);

alter table bill_payments enable row level security;

-- Read for every role in the shop. Deliberately NO write policy: the payment and the sale
-- must commit together, so complete_bill() is the only writer. A void keeps the row; every
-- figure already filters on status = 'done', so the payment leaves with its bill.
create policy bill_payments_read on bill_payments for select to authenticated
  using (vendor_id = current_vendor_id());

-- The signature changes, so DROP then CREATE: create or replace would leave the 3-argument
-- version behind as an overload, and an old tab calling it would complete a sale with no
-- payment recorded -- exactly what the required mode exists to stop.
drop function complete_bill(uuid, uuid, integer);

-- Byte-for-byte 0016 except: the payment-mode check, and the bill_payments insert at the end.
create function complete_bill(
  p_bill_id uuid,
  p_biller_id uuid default null,
  p_redeem_points integer default 0,
  -- Defaulted only because Postgres requires every parameter after a defaulted one to have
  -- a default too. A null is refused below.
  p_payment_mode text default null
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

  -- Required, and checked before the idempotency guard so a caller that omits it learns so
  -- even on a retry.
  if p_payment_mode is null or p_payment_mode not in ('cash', 'upi', 'card', 'credit') then
    raise exception 'a payment mode is required (cash, upi, card or credit)' using errcode = '22023';
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
      -- it leaves the balance sum at the same instant as the points it cancelled.
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

  -- Slice D: copy today's cost onto each line. After the idempotency guard above, so a
  -- retry of a done bill returns before reaching here and never restamps. A null
  -- last_cost stays null: an unknown cost is reported as unknown, never as free.
  update bill_items bi
     set unit_cost = i.last_cost
    from items i
   where bi.bill_id = p_bill_id
     and i.id = bi.item_id;

  -- Stock (#3). greatest(...,0) keeps the non-negative check from turning an
  -- over-sold line into a hard failure at the counter with a customer waiting.
  update items i
     set stock_kg = greatest(i.stock_kg - agg.qty, 0)
    from (select item_id, sum(qty_kg) as qty
            from bill_items where bill_id = p_bill_id group by item_id) agg
   where i.id = agg.item_id;

  -- Points (#15). Thresholds and rewards are this vendor's config, never constants.
  -- Measured against v_net, the amount actually PAID.
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

  -- What was collected, and how. v_net, not v_gross: points are not money in the drawer.
  insert into bill_payments (vendor_id, bill_id, mode, amount, created_by)
  values (v_bill.vendor_id, p_bill_id, p_payment_mode, v_net, coalesce(auth.uid(), p_biller_id));
end $$;

revoke all on function complete_bill(uuid, uuid, integer, text) from public, anon;
grant execute on function complete_bill(uuid, uuid, integer, text) to authenticated;

-- The dashboard's split. Invoker rights, so RLS on bills and bill_payments scopes it. A done
-- bill with no payment row (completed before 0021) is reported as 'unrecorded' at its
-- total, never guessed into a mode.
create function payment_split_between(p_from timestamptz, p_to timestamptz)
  returns table (mode text, total numeric, bill_count bigint)
  language sql stable as $$
  select coalesce(p.mode, 'unrecorded')          as mode,
         coalesce(sum(coalesce(p.amount, b.total)), 0) as total,
         count(*)                                as bill_count
    from bills b
    left join bill_payments p on p.bill_id = b.id
   where b.status = 'done'
     and b.completed_at >= p_from
     and b.completed_at <  p_to
   group by 1
   order by 1;
$$;

revoke all on function payment_split_between(timestamptz, timestamptz) from public, anon;
grant execute on function payment_split_between(timestamptz, timestamptz) to authenticated, service_role;
```

- [ ] **Step 4: Pass a mode at every existing `complete_bill` call in the suite**

Every existing test now fails with "a payment mode is required". Update the callers mechanically (Git Bash, repo root):

```bash
sed -i "s/complete_bill(\$1)\`/complete_bill(\$1, p_payment_mode => 'cash')\`/g" tests/*.test.mjs
sed -i "s/complete_bill(\$1, null, \$2)/complete_bill(\$1, null, \$2, 'cash')/g; s/complete_bill(\$1, null, 0)/complete_bill(\$1, null, 0, 'cash')/g" tests/*.test.mjs
```

Then edit the four `rpc("complete_bill", {...})` calls by hand, adding `p_payment_mode: "cash"` to each argument object:
- `tests/complete_bill.test.mjs:143` and `:153` (cross-vendor and recorder refusals — they must still be refused for the reason they test, not for a missing mode)
- `tests/platform_owner.test.mjs:81`
- `tests/redemption.test.mjs:272`

Verify nothing was missed — this must print nothing:

```bash
grep -n "complete_bill(" tests/*.test.mjs | grep -v "payment_mode\|'cash')" 
grep -n 'rpc("complete_bill"' tests/*.test.mjs | grep -v "p_payment_mode"
```

(The first grep also matches `test("complete_bill ...` titles only if they contain `complete_bill(`; they do not.)

- [ ] **Step 5: Run the full suite**

Run: `npm test`
Expected: all cases PASS, including the 9 new ones in `payments.test.mjs`. Exit 0.

- [ ] **Step 6: Commit**

```bash
git add supabase/migrations/0021_payments_and_day_close.sql tests/
git commit -m "feat(db): record a payment mode on every completed bill

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: `day_closes`, `close_day`, `reopen_day`, and the lock

**Files:**
- Modify: `supabase/migrations/0021_payments_and_day_close.sql` (append a section; edit one statement in `complete_bill`)
- Create: `tests/day_close.test.mjs`
- Modify: `tests/run.mjs`

**Interfaces:**
- Consumes: `bill_payments`, `complete_bill` from Task 1; `void_bill` body from 0017.
- Produces:
  - table `day_closes(id, vendor_id, business_date, expected_cash, counted_cash, difference, note, closed_by, closed_at, reopened_by, reopened_at, reopen_reason)`, FK names `day_closes_closed_by_fkey`, `day_closes_reopened_by_fkey`
  - `expected_cash_for(p_vendor uuid, p_date date) returns numeric` (internal, no client grant)
  - `close_day(p_date date, p_counted_cash numeric, p_note text default null) returns day_closes` — raises `'day already closed'` (P0001), `42501` for recorder
  - `reopen_day(p_date date, p_reason text) returns day_closes` — admin only; raises `'day is not closed'` (P0001)
  - `complete_bill` and `void_bill` raise `'day is closed'` (P0001) while the relevant date has an active close

- [ ] **Step 1: Write the failing tests**

Create `tests/day_close.test.mjs`:

```js
import pg from "pg";
import { test, assert, assertDenied, assertEqual, assertInvisible } from "./framework.mjs";
import { sql, DB_URL } from "./fixtures.mjs";
import { seedTwoVendors } from "./seed.mjs";

// Every case builds its OWN world: closing today locks that shop for the rest of the file.

async function billedBill(v, { qty = 5, price = 40 } = {}) {
  const { rows: [b] } = await sql(
    `insert into bills (vendor_id, customer_id, recorder_id, total, status)
     values ($1,$2,$3,0,'recording') returning id`, [v.vendorId, v.customerId, v.recorderId]);
  await sql(`insert into bill_items (bill_id, vendor_id, item_id, qty_kg, unit_price, line_total)
             values ($1,$2,$3,$4,$5,$6)`, [b.id, v.vendorId, v.itemId, qty, price, qty * price]);
  await sql(`select issue_token($1)`, [b.id]);
  return b.id;
}
async function doneBill(v, mode, opts = {}) {
  const id = await billedBill(v, opts);
  await sql(`select complete_bill($1, p_payment_mode => $2)`, [id, mode]);
  return id;
}
// Moves a done bill N whole days back. Whole days keep the time of day, so its Kolkata
// date moves by exactly N.
const backdate = (id, days) =>
  sql(`update bills set completed_at = completed_at - ($2 || ' days')::interval where id = $1`, [id, String(days)]);
const kolkataDay = async (offset = 0) => (await sql(
  `select ((now() at time zone 'Asia/Kolkata')::date + $1::int)::text d`, [offset])).rows[0].d;
const closeAs = (client, date, counted, note = null) =>
  client.rpc("close_day", { p_date: date, p_counted_cash: counted, p_note: note });

test("a biller closes today: expected cash is cash payments only", async () => {
  const w = await seedTwoVendors();
  await doneBill(w.a, "cash", { qty: 5 });     // 200
  await doneBill(w.a, "upi", { qty: 2 });      // 80
  await doneBill(w.a, "card", { qty: 1 });     // 40
  await doneBill(w.a, "credit", { qty: 1 });   // 40
  const voided = await doneBill(w.a, "cash", { qty: 3 });
  await w.a.clients.biller.rpc("void_bill", { p_bill_id: voided, p_reason: "test" });
  const old = await doneBill(w.a, "cash", { qty: 1 });
  await sql(`delete from bill_payments where bill_id = $1`, [old]);   // a pre-0021 bill

  const { data, error } = await closeAs(w.a.clients.biller, await kolkataDay(), 200);
  assert(!error, `refused: ${error?.message}`);
  assertEqual(Number(data.expected_cash), 200, "expected");
  assertEqual(Number(data.counted_cash), 200, "counted");
  assertEqual(Number(data.difference), 0, "difference");
  assertEqual(data.closed_by, w.a.billerId, "closed_by");
});

test("an admin may close; a recorder may not", async () => {
  const w = await seedTwoVendors();
  const { error: rec } = await closeAs(w.a.clients.recorder, await kolkataDay(), 0);
  assertDenied(rec, "recorder closed the day");
  const { error: adm } = await closeAs(w.a.clients.admin, await kolkataDay(), 0);
  assert(!adm, adm?.message);
});

test("a non-zero difference needs a note", async () => {
  const w = await seedTwoVendors();
  await doneBill(w.a, "cash");                  // 200
  const today = await kolkataDay();
  const { error } = await closeAs(w.a.clients.biller, today, 190);
  assert(error && /note is required/.test(error.message), `expected note refusal, got ${error?.message ?? "success"}`);
  const { error: blank } = await closeAs(w.a.clients.biller, today, 190, "   ");
  assert(blank, "a blank note must not count");
  const { data, error: ok } = await closeAs(w.a.clients.biller, today, 190, "gave 10 change twice");
  assert(!ok, ok?.message);
  assertEqual(Number(data.difference), -10, "difference");
  assertEqual(data.note, "gave 10 change twice", "note");
});

test("closing twice, a future date, and bad amounts are refused", async () => {
  const w = await seedTwoVendors();
  const today = await kolkataDay();
  const { error: neg } = await closeAs(w.a.clients.biller, today, -1);
  assert(neg, "negative counted cash accepted");
  const { error: fine } = await closeAs(w.a.clients.biller, today, 10.555, "x");
  assert(fine, "sub-paisa counted cash accepted");
  const { error: future } = await closeAs(w.a.clients.biller, await kolkataDay(1), 0);
  assert(future, "future date accepted");
  const { error: first } = await closeAs(w.a.clients.biller, today, 0);
  assert(!first, first?.message);
  const { error: again } = await closeAs(w.a.clients.admin, today, 0);
  assert(again && /day already closed/.test(again.message), `expected already closed, got ${again?.message ?? "success"}`);
});

test("while today is closed: complete and void refuse, a retry of a done bill and issue_token do not", async () => {
  const w = await seedTwoVendors();
  const done = await doneBill(w.a, "cash");
  const pending = await billedBill(w.a);
  const { error: c } = await closeAs(w.a.clients.biller, await kolkataDay(), 200);
  assert(!c, c?.message);

  const { error: comp } = await w.a.clients.biller.rpc("complete_bill", { p_bill_id: pending, p_payment_mode: "cash" });
  assert(comp && /day is closed/.test(comp.message), `complete: ${comp?.message ?? "success"}`);
  const { error: v } = await w.a.clients.biller.rpc("void_bill", { p_bill_id: done, p_reason: "late" });
  assert(v && /day is closed/.test(v.message), `void: ${v?.message ?? "success"}`);

  // A retry whose first attempt already committed is still success: the idempotency guard
  // returns before the lock is checked.
  const { error: retry } = await w.a.clients.biller.rpc("complete_bill", { p_bill_id: done, p_payment_mode: "cash" });
  assert(!retry, `retry of a done bill refused: ${retry?.message}`);

  const later = await billedBill(w.a);   // issue_token inside
  const { rows: [b] } = await sql(`select status from bills where id = $1`, [later]);
  assertEqual(b.status, "billed", "a token can still be issued; it carries over");
});

test("reopen: admin only, reason required, history kept, re-close recomputes", async () => {
  const w = await seedTwoVendors();
  const today = await kolkataDay();
  await doneBill(w.a, "cash");                  // 200
  await closeAs(w.a.clients.biller, today, 200);

  const { error: bil } = await w.a.clients.biller.rpc("reopen_day", { p_date: today, p_reason: "late sale" });
  assertDenied(bil, "biller reopened");
  const { error: blank } = await w.a.clients.admin.rpc("reopen_day", { p_date: today, p_reason: "  " });
  assert(blank, "blank reason accepted");
  const { data: re, error } = await w.a.clients.admin.rpc("reopen_day", { p_date: today, p_reason: "late sale" });
  assert(!error, error?.message);
  assertEqual(re.reopen_reason, "late sale", "reason stored");
  assertEqual(re.reopened_by, w.a.adminId, "reopened_by");

  await doneBill(w.a, "cash", { qty: 1 });      // 40, allowed again
  const { data: second, error: e2 } = await closeAs(w.a.clients.biller, today, 240);
  assert(!e2, e2?.message);
  assertEqual(Number(second.expected_cash), 240, "recomputed");
  const { rows } = await sql(
    `select count(*)::int n, count(*) filter (where reopened_at is not null)::int reopened
       from day_closes where vendor_id = $1 and business_date = $2::date`, [w.a.vendorId, today]);
  assertEqual(rows[0], { n: 2, reopened: 1 }, "both closes kept");
});

test("reopening a day that is not closed is refused", async () => {
  const w = await seedTwoVendors();
  const { error } = await w.a.clients.admin.rpc("reopen_day", { p_date: await kolkataDay(), p_reason: "x" });
  assert(error && /day is not closed/.test(error.message), `got ${error?.message ?? "success"}`);
});

test("a past day's close locks voids of that day's bills only", async () => {
  const w = await seedTwoVendors();
  const past = await doneBill(w.a, "cash");
  await backdate(past, 2);
  const { error } = await closeAs(w.a.clients.biller, await kolkataDay(-2), 200);
  assert(!error, error?.message);
  // Today is untouched by closing two days ago.
  const todays = await billedBill(w.a);
  const { error: comp } = await w.a.clients.biller.rpc("complete_bill", { p_bill_id: todays, p_payment_mode: "upi" });
  assert(!comp, `today was locked by a past close: ${comp?.message}`);
});

test("day_closes are invisible across vendors and unwritable directly", async () => {
  const w = await seedTwoVendors();
  const today = await kolkataDay();
  await closeAs(w.a.clients.biller, today, 0);
  const { data } = await w.b.clients.admin.from("day_closes").select("*").eq("vendor_id", w.a.vendorId);
  assertInvisible(data, "B saw A's close");
  const { error } = await w.a.clients.admin.from("day_closes").insert({
    vendor_id: w.a.vendorId, business_date: await kolkataDay(-1), expected_cash: 0, counted_cash: 0,
    difference: 0, closed_by: w.a.adminId,
  });
  assertDenied(error, "admin inserted a close directly");
  await w.a.clients.admin.from("day_closes").update({ counted_cash: 999 }).eq("vendor_id", w.a.vendorId);
  const { rows } = await sql(`select counted_cash from day_closes where vendor_id = $1`, [w.a.vendorId]);
  assertEqual(Number(rows[0].counted_cash), 0, "a direct update changed the close");
});

test("a completion waiting on a close in progress is refused once the close commits", async () => {
  const w = await seedTwoVendors();
  const id = await billedBill(w.a);
  const today = await kolkataDay();
  const closer = new pg.Client({ connectionString: DB_URL });
  const completer = new pg.Client({ connectionString: DB_URL });
  await closer.connect();
  await completer.connect();
  try {
    await closer.query("begin");
    await closer.query("set local role authenticated");
    await closer.query(`select set_config('request.jwt.claims', $1, true)`,
      [JSON.stringify({ sub: w.a.billerId, role: "authenticated" })]);
    await closer.query(`select close_day($1::date, 0, null)`, [today]);
    // The close holds the vendor row until commit, so this completion must wait on it.
    const outcome = completer.query(`select complete_bill($1, p_payment_mode => 'cash')`, [id])
      .then(() => null, (e) => e);
    await new Promise((r) => setTimeout(r, 300));
    await closer.query("commit");
    const err = await outcome;
    assert(err && /day is closed/.test(err.message),
      `the completion slipped in after the count: ${err?.message ?? "success"}`);
  } finally {
    await closer.end();
    await completer.end();
  }
});
```

In `tests/run.mjs`, add after `import "./payments.test.mjs";`:

```js
import "./day_close.test.mjs";
```

- [ ] **Step 2: Run the suite to verify the new tests fail**

Run: `npm test`
Expected: `day_close.test.mjs` cases FAIL with `function close_day(...) does not exist` / `relation "day_closes" does not exist`. All others pass.

- [ ] **Step 3: Add the vendor lock and the day check to `complete_bill`**

In `0021_payments_and_day_close.sql`, inside `complete_bill`, replace:

```sql
  select * into v_vendor from vendors where id = v_bill.vendor_id;
```

with:

```sql
  -- FOR SHARE: close_day() takes this row FOR UPDATE before it counts the cash, so a
  -- completion either commits before the count or waits for the close and is refused
  -- below. Share locks do not block each other, so two tills still complete in parallel.
  select * into v_vendor from vendors where id = v_bill.vendor_id for share;

  -- After the idempotency guard: a retry of a sale that already committed must still
  -- succeed after the day is closed, or the biller is told a completed sale failed.
  if exists (select 1 from day_closes
              where vendor_id = v_bill.vendor_id
                and business_date = (now() at time zone 'Asia/Kolkata')::date
                and reopened_at is null) then
    raise exception 'day is closed' using errcode = 'P0001';
  end if;
```

- [ ] **Step 4: Append the day-close section to the migration**

Append to `0021_payments_and_day_close.sql`:

```sql
-- ---------------------------------------------------------------------------
-- Day close
-- ---------------------------------------------------------------------------

create table day_closes (
  id            uuid primary key default gen_random_uuid(),
  vendor_id     uuid not null references vendors(id) on delete cascade,
  -- The Asia/Kolkata calendar date, the same day boundary void_bill uses.
  business_date date not null,
  expected_cash numeric(10,2) not null,
  counted_cash  numeric(10,2) not null check (counted_cash >= 0),
  difference    numeric(10,2) not null,
  note          text,
  closed_by     uuid not null references app_users(id),
  closed_at     timestamptz not null default now(),
  reopened_by   uuid references app_users(id),
  reopened_at   timestamptz,
  reopen_reason text,
  constraint day_closes_reopen_stamps check (
    (reopened_at is null and reopened_by is null and reopen_reason is null)
    or (reopened_at is not null and reopened_by is not null
        and length(btrim(coalesce(reopen_reason, ''))) > 0)
  )
);

-- At most one ACTIVE close per shop per day. A reopen stamps the row instead of deleting it,
-- so every close and reopen stays on record.
create unique index day_closes_one_active on day_closes(vendor_id, business_date)
  where reopened_at is null;

alter table day_closes enable row level security;

-- Read for every role in the shop. No write policy: close_day/reopen_day are the only writers.
create policy day_closes_read on day_closes for select to authenticated
  using (vendor_id = current_vendor_id());

-- Cash the drawer should hold for one shop's day. Internal: called only from close_day,
-- which runs as the owner, so no client needs execute.
create function expected_cash_for(p_vendor uuid, p_date date) returns numeric
  language sql stable as $$
  select coalesce(sum(p.amount), 0)
    from bill_payments p
    join bills b on b.id = p.bill_id
   where b.vendor_id = p_vendor
     and b.status = 'done'
     and p.mode = 'cash'
     and (b.completed_at at time zone 'Asia/Kolkata')::date = p_date;
$$;

revoke all on function expected_cash_for(uuid, date) from public, anon, authenticated;

create function close_day(p_date date, p_counted_cash numeric, p_note text default null)
  returns day_closes
  language plpgsql security definer set search_path = public as $$
declare
  v_vendor   uuid := current_vendor_id();
  v_expected numeric;
  v_row      day_closes%rowtype;
begin
  -- A signed-in admin or biller only: closed_by must be a real staff member.
  if v_vendor is null or current_user_role() not in ('admin', 'biller') then
    raise exception 'only an admin or biller may close the day' using errcode = '42501';
  end if;
  if p_date is null or p_date > (now() at time zone 'Asia/Kolkata')::date then
    raise exception 'cannot close a future day' using errcode = '22023';
  end if;
  if p_counted_cash is null or p_counted_cash < 0 or p_counted_cash <> round(p_counted_cash, 2) then
    raise exception 'counted cash must be zero or more, to the paisa' using errcode = '22023';
  end if;

  -- Serialises against complete_bill/void_bill (FOR SHARE on the same row) and against a
  -- second close of the same day, so the cash is counted over a settled set of bills.
  perform 1 from vendors where id = v_vendor for update;

  if exists (select 1 from day_closes
              where vendor_id = v_vendor and business_date = p_date and reopened_at is null) then
    raise exception 'day already closed' using errcode = 'P0001';
  end if;

  -- Computed here, never taken from the client.
  v_expected := expected_cash_for(v_vendor, p_date);

  if p_counted_cash <> v_expected and length(btrim(coalesce(p_note, ''))) = 0 then
    raise exception 'a note is required when the cash does not match' using errcode = '22023';
  end if;

  insert into day_closes (vendor_id, business_date, expected_cash, counted_cash, difference,
                          note, closed_by)
  values (v_vendor, p_date, v_expected, p_counted_cash, p_counted_cash - v_expected,
          nullif(btrim(coalesce(p_note, '')), ''), auth.uid())
  returning * into v_row;
  return v_row;
end $$;

revoke all on function close_day(date, numeric, text) from public, anon;
grant execute on function close_day(date, numeric, text) to authenticated;

create function reopen_day(p_date date, p_reason text) returns day_closes
  language plpgsql security definer set search_path = public as $$
declare
  v_row day_closes%rowtype;
begin
  if current_vendor_id() is null or current_user_role() <> 'admin' then
    raise exception 'only an admin may reopen a day' using errcode = '42501';
  end if;
  if p_reason is null or length(btrim(p_reason)) = 0 then
    raise exception 'a reason is required' using errcode = '22023';
  end if;

  update day_closes
     set reopened_at = now(), reopened_by = auth.uid(), reopen_reason = btrim(p_reason)
   where vendor_id = current_vendor_id() and business_date = p_date and reopened_at is null
  returning * into v_row;
  if not found then
    raise exception 'day is not closed' using errcode = 'P0001';
  end if;
  return v_row;
end $$;

revoke all on function reopen_day(date, text) from public, anon;
grant execute on function reopen_day(date, text) to authenticated;

-- void_bill: byte-for-byte 0017 except the vendor lock and the day check. Same signature,
-- so create or replace is correct and creates no overload.
create or replace function void_bill(p_bill_id uuid, p_reason text) returns void
  language plpgsql security definer set search_path = public as $$
declare
  v_bill      bills%rowtype;
  v_reversed  integer := 0;
  v_refunded  integer := 0;
begin
  -- Only a signed-in admin or biller of the bill's own shop. A null vendor (service role)
  -- is refused: voided_by must be a real staff member.
  if current_vendor_id() is null or current_user_role() not in ('admin', 'biller') then
    raise exception 'only an admin or biller may void a bill' using errcode = '42501';
  end if;

  select * into v_bill from bills where id = p_bill_id and vendor_id = current_vendor_id() for update;
  if not found then
    raise exception 'bill % is not in your shop', p_bill_id using errcode = '42501';
  end if;

  -- Idempotent: a double tap or a retried request must not restore stock twice.
  if v_bill.status = 'voided' then
    return;
  end if;
  if v_bill.status <> 'done' then
    raise exception 'bill is not done' using errcode = 'P0001';
  end if;

  -- Same calendar day as completion, in the shops' timezone.
  if (v_bill.completed_at at time zone 'Asia/Kolkata')::date
     <> (now() at time zone 'Asia/Kolkata')::date then
    raise exception 'void window closed' using errcode = 'P0001';
  end if;

  -- The same lock complete_bill takes, for the same reason: a void either lands before
  -- close_day counts the cash or is refused.
  perform 1 from vendors where id = v_bill.vendor_id for share;
  if exists (select 1 from day_closes
              where vendor_id = v_bill.vendor_id
                and business_date = (v_bill.completed_at at time zone 'Asia/Kolkata')::date
                and reopened_at is null) then
    raise exception 'day is closed' using errcode = 'P0001';
  end if;

  if p_reason is null or length(btrim(p_reason)) = 0 then
    raise exception 'a reason is required' using errcode = '22023';
  end if;

  -- Stock back. Not capped: stock has no upper bound.
  update items i
     set stock_kg = i.stock_kg + agg.qty
    from (select item_id, sum(qty_kg) as qty from bill_items where bill_id = p_bill_id group by item_id) agg
   where i.id = agg.item_id;

  -- Points: mirror every ledger row of this bill with the opposite sign and the SAME
  -- expires_at, so each reversal lapses with the batch it cancels.
  select coalesce(sum(points) filter (where points > 0), 0),
         coalesce(-sum(points) filter (where points < 0), 0)
    into v_reversed, v_refunded
    from points_ledger where bill_id = p_bill_id;

  insert into points_ledger (vendor_id, customer_id, bill_id, points, expires_at)
  select vendor_id, customer_id, bill_id, -points, expires_at
    from points_ledger
   where bill_id = p_bill_id;

  if v_bill.customer_id is not null then
    insert into outbound_messages (vendor_id, customer_id, template_key, payload)
    values (v_bill.vendor_id, v_bill.customer_id, 'bill_voided',
            jsonb_build_object('bill_id', p_bill_id, 'token_no', v_bill.token_no,
                               'total', v_bill.total,
                               'points_reversed', coalesce(v_reversed, 0),
                               'points_refunded', coalesce(v_refunded, 0)));
  end if;

  update bills
     set status = 'voided', voided_at = now(), voided_by = auth.uid(), void_reason = btrim(p_reason)
   where id = p_bill_id;
end $$;
```

(`void_bill`'s grants survive `create or replace`; do not repeat them.)

- [ ] **Step 5: Run the full suite**

Run: `npm test`
Expected: all PASS, including the 10 new `day_close.test.mjs` cases and every existing `void_bill` case. Exit 0.

- [ ] **Step 6: Commit**

```bash
git add supabase/migrations/0021_payments_and_day_close.sql tests/day_close.test.mjs tests/run.mjs
git commit -m "feat(db): close and reopen a day; lock completions and voids on a closed day

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: `day_summary`, `unclosed_days`, `day_close_from`, and clearing data

**Files:**
- Modify: `supabase/migrations/0021_payments_and_day_close.sql` (append)
- Modify: `tests/day_close.test.mjs` (append)

**Interfaces:**
- Consumes: `day_closes`, `bill_payments`; `clear_vendor_data` body from 0016.
- Produces:
  - `vendors.day_close_from date not null` (defaults to today, Asia/Kolkata)
  - `day_summary(p_date date default null) returns table (business_date date, cash numeric, cash_count bigint, upi numeric, upi_count bigint, card numeric, card_count bigint, credit numeric, credit_count bigint, unrecorded numeric, unrecorded_count bigint, expected_cash numeric, pending_tokens bigint)` — one row; null date = today
  - `unclosed_days() returns table (business_date date)` — newest first
  - `clear_vendor_data()` also deletes the shop's `bill_payments` and `day_closes`

- [ ] **Step 1: Write the failing tests**

Append to `tests/day_close.test.mjs`:

```js
// node-pg parses a date column into a local-midnight Date. Format with LOCAL getters so
// the calendar date survives whatever zone this machine is in. (PostgREST sends a string.)
const ymdOf = (v) => {
  if (typeof v === "string") return v.slice(0, 10);
  const p = (n) => String(n).padStart(2, "0");
  return `${v.getFullYear()}-${p(v.getMonth() + 1)}-${p(v.getDate())}`;
};
const setCloseFrom = (w, offset) => sql(
  `update vendors set day_close_from = (now() at time zone 'Asia/Kolkata')::date + $2::int where id = $1`,
  [w.a.vendorId, offset]);

test("day_summary reports each mode, unrecorded bills and pending tokens, for this shop only", async () => {
  const w = await seedTwoVendors();
  await doneBill(w.a, "cash", { qty: 5 });     // 200
  await doneBill(w.a, "upi", { qty: 2 });      // 80
  await doneBill(w.a, "credit", { qty: 1 });   // 40
  const old = await doneBill(w.a, "card", { qty: 1 });
  await sql(`delete from bill_payments where bill_id = $1`, [old]);   // unrecorded, 40
  const voided = await doneBill(w.a, "cash", { qty: 3 });
  await w.a.clients.biller.rpc("void_bill", { p_bill_id: voided, p_reason: "test" });
  await billedBill(w.a);                       // pending

  const { data, error } = await w.a.clients.biller.rpc("day_summary", {});
  assert(!error, error?.message);
  const r = data[0];
  assertEqual(ymdOf(r.business_date), await kolkataDay(), "defaults to today");
  assertEqual(
    [r.cash, r.cash_count, r.upi, r.upi_count, r.card, r.card_count, r.credit, r.credit_count,
     r.unrecorded, r.unrecorded_count, r.expected_cash, r.pending_tokens].map(Number),
    [200, 1, 80, 1, 0, 0, 40, 1, 40, 1, 200, 1],
    "summary",
  );
  const { data: b } = await w.b.clients.admin.rpc("day_summary", {});
  assertEqual(Number(b[0].cash) + Number(b[0].pending_tokens), 0, "B sees none of A");
});

test("day_summary for a past date", async () => {
  const w = await seedTwoVendors();
  const id = await doneBill(w.a, "cash");
  await backdate(id, 1);
  const { data } = await w.a.clients.admin.rpc("day_summary", { p_date: await kolkataDay(-1) });
  assertEqual(Number(data[0].cash), 200, "yesterday's cash");
  const { data: today } = await w.a.clients.admin.rpc("day_summary", {});
  assertEqual(Number(today[0].cash), 0, "not today's");
});

test("unclosed_days lists a past day with sales until it is closed", async () => {
  const w = await seedTwoVendors();
  await setCloseFrom(w, -10);
  const id = await doneBill(w.a, "cash");
  await backdate(id, 2);
  await doneBill(w.a, "cash");                 // today: never listed
  const twoAgo = await kolkataDay(-2);

  const { data } = await w.a.clients.biller.rpc("unclosed_days");
  assertEqual(data.map((r) => ymdOf(r.business_date)), [twoAgo], "listed");
  const { data: other } = await w.b.clients.admin.rpc("unclosed_days");
  assertEqual(other, [], "B sees none of A's days");

  const { error } = await closeAs(w.a.clients.biller, twoAgo, 200);
  assert(!error, error?.message);
  const { data: after } = await w.a.clients.biller.rpc("unclosed_days");
  assertEqual(after, [], "closed day no longer listed");
});

test("unclosed_days ignores days before day_close_from and days with only voided bills", async () => {
  const w = await seedTwoVendors();
  // A fresh shop's day_close_from is today, exactly as every shop's is on deploy day.
  const before = await doneBill(w.a, "cash");
  await backdate(before, 3);
  const { data } = await w.a.clients.admin.rpc("unclosed_days");
  assertEqual(data, [], "a day before day_close_from must not be listed");

  await setCloseFrom(w, -10);
  await sql(`update bills set status = 'voided', voided_at = completed_at, void_reason = 'x' where id = $1`, [before]);
  const { data: voidedOnly } = await w.a.clients.admin.rpc("unclosed_days");
  assertEqual(voidedOnly, [], "a day with only voided bills needs no close");
});

test("clearing the shop's data removes its payments and closes", async () => {
  const w = await seedTwoVendors();
  await doneBill(w.a, "cash");
  await closeAs(w.a.clients.biller, await kolkataDay(), 200);
  const { error } = await w.a.clients.admin.rpc("clear_vendor_data");
  assert(!error, error?.message);
  const { rows } = await sql(
    `select (select count(*) from bill_payments where vendor_id = $1)::int p,
            (select count(*) from day_closes where vendor_id = $1)::int c`, [w.a.vendorId]);
  assertEqual(rows[0], { p: 0, c: 0 }, "left behind");
  // Today is open again: a new sale completes. Walk-in (no customer): clearing deleted them.
  const id = await billedBill({ ...w.a, customerId: null });
  const { error: comp } = await w.a.clients.biller.rpc("complete_bill", { p_bill_id: id, p_payment_mode: "cash" });
  assert(!comp, `today stayed locked after clearing: ${comp?.message}`);
});
```

- [ ] **Step 2: Run the suite to verify the new tests fail**

Run: `npm test`
Expected: the 5 new cases FAIL (`function day_summary ... does not exist`, `column "day_close_from" ... does not exist`, clear test's leftover close). Others pass.

- [ ] **Step 3: Append the summary section to the migration**

Append to `0021_payments_and_day_close.sql`:

```sql
-- ---------------------------------------------------------------------------
-- What the close screen and the banner read
-- ---------------------------------------------------------------------------

-- The first day a shop is asked to close. now() is stable, so ADD COLUMN evaluates it once:
-- every existing shop gets the migration date, and a new shop gets its creation date.
-- Without it, the day this ships every shop would be told thirty past days are unclosed.
alter table vendors
  add column day_close_from date not null default ((now() at time zone 'Asia/Kolkata')::date);

-- One row for one day: per-mode totals and counts of done bills, the cash the drawer should
-- hold, and the tokens still pending (which carry over). Invoker rights: RLS scopes it.
create function day_summary(p_date date default null)
  returns table (
    business_date    date,
    cash             numeric, cash_count       bigint,
    upi              numeric, upi_count        bigint,
    card             numeric, card_count       bigint,
    credit           numeric, credit_count     bigint,
    unrecorded       numeric, unrecorded_count bigint,
    expected_cash    numeric,
    pending_tokens   bigint
  )
  language sql stable as $$
  with d as (
    select coalesce(p_date, (now() at time zone 'Asia/Kolkata')::date) as day
  ), done as (
    select b.total, p.mode, p.amount
      from bills b
      left join bill_payments p on p.bill_id = b.id
     where b.status = 'done'
       and (b.completed_at at time zone 'Asia/Kolkata')::date = (select day from d)
  )
  select (select day from d),
         coalesce(sum(amount) filter (where mode = 'cash'), 0),   count(*) filter (where mode = 'cash'),
         coalesce(sum(amount) filter (where mode = 'upi'), 0),    count(*) filter (where mode = 'upi'),
         coalesce(sum(amount) filter (where mode = 'card'), 0),   count(*) filter (where mode = 'card'),
         coalesce(sum(amount) filter (where mode = 'credit'), 0), count(*) filter (where mode = 'credit'),
         coalesce(sum(total) filter (where mode is null), 0),     count(*) filter (where mode is null),
         coalesce(sum(amount) filter (where mode = 'cash'), 0),
         (select count(*) from bills where status = 'billed')
    from done;
$$;

revoke all on function day_summary(date) from public, anon;
grant execute on function day_summary(date) to authenticated, service_role;

-- Past days with at least one done bill and no active close, newest first, over the last
-- 30 days and never before the shop's day_close_from. Today is never listed: it is still
-- trading. Invoker rights: RLS on bills, vendors and day_closes scopes it.
create function unclosed_days() returns table (business_date date)
  language sql stable as $$
  select distinct (b.completed_at at time zone 'Asia/Kolkata')::date as business_date
    from bills b
    join vendors v on v.id = b.vendor_id
   where b.status = 'done'
     and b.completed_at >= now() - interval '31 days'
     and (b.completed_at at time zone 'Asia/Kolkata')::date <  (now() at time zone 'Asia/Kolkata')::date
     and (b.completed_at at time zone 'Asia/Kolkata')::date >= (now() at time zone 'Asia/Kolkata')::date - 30
     and (b.completed_at at time zone 'Asia/Kolkata')::date >= v.day_close_from
     and not exists (
       select 1 from day_closes c
        where c.vendor_id = b.vendor_id
          and c.business_date = (b.completed_at at time zone 'Asia/Kolkata')::date
          and c.reopened_at is null)
   order by business_date desc;
$$;

revoke all on function unclosed_days() from public, anon;
grant execute on function unclosed_days() to authenticated, service_role;

-- clear_vendor_data(): byte-for-byte 0016 plus bill_payments and day_closes. A close left
-- behind would keep today locked on a shop with no bills.
create or replace function clear_vendor_data()
  returns table (bills integer, customers integer, points_rows integer)
  language plpgsql security definer set search_path = public as $$
declare
  v_vendor uuid := current_vendor_id();
  v_bills  integer;
  v_custs  integer;
  v_points integer;
begin
  -- Unlike issue_token()/complete_bill(), a null current_vendor_id() is NOT waved through.
  -- This one derives its entire scope FROM the caller, so a null vendor has nothing to mean.
  if v_vendor is null or current_user_role() <> 'admin' then
    raise exception 'only an admin may clear their shop''s data'
      using errcode = '42501';
  end if;

  -- Order is forced by the foreign keys: points_ledger.bill_id -> bills and
  -- bills.customer_id -> customers have NO cascade.
  delete from points_ledger where vendor_id = v_vendor;
  get diagnostics v_points = row_count;

  delete from bill_payments where vendor_id = v_vendor;
  delete from bill_items where vendor_id = v_vendor;
  delete from bills where vendor_id = v_vendor;
  get diagnostics v_bills = row_count;

  -- Records ABOUT the bills and points just deleted.
  delete from day_closes where vendor_id = v_vendor;
  delete from stock_requests where vendor_id = v_vendor;
  delete from stock_movements where vendor_id = v_vendor;
  delete from outbound_messages where vendor_id = v_vendor;

  delete from customers where vendor_id = v_vendor;
  get diagnostics v_custs = row_count;

  -- Tokens restart at 1. Safe only because the bills are gone.
  update vendor_counters set last_token = 0 where vendor_id = v_vendor;

  return query select v_bills, v_custs, v_points;
end $$;
```

(`clear_vendor_data`'s grants survive `create or replace`.)

- [ ] **Step 4: Run the full suite**

Run: `npm test`
Expected: all PASS. If `tests/schema.test.mjs` asserts the exact column list of `vendors`, add `day_close_from` to that list — nothing else in it should change. Exit 0.

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/0021_payments_and_day_close.sql tests/
git commit -m "feat(db): day summary, unclosed days, and clearing payments and closes

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Pick a payment mode when completing a bill

**Files:**
- Create: `web/src/payments.ts`
- Modify: `web/src/data.ts:137-149` (`completeBill`)
- Modify: `web/src/screens/Pending.tsx`
- Modify: `web/src/errors.ts`
- Modify: `web/src/i18n/en.json`, `hi.json`, `mr.json`
- Test: `web/src/__tests__/data.test.ts`, `web/src/__tests__/Pending.test.tsx`, `web/src/__tests__/errors.test.ts`

**Interfaces:**
- Consumes: `complete_bill(..., p_payment_mode)` from Task 1; `'day is closed'`, `'day already closed'` messages from Task 2.
- Produces:
  - `web/src/payments.ts`: `export type PaymentMode = "cash" | "upi" | "card" | "credit"; export const PAYMENT_MODES: readonly PaymentMode[]; export type SplitMode = PaymentMode | "unrecorded";`
  - `completeBill(billId: string, mode: PaymentMode, redeemPoints?: number)`
  - i18n keys `pay.cash|upi|card|credit|unrecorded`, `pending.modeLabel`, `pending.confirmCredit`, `close.dayClosed`, `close.alreadyClosed`
  - `describeError` maps `/day is closed/` → `close.dayClosed`, `/day already closed/` → `close.alreadyClosed`

- [ ] **Step 1: Write the failing tests**

In `web/src/__tests__/data.test.ts`, replace the two `completeBill` tests (lines ~105-115) with:

```ts
  it("sends the payment mode and the points", async () => {
    await completeBill("b1", "upi", 40);
    expect(rpc).toHaveBeenCalledWith("complete_bill", {
      p_bill_id: "b1", p_payment_mode: "upi", p_redeem_points: 40,
    });
  });

  it("omits the points entirely when none are redeemed", async () => {
    // The function defaults p_redeem_points to 0; sending an explicit 0 is equivalent but
    // sending undefined is not, so the no-redemption path must not send the key at all.
    await completeBill("b1", "cash");
    expect(rpc).toHaveBeenCalledWith("complete_bill", { p_bill_id: "b1", p_payment_mode: "cash" });
  });
```

In `web/src/__tests__/Pending.test.tsx`:
1. In **every existing test** that clicks the confirm button (`getByRole("button", { name: /complete this bill|yes/i })` or `getByTestId("pending-confirm-b1")`), insert immediately before that click:
   ```ts
   fireEvent.click(screen.getByTestId("pay-mode-cash"));
   ```
2. Change every `expect(completeBill).toHaveBeenCalledWith("b1", N)` to `toHaveBeenCalledWith("b1", "cash", N)`.
3. Add inside `describe("the pending queue", ...)`:

```tsx
  it("keeps Complete disabled until a payment mode is picked, then sends it", async () => {
    render(<MemoryRouter><Pending /></MemoryRouter>);
    fireEvent.click(await screen.findByRole("button", { name: /^complete$/i }));
    const accept = screen.getByTestId("pending-confirm-b1");
    expect(accept).toHaveProperty("disabled", true);
    fireEvent.click(screen.getByTestId("pay-mode-upi"));
    expect(screen.getByTestId("pay-mode-upi").getAttribute("aria-pressed")).toBe("true");
    expect(accept).toHaveProperty("disabled", false);
    fireEvent.click(accept);
    await waitFor(() => expect(completeBill).toHaveBeenCalledWith("b1", "upi", 0));
  });

  it("says 'Complete on credit' when credit is picked", async () => {
    render(<MemoryRouter><Pending /></MemoryRouter>);
    fireEvent.click(await screen.findByRole("button", { name: /^complete$/i }));
    fireEvent.click(screen.getByTestId("pay-mode-credit"));
    expect(screen.getByTestId("pending-confirm-b1").textContent).toMatch(/credit/i);
  });

  it("forgets the mode when the dialog is reopened", async () => {
    render(<MemoryRouter><Pending /></MemoryRouter>);
    fireEvent.click(await screen.findByRole("button", { name: /^complete$/i }));
    fireEvent.click(screen.getByTestId("pay-mode-card"));
    fireEvent.click(screen.getByRole("button", { name: /cancel/i }));
    fireEvent.click(screen.getByRole("button", { name: /^complete$/i }));
    expect(screen.getByTestId("pending-confirm-b1")).toHaveProperty("disabled", true);
  });
```

(If `i18n` resolves to Marathi under Vitest in this file, the name regexes above already match what the existing tests match — check how the existing tests' `/complete/i` resolves and keep the same approach. The English strings are "Complete", "Complete this bill", "Complete on credit", "Cancel".)

In `web/src/__tests__/errors.test.ts`, add:

```ts
  it("names a closed day", () => {
    expect(describeError({ message: "day is closed", code: "P0001" })?.key).toBe("close.dayClosed");
    expect(describeError({ message: "day already closed", code: "P0001" })?.key).toBe("close.alreadyClosed");
  });
```

- [ ] **Step 2: Run the web tests to verify they fail**

Run (in `web/`): `npm test`
Expected: FAIL — `pay-mode-*` not found, `completeBill` called with the old arguments, error keys `error.unknown`.

- [ ] **Step 3: Implement**

Create `web/src/payments.ts`:

```ts
/**
 * How a bill was paid. Pure and dependency-free so any screen can import it without a test
 * having to mock it -- Pending.test.tsx replaces "../data" wholesale, which would leave a
 * constant exported from there undefined.
 *
 * Order is the display order everywhere: the Pending buttons, the close screen, the
 * dashboard split.
 */
export type PaymentMode = "cash" | "upi" | "card" | "credit";
export const PAYMENT_MODES: readonly PaymentMode[] = ["cash", "upi", "card", "credit"];

/** A reporting label only: a done bill with no payment row (completed before 0021). */
export type SplitMode = PaymentMode | "unrecorded";
```

In `web/src/data.ts`, add `import type { PaymentMode } from "./payments";` at the top and replace `completeBill` and its doc comment with:

```ts
/**
 * Completes a sale with how it was paid, optionally spending some of the customer's points.
 *
 * p_payment_mode is required by the database (0021): a call without it is refused, so a
 * stale tab cannot complete a sale with no payment recorded. p_redeem_points is omitted
 * rather than sent as 0 when nothing is redeemed. Parameter names must match
 * 0021_payments_and_day_close.sql exactly -- PostgREST resolves the function by argument
 * name and a mismatch reads as "function not found".
 */
export async function completeBill(billId: string, mode: PaymentMode, redeemPoints?: number) {
  const args: Record<string, unknown> = { p_bill_id: billId, p_payment_mode: mode };
  if (redeemPoints && redeemPoints > 0) args.p_redeem_points = redeemPoints;
  return supabase.rpc("complete_bill", args);
}
```

In `web/src/screens/Pending.tsx`:
- Add `import { PAYMENT_MODES, type PaymentMode } from "../payments";`
- Add state after `redeemInput`:
  ```ts
  // Never preselected: a forgotten tap must not quietly become cash in the day's count.
  const [mode, setMode] = useState<PaymentMode | null>(null);
  ```
- In `openConfirm`, after `setRedeemInput("");` add `setMode(null);`
- In `confirm`, at the top: `if (!mode) return;` then `const chosen = mode;`, and change the call to `const { error } = await completeBill(id, chosen, points);`
- In the dialog, immediately before the `pending-confirm-${bill.id}` button, add:
  ```tsx
  <fieldset className="space-y-2">
    <legend className="text-sm text-slate-700">{t("pending.modeLabel")}</legend>
    <div className="grid grid-cols-2 gap-2">
      {PAYMENT_MODES.map((m) => (
        <button
          key={m}
          type="button"
          data-testid={`pay-mode-${m}`}
          aria-pressed={mode === m}
          onClick={() => setMode(m)}
          className={`rounded-lg px-3 py-3 min-h-[44px] border font-semibold ${
            mode === m
              ? "bg-emerald-600 text-white border-emerald-600"
              : "bg-white text-slate-700 border-slate-300"}`}
        >
          {t(`pay.${m}`)}
        </button>
      ))}
    </div>
  </fieldset>
  ```
- On the `pending-confirm-${bill.id}` button: add `disabled={mode === null}`, add `disabled:opacity-50` to its className, and change its label to `{mode === "credit" ? t("pending.confirmCredit") : t("pending.confirmAccept")}`.

In `web/src/errors.ts`, inside `describeError`, directly after the `void.notDone` line add:

```ts
  // Day close (0021), plpgsql P0001 like the others: matched on message.
  if (/day is closed/i.test(detail)) return { key: "close.dayClosed", detail };
  if (/day already closed/i.test(detail)) return { key: "close.alreadyClosed", detail };
```

i18n — add to each file. A new top-level `"pay"` object and a new top-level `"close"` object (Task 6-8 add more keys to `close`); two keys inside the existing `"pending"` object.

`en.json`:
```json
"pay": { "cash": "Cash", "upi": "UPI", "card": "Card", "credit": "Credit", "unrecorded": "Not recorded" },
"close": {
  "dayClosed": "Today is closed. Ask an admin to reopen it.",
  "alreadyClosed": "This day is already closed. Reload to see it."
}
```
`pending` additions: `"modeLabel": "How was it paid?", "confirmCredit": "Complete on credit"`

`hi.json`:
```json
"pay": { "cash": "नकद", "upi": "UPI", "card": "कार्ड", "credit": "उधार", "unrecorded": "दर्ज नहीं" },
"close": {
  "dayClosed": "आज का दिन बंद हो चुका है। दोबारा खोलने के लिए एडमिन से कहें।",
  "alreadyClosed": "यह दिन पहले ही बंद हो चुका है। देखने के लिए रीलोड करें।"
}
```
`pending` additions: `"modeLabel": "भुगतान कैसे हुआ?", "confirmCredit": "उधार पर पूरा करें"`

`mr.json`:
```json
"pay": { "cash": "रोख", "upi": "UPI", "card": "कार्ड", "credit": "उधारी", "unrecorded": "नोंद नाही" },
"close": {
  "dayClosed": "आजचा दिवस बंद झाला आहे. पुन्हा उघडण्यासाठी ॲडमिनला सांगा.",
  "alreadyClosed": "हा दिवस आधीच बंद झाला आहे. पाहण्यासाठी रीलोड करा."
}
```
`pending` additions: `"modeLabel": "पैसे कसे दिले?", "confirmCredit": "उधारीवर पूर्ण करा"`

- [ ] **Step 4: Run tests and type check**

Run (in `web/`): `npm test` then `npx tsc --noEmit`
Expected: all PASS, no type errors.

- [ ] **Step 5: Commit**

```bash
git add web/src
git commit -m "feat(web): pick a payment mode before completing a bill

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Print the payment mode on the receipt

**Files:**
- Modify: `web/src/receipt.ts`
- Modify: `web/src/screens/Receipt.tsx` (after the `receipt.paid` row, ~line 149)
- Modify: `web/src/i18n/en.json`, `hi.json`, `mr.json`
- Test: `web/src/__tests__/Receipt.test.tsx`, `web/src/__tests__/receipt.test.ts`

**Interfaces:**
- Consumes: `PaymentMode` from Task 4; `bill_payments` from Task 1.
- Produces: `Receipt.payment_mode: PaymentMode | null`; i18n `receipt.paidBy`, `receipt.onCredit`.

- [ ] **Step 1: Write the failing tests**

In `web/src/__tests__/Receipt.test.tsx`, add `payment_mode: null,` to the `FULL` fixture, and add:

```tsx
  it("prints how the bill was paid", async () => {
    loadReceipt.mockResolvedValue({ data: { ...FULL, payment_mode: "upi" }, error: null });
    renderAt();
    expect((await screen.findByTestId("receipt-mode")).textContent).toMatch(/UPI/);
  });

  it("prints 'On credit' for a credit bill", async () => {
    loadReceipt.mockResolvedValue({ data: { ...FULL, payment_mode: "credit" }, error: null });
    renderAt();
    expect((await screen.findByTestId("receipt-mode")).textContent).toMatch(/credit|उधार/i);
  });

  it("prints no mode line for a bill completed before modes existed", async () => {
    renderAt();
    await screen.findByTestId("receipt-total");
    expect(screen.queryByTestId("receipt-mode")).toBeNull();
  });
```

In `web/src/__tests__/receipt.test.ts`, add a case (follow the file's existing pattern of setting `responses.bills` and calling `loadReceipt`):

```ts
  it("reads the payment mode, whether PostgREST embeds it as an object or an array", async () => {
    responses.bills = { ...responses.bills, bill_payments: { mode: "card" } };
    expect((await loadReceipt("b1")).data?.payment_mode).toBe("card");
    responses.bills = { ...responses.bills, bill_payments: [{ mode: "cash" }] };
    expect((await loadReceipt("b1")).data?.payment_mode).toBe("cash");
    responses.bills = { ...responses.bills, bill_payments: null };
    expect((await loadReceipt("b1")).data?.payment_mode).toBeNull();
  });
```

(Use whatever base `responses.bills` the file's other cases set up; if it is set per test, copy that setup into this one.)

- [ ] **Step 2: Run to verify failure**

Run (in `web/`): `npm test`
Expected: FAIL — `receipt-mode` missing; `payment_mode` undefined.

- [ ] **Step 3: Implement**

In `web/src/receipt.ts`:
- `import type { PaymentMode } from "./payments";`
- Add to `Receipt`:
  ```ts
  /** How it was paid; null for a bill completed before payment modes existed (0021). */
  payment_mode: PaymentMode | null;
  ```
- Append `, bill_payments(mode)` to the end of `RECEIPT_COLS` (inside the last string).
- Add to the `b` cast type: `bill_payments: { mode: PaymentMode } | { mode: PaymentMode }[] | null;`
- Before `const data: Receipt = {`:
  ```ts
  // bill_payments.bill_id is unique, so PostgREST may embed it as one object rather than an
  // array. Accept both rather than depend on how the relationship is detected.
  const pay = Array.isArray(b.bill_payments) ? b.bill_payments[0] : b.bill_payments;
  ```
- Add to the object: `payment_mode: pay?.mode ?? null,`

In `web/src/screens/Receipt.tsx`, directly after the `<div className="flex justify-between">` block holding `t("receipt.paid")`:

```tsx
        {data.payment_mode && (
          <div data-testid="receipt-mode" className="text-center">
            {data.payment_mode === "credit"
              ? t("receipt.onCredit")
              : t("receipt.paidBy", { mode: t(`pay.${data.payment_mode}`) })}
          </div>
        )}
```

i18n — add inside the existing `"receipt"` object:
- en: `"paidBy": "Paid by {{mode}}", "onCredit": "On credit"`
- hi: `"paidBy": "{{mode}} से भुगतान", "onCredit": "उधार"`
- mr: `"paidBy": "{{mode}} ने भरले", "onCredit": "उधारी"`

- [ ] **Step 4: Run tests and type check**

Run (in `web/`): `npm test` then `npx tsc --noEmit`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add web/src
git commit -m "feat(web): print the payment mode on the receipt

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Day-close rules and API module

**Files:**
- Create: `web/src/closeRules.ts`
- Create: `web/src/dayClose.ts`
- Test: `web/src/__tests__/closeRules.test.ts`, `web/src/__tests__/dayClose.test.ts`

**Interfaces:**
- Consumes: `close_day`, `reopen_day`, `day_summary`, `unclosed_days`, table `day_closes` (Tasks 2-3).
- Produces (`closeRules.ts`, pure):
  - `parseCounted(raw: string): { ok: true; value: number } | { ok: false; reason: "empty" | "notANumber" | "negative" | "tooPrecise" }`
  - `differenceOf(counted: number, expected: number): number` — rounded to paise
  - `type CloseRow = { id: string; business_date: string; expected_cash: number; counted_cash: number; difference: number; note: string | null; closed_at: string; reopened_at: string | null; reopen_reason: string | null; closer: string | null }`
  - `latestPerDate(rows: CloseRow[], limit = 14): CloseRow[]` — newest `closed_at` per date, dates descending
  - `formatBusinessDate(ymd: string, lang: string): string` — e.g. "22 Sept"
- Produces (`dayClose.ts`):
  - `type DaySummary = { business_date: string; split: Record<SplitMode, { total: number; count: number }>; expected_cash: number; pending_tokens: number }`
  - `loadDaySummary(date?: string): Promise<{ data: DaySummary | null; error: ... }>`
  - `closeDay(date: string, counted: number, note: string)`, `reopenDay(date: string, reason: string)`
  - `loadRecentCloses(): Promise<{ data: CloseRow[] | null; error: ... }>`
  - `loadUnclosedDays(): Promise<{ data: string[] | null; error: ... }>`
  - `DAY_CLOSES_CHANGED = "day-closes-changed"`, `notifyDayClosesChanged(): void`

- [ ] **Step 1: Write the failing tests**

Create `web/src/__tests__/closeRules.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { parseCounted, differenceOf, latestPerDate, formatBusinessDate, type CloseRow } from "../closeRules";

describe("parseCounted", () => {
  it("accepts zero and plain amounts to the paisa", () => {
    expect(parseCounted("0")).toEqual({ ok: true, value: 0 });
    expect(parseCounted(" 1250.50 ")).toEqual({ ok: true, value: 1250.5 });
  });
  it("names what is wrong", () => {
    expect(parseCounted("")).toEqual({ ok: false, reason: "empty" });
    expect(parseCounted("12a")).toEqual({ ok: false, reason: "notANumber" });
    expect(parseCounted("1e3")).toEqual({ ok: false, reason: "notANumber" });
    expect(parseCounted("-5")).toEqual({ ok: false, reason: "negative" });
    expect(parseCounted("10.555")).toEqual({ ok: false, reason: "tooPrecise" });
  });
});

describe("differenceOf", () => {
  it("rounds to paise so float noise never reads as a shortfall", () => {
    expect(differenceOf(0.3, 0.1 + 0.2)).toBe(0);
    expect(differenceOf(190, 200)).toBe(-10);
  });
});

const row = (date: string, closed_at: string, extra: Partial<CloseRow> = {}): CloseRow => ({
  id: `${date}-${closed_at}`, business_date: date, expected_cash: 0, counted_cash: 0, difference: 0,
  note: null, closed_at, reopened_at: null, reopen_reason: null, closer: "S", ...extra,
});

describe("latestPerDate", () => {
  it("keeps the newest close for each date, newest date first", () => {
    const rows = [
      row("2026-09-21", "2026-09-21T15:00:00Z", { reopened_at: "2026-09-21T16:00:00Z", reopen_reason: "x" }),
      row("2026-09-21", "2026-09-21T17:00:00Z"),
      row("2026-09-22", "2026-09-22T15:00:00Z"),
    ];
    expect(latestPerDate(rows).map((r) => r.id)).toEqual([
      "2026-09-22-2026-09-22T15:00:00Z", "2026-09-21-2026-09-21T17:00:00Z",
    ]);
  });
  it("stops at the limit", () => {
    const rows = Array.from({ length: 20 }, (_, i) =>
      row(`2026-08-${String(i + 1).padStart(2, "0")}`, `2026-08-${String(i + 1).padStart(2, "0")}T15:00:00Z`));
    expect(latestPerDate(rows, 14)).toHaveLength(14);
  });
});

describe("formatBusinessDate", () => {
  it("formats the calendar date without shifting it through UTC", () => {
    expect(formatBusinessDate("2026-09-22", "en")).toMatch(/22/);
    expect(formatBusinessDate("2026-09-01", "en")).toMatch(/\b1\b/);
  });
});
```

Create `web/src/__tests__/dayClose.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";

const rpc = vi.fn();
const order = vi.fn();
const select = vi.fn(() => ({ order }));
const from = vi.fn(() => ({ select }));
vi.mock("../supabase", () => ({ supabase: { rpc: (...a: unknown[]) => rpc(...a), from: (...a: unknown[]) => from(...a) } }));

const { loadDaySummary, closeDay, reopenDay, loadRecentCloses, loadUnclosedDays } = await import("../dayClose");

beforeEach(() => { rpc.mockReset(); order.mockReset(); from.mockClear(); select.mockClear(); });

describe("loadDaySummary", () => {
  it("asks for today by omitting the date, and coerces numerics", async () => {
    rpc.mockResolvedValue({ data: [{
      business_date: "2026-09-23", cash: "200.00", cash_count: 1, upi: "80.00", upi_count: "1",
      card: "0", card_count: 0, credit: "40.00", credit_count: 1, unrecorded: "0", unrecorded_count: 0,
      expected_cash: "200.00", pending_tokens: "2",
    }], error: null });
    const { data } = await loadDaySummary();
    expect(rpc).toHaveBeenCalledWith("day_summary", {});
    expect(data?.split.cash).toEqual({ total: 200, count: 1 });
    expect(data?.split.upi).toEqual({ total: 80, count: 1 });
    expect(data?.expected_cash).toBe(200);
    expect(data?.pending_tokens).toBe(2);
  });
  it("passes a date when given one", async () => {
    rpc.mockResolvedValue({ data: [], error: null });
    await loadDaySummary("2026-09-20");
    expect(rpc).toHaveBeenCalledWith("day_summary", { p_date: "2026-09-20" });
  });
});

describe("writes", () => {
  it("sends a blank note as null", async () => {
    rpc.mockResolvedValue({ data: null, error: null });
    await closeDay("2026-09-23", 200, "   ");
    expect(rpc).toHaveBeenCalledWith("close_day", { p_date: "2026-09-23", p_counted_cash: 200, p_note: null });
  });
  it("reopens with a reason", async () => {
    rpc.mockResolvedValue({ data: null, error: null });
    await reopenDay("2026-09-23", "late sale");
    expect(rpc).toHaveBeenCalledWith("reopen_day", { p_date: "2026-09-23", p_reason: "late sale" });
  });
});

describe("reads", () => {
  it("coerces recent closes and flattens the closer's name", async () => {
    order.mockReturnValue({ limit: async () => ({ data: [{
      id: "c1", business_date: "2026-09-22", expected_cash: "200.00", counted_cash: "190.00",
      difference: "-10.00", note: "x", closed_at: "t", reopened_at: null, reopen_reason: null,
      closer: { name: "Sunil" },
    }], error: null }) });
    const { data } = await loadRecentCloses();
    expect(from).toHaveBeenCalledWith("day_closes");
    expect(data?.[0]).toMatchObject({ difference: -10, counted_cash: 190, closer: "Sunil" });
  });
  it("returns unclosed days as date strings", async () => {
    rpc.mockResolvedValue({ data: [{ business_date: "2026-09-22" }, { business_date: "2026-09-21" }], error: null });
    const { data } = await loadUnclosedDays();
    expect(rpc).toHaveBeenCalledWith("unclosed_days");
    expect(data).toEqual(["2026-09-22", "2026-09-21"]);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run (in `web/`): `npm test`
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement**

Create `web/src/closeRules.ts`:

```ts
/**
 * The day-close screen's arithmetic and parsing, kept out of the component so it can be
 * tested without rendering. Nothing here talks to the database.
 */

const paise = (n: number): number => Math.round(n * 100) / 100;

export function parseCounted(
  raw: string,
): { ok: true; value: number } | { ok: false; reason: "empty" | "notANumber" | "negative" | "tooPrecise" } {
  const text = raw.trim();
  if (text === "") return { ok: false, reason: "empty" };
  // Plain decimals only: "1e3" would be read as 1000 by Number() and by Postgres alike,
  // which is not what anyone counting a drawer typed.
  if (!/^-?\d+(\.\d+)?$/.test(text)) return { ok: false, reason: "notANumber" };
  const value = Number(text);
  if (value < 0) return { ok: false, reason: "negative" };
  if ((text.split(".")[1]?.length ?? 0) > 2) return { ok: false, reason: "tooPrecise" };
  return { ok: true, value };
}

/** Counted minus expected, to the paisa. The server computes the stored figure the same way. */
export function differenceOf(counted: number, expected: number): number {
  return paise(counted - expected);
}

export type CloseRow = {
  id: string;
  business_date: string;
  expected_cash: number;
  counted_cash: number;
  difference: number;
  note: string | null;
  closed_at: string;
  reopened_at: string | null;
  reopen_reason: string | null;
  closer: string | null;
};

/** The newest close for each date (a reopened day may have several), newest date first. */
export function latestPerDate(rows: readonly CloseRow[], limit = 14): CloseRow[] {
  const byDate = new Map<string, CloseRow>();
  for (const r of rows) {
    const seen = byDate.get(r.business_date);
    if (!seen || r.closed_at > seen.closed_at) byDate.set(r.business_date, r);
  }
  return [...byDate.values()]
    .sort((a, b) => (a.business_date < b.business_date ? 1 : -1))
    .slice(0, limit);
}

/**
 * "2026-09-22" is a calendar date, not an instant. new Date("2026-09-22") would parse it as
 * UTC midnight and show the 21st west of Greenwich, so build it from its parts in local time.
 */
export function formatBusinessDate(ymd: string, lang: string): string {
  const [y, m, d] = ymd.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(lang, { day: "numeric", month: "short" });
}
```

Create `web/src/dayClose.ts`:

```ts
import { supabase } from "./supabase";
import type { SplitMode } from "./payments";
import type { CloseRow } from "./closeRules";

/**
 * The reads and writes behind the Close day screen and the unclosed-days banner. A sibling
 * to data.ts, history.ts and receipt.ts: a small surface the screens stub in tests. Nothing
 * here filters by vendor -- RLS scopes every query.
 *
 * As in receipt.ts, everything returned is already coerced: PostgREST sends numeric as a
 * string, and the screen must never do arithmetic on one.
 */

type DbError = { message?: string; code?: string } | null;
const num = (v: unknown): number => Number(v ?? 0);

export type DaySummary = {
  business_date: string;
  split: Record<SplitMode, { total: number; count: number }>;
  expected_cash: number;
  pending_tokens: number;
};

/** Omitting the date asks the server for today in Asia/Kolkata, so a phone on the wrong
 *  timezone still closes the right day. Parameter names must match 0021 exactly. */
export async function loadDaySummary(date?: string): Promise<{ data: DaySummary | null; error: DbError }> {
  const { data, error } = await supabase.rpc("day_summary", date ? { p_date: date } : {});
  if (error) return { data: null, error };
  const r = (Array.isArray(data) ? data[0] : data) as Record<string, unknown> | undefined;
  if (!r) return { data: null, error: null };
  const pair = (m: SplitMode) => ({ total: num(r[m]), count: num(r[`${m}_count`]) });
  return {
    data: {
      business_date: String(r.business_date).slice(0, 10),
      split: {
        cash: pair("cash"), upi: pair("upi"), card: pair("card"),
        credit: pair("credit"), unrecorded: pair("unrecorded"),
      },
      expected_cash: num(r.expected_cash),
      pending_tokens: num(r.pending_tokens),
    },
    error: null,
  };
}

export async function closeDay(date: string, counted: number, note: string) {
  return supabase.rpc("close_day", {
    p_date: date, p_counted_cash: counted, p_note: note.trim() === "" ? null : note.trim(),
  });
}

export async function reopenDay(date: string, reason: string) {
  return supabase.rpc("reopen_day", { p_date: date, p_reason: reason.trim() });
}

// closed_by and reopened_by both reference app_users, so the embed must name its key.
const CLOSE_COLS =
  "id, business_date, expected_cash, counted_cash, difference, note, closed_at, " +
  "reopened_at, reopen_reason, closer:app_users!day_closes_closed_by_fkey(name)";

/** Enough rows for 14 dates even when some were reopened and closed again. */
export async function loadRecentCloses(): Promise<{ data: CloseRow[] | null; error: DbError }> {
  const { data, error } = await supabase
    .from("day_closes")
    .select(CLOSE_COLS)
    .order("closed_at", { ascending: false })
    .limit(60);
  if (error) return { data: null, error };
  const rows = (data ?? []) as unknown as (Record<string, unknown> & { closer: { name: string } | null })[];
  return {
    data: rows.map((r) => ({
      id: String(r.id),
      business_date: String(r.business_date).slice(0, 10),
      expected_cash: num(r.expected_cash),
      counted_cash: num(r.counted_cash),
      difference: num(r.difference),
      note: (r.note as string | null) ?? null,
      closed_at: String(r.closed_at),
      reopened_at: (r.reopened_at as string | null) ?? null,
      reopen_reason: (r.reopen_reason as string | null) ?? null,
      closer: r.closer?.name ?? null,
    })),
    error: null,
  };
}

export async function loadUnclosedDays(): Promise<{ data: string[] | null; error: DbError }> {
  const { data, error } = await supabase.rpc("unclosed_days");
  if (error) return { data: null, error };
  return {
    data: ((data ?? []) as { business_date: string }[]).map((r) => String(r.business_date).slice(0, 10)),
    error: null,
  };
}

/** Tells the banner to re-read right away after a close or reopen, instead of on its next
 *  poll -- a banner still nagging about the day just closed reads as "it did not work". */
export const DAY_CLOSES_CHANGED = "day-closes-changed";
export function notifyDayClosesChanged(): void {
  window.dispatchEvent(new Event(DAY_CLOSES_CHANGED));
}
```

- [ ] **Step 4: Run tests and type check**

Run (in `web/`): `npm test` then `npx tsc --noEmit`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add web/src
git commit -m "feat(web): day-close rules and API module

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: The Close day screen

**Files:**
- Create: `web/src/screens/CloseDay.tsx`
- Modify: `web/src/routes.ts`, `web/src/App.tsx`
- Modify: `web/src/i18n/en.json`, `hi.json`, `mr.json` (`nav.close`, more `close.*`)
- Test: `web/src/__tests__/CloseDay.test.tsx`, `web/src/__tests__/routes.test.ts`, `web/src/__tests__/App.test.tsx`

**Interfaces:**
- Consumes: everything `dayClose.ts` and `closeRules.ts` export (Task 6); `PAYMENT_MODES` (Task 4); `useSession()` (`{ kind: "ready", role, ... }`).
- Produces: route `/close` for admin and biller, `labelKey: "nav.close"`.

- [ ] **Step 1: Write the failing tests**

In `web/src/__tests__/routes.test.ts`, change the expected arrays to:
- biller: `["/pending", "/completed", "/close"]`
- admin: `["/bill", "/pending", "/completed", "/items", "/customers", "/requests", "/stock", "/settings", "/dashboards", "/close"]`

and add:

```ts
  it("gives the close screen to admin and biller, never the recorder", () => {
    expect(canAccess("admin", "/close")).toBe(true);
    expect(canAccess("biller", "/close")).toBe(true);
    expect(canAccess("recorder", "/close")).toBe(false);
  });
```

In `web/src/__tests__/App.test.tsx`, next to the other screen stubs add:

```tsx
vi.mock("../screens/CloseDay", () => ({ default: () => <div data-testid="screen-close" /> }));
vi.mock("../dayClose", () => ({
  loadUnclosedDays: async () => ({ data: [], error: null }),
  DAY_CLOSES_CHANGED: "day-closes-changed",
}));
```

(The `dayClose` stub is for Task 8's banner, which Shell renders; adding it now keeps App.test green through both tasks.)

Create `web/src/__tests__/CloseDay.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import i18n from "../i18n";
import type { DaySummary } from "../dayClose";
import type { CloseRow } from "../closeRules";

const SUMMARY: DaySummary = {
  business_date: "2026-09-23",
  split: {
    cash: { total: 1200, count: 6 }, upi: { total: 800, count: 4 }, card: { total: 0, count: 0 },
    credit: { total: 150, count: 1 }, unrecorded: { total: 0, count: 0 },
  },
  expected_cash: 1200,
  pending_tokens: 2,
};

const loadDaySummary = vi.fn();
const closeDay = vi.fn();
const reopenDay = vi.fn();
const loadRecentCloses = vi.fn();
const loadUnclosedDays = vi.fn();
const notifyDayClosesChanged = vi.fn();
vi.mock("../dayClose", () => ({
  loadDaySummary: (...a: unknown[]) => loadDaySummary(...a),
  closeDay: (...a: unknown[]) => closeDay(...a),
  reopenDay: (...a: unknown[]) => reopenDay(...a),
  loadRecentCloses: (...a: unknown[]) => loadRecentCloses(...a),
  loadUnclosedDays: (...a: unknown[]) => loadUnclosedDays(...a),
  notifyDayClosesChanged: () => notifyDayClosesChanged(),
}));

let role: "admin" | "biller" = "biller";
vi.mock("../components/SessionProvider", () => ({
  useSession: () => ({ kind: "ready", userId: "u1", vendorId: "v1", vendorName: "V", name: "S", role }),
}));

const { default: CloseDay } = await import("../screens/CloseDay");

const closedRow = (extra: Partial<CloseRow> = {}): CloseRow => ({
  id: "c1", business_date: "2026-09-23", expected_cash: 1200, counted_cash: 1200, difference: 0,
  note: null, closed_at: "2026-09-23T14:42:00Z", reopened_at: null, reopen_reason: null, closer: "Sunil",
  ...extra,
});

function renderAs(r: "admin" | "biller") {
  role = r;
  return render(<MemoryRouter><CloseDay /></MemoryRouter>);
}

beforeEach(async () => {
  vi.clearAllMocks();
  await i18n.changeLanguage("en");
  loadDaySummary.mockResolvedValue({ data: SUMMARY, error: null });
  loadRecentCloses.mockResolvedValue({ data: [], error: null });
  loadUnclosedDays.mockResolvedValue({ data: [], error: null });
  closeDay.mockResolvedValue({ data: {}, error: null });
  reopenDay.mockResolvedValue({ data: {}, error: null });
});

describe("Close day", () => {
  it("shows the split, expected cash and carried-over tokens", async () => {
    renderAs("biller");
    expect((await screen.findByTestId("close-expected")).textContent).toMatch(/1,200\.00/);
    expect(screen.getByTestId("close-split-upi").textContent).toMatch(/800\.00/);
    expect(screen.getByTestId("close-split-credit").textContent).toMatch(/not yet collected/i);
    expect(screen.queryByTestId("close-split-unrecorded")).toBeNull();
    expect(screen.getByTestId("close-carried").textContent).toMatch(/2/);
  });

  it("closes at zero difference without a note, after confirming", async () => {
    renderAs("biller");
    fireEvent.change(await screen.findByTestId("close-counted"), { target: { value: "1200" } });
    expect(screen.getByTestId("close-difference").className).toMatch(/green/);
    fireEvent.click(screen.getByTestId("close-submit"));
    fireEvent.click(screen.getByTestId("close-confirm"));
    await waitFor(() => expect(closeDay).toHaveBeenCalledWith("2026-09-23", 1200, ""));
    expect(notifyDayClosesChanged).toHaveBeenCalled();
  });

  it("needs a note when the cash does not match", async () => {
    renderAs("biller");
    fireEvent.change(await screen.findByTestId("close-counted"), { target: { value: "1190" } });
    expect(screen.getByTestId("close-difference").className).toMatch(/amber/);
    expect(screen.getByTestId("close-difference").textContent).toMatch(/-.*10\.00|10\.00/);
    expect(screen.getByTestId("close-submit")).toHaveProperty("disabled", true);
    fireEvent.change(screen.getByTestId("close-note"), { target: { value: "change given" } });
    expect(screen.getByTestId("close-submit")).toHaveProperty("disabled", false);
  });

  it("refuses an amount it cannot read", async () => {
    renderAs("biller");
    fireEvent.change(await screen.findByTestId("close-counted"), { target: { value: "12.345" } });
    expect(screen.getByTestId("close-submit")).toHaveProperty("disabled", true);
    expect(screen.getByTestId("close-bad-cash")).toBeTruthy();
  });

  it("shows a closed day's status and no form", async () => {
    loadRecentCloses.mockResolvedValue({ data: [closedRow()], error: null });
    renderAs("biller");
    expect((await screen.findByTestId("close-status")).textContent).toMatch(/Sunil/);
    expect(screen.queryByTestId("close-counted")).toBeNull();
  });

  it("offers Reopen to an admin only, and requires a reason", async () => {
    loadRecentCloses.mockResolvedValue({ data: [closedRow()], error: null });
    renderAs("biller");
    await screen.findByTestId("close-status");
    expect(screen.queryByTestId("close-reopen-2026-09-23")).toBeNull();

    renderAs("admin");
    fireEvent.click((await screen.findAllByTestId("close-reopen-2026-09-23"))[0]);
    expect(screen.getByTestId("close-reopen-accept")).toHaveProperty("disabled", true);
    fireEvent.change(screen.getByTestId("close-reopen-reason"), { target: { value: "late sale" } });
    fireEvent.click(screen.getByTestId("close-reopen-accept"));
    await waitFor(() => expect(reopenDay).toHaveBeenCalledWith("2026-09-23", "late sale"));
  });

  it("loads a past unclosed day into the panel", async () => {
    loadUnclosedDays.mockResolvedValue({ data: ["2026-09-22"], error: null });
    renderAs("biller");
    fireEvent.click(await screen.findByTestId("close-pick-2026-09-22"));
    await waitFor(() => expect(loadDaySummary).toHaveBeenLastCalledWith("2026-09-22"));
  });

  it("explains an already-closed refusal", async () => {
    closeDay.mockResolvedValue({ data: null, error: { message: "day already closed", code: "P0001" } });
    renderAs("biller");
    fireEvent.change(await screen.findByTestId("close-counted"), { target: { value: "1200" } });
    fireEvent.click(screen.getByTestId("close-submit"));
    fireEvent.click(screen.getByTestId("close-confirm"));
    // findAll: the raw detail ("day already closed") is rendered beside the message too.
    expect((await screen.findAllByText(/already closed/i)).length).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run (in `web/`): `npm test`
Expected: FAIL — `CloseDay` module missing, route arrays differ.

- [ ] **Step 3: Implement**

In `web/src/routes.ts`: append `{ path: "/close", labelKey: "nav.close" }` to the end of the `biller` list and to the end of the `admin` list.

In `web/src/App.tsx`: `import CloseDay from "./screens/CloseDay";` and inside `ShellRoutes`, after the `/dashboards` route: `<Route path="/close" element={<CloseDay />} />`.

Create `web/src/screens/CloseDay.tsx`:

```tsx
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import "../i18n";
import { useSession } from "../components/SessionProvider";
import {
  closeDay, loadDaySummary, loadRecentCloses, loadUnclosedDays, notifyDayClosesChanged, reopenDay,
  type DaySummary,
} from "../dayClose";
import { differenceOf, formatBusinessDate, latestPerDate, parseCounted, type CloseRow } from "../closeRules";
import { PAYMENT_MODES } from "../payments";
import { describeError } from "../errors";
import { rupees } from "../money";

/**
 * End of day: what came in by each mode, the cash the drawer should hold, and a count to
 * compare against it. Closing locks the day for completions and voids (0021); only an
 * admin can reopen it. The server computes expected cash and picks "today" -- this screen
 * only displays and submits.
 */
export default function CloseDay() {
  const { t, i18n } = useTranslation();
  const session = useSession();
  const lang = i18n.language;

  // null = today, as the server defines it.
  const [date, setDate] = useState<string | null>(null);
  const [summary, setSummary] = useState<DaySummary | null>(null);
  const [closes, setCloses] = useState<CloseRow[]>([]);
  const [unclosed, setUnclosed] = useState<string[]>([]);
  const [problem, setProblem] = useState<{ key: string; detail: string } | null>(null);
  const [counted, setCounted] = useState("");
  const [note, setNote] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [reopening, setReopening] = useState<string | null>(null);
  const [reason, setReason] = useState("");

  // Which date the newest load was for; a slow load for a date the user has moved off must
  // not paint over the one they are looking at.
  const wanted = useRef<string | null>(null);

  const load = useCallback(async (d: string | null) => {
    wanted.current = d;
    const [s, c, u] = await Promise.all([loadDaySummary(d ?? undefined), loadRecentCloses(), loadUnclosedDays()]);
    if (wanted.current !== d) return;
    setProblem(describeError(s.error) ?? describeError(c.error) ?? describeError(u.error));
    setSummary(s.data);
    setCloses(c.data ?? []);
    setUnclosed(u.data ?? []);
  }, []);

  useEffect(() => { void load(date); }, [date, load]);

  if (session.kind !== "ready") return null;
  const isAdmin = session.role === "admin";

  const active = summary
    ? closes.find((c) => c.business_date === summary.business_date && c.reopened_at === null) ?? null
    : null;
  const parsed = parseCounted(counted);
  const diff = parsed.ok && summary ? differenceOf(parsed.value, summary.expected_cash) : null;
  const needsNote = diff !== null && diff !== 0;
  const canSubmit = parsed.ok && (!needsNote || note.trim() !== "") && !busy;

  function pick(d: string | null) {
    setDate(d);
    setCounted("");
    setNote("");
    setConfirming(false);
    setProblem(null);
  }

  async function submit() {
    if (!summary || !parsed.ok) return;
    setConfirming(false);
    setBusy(true);
    const { error } = await closeDay(summary.business_date, parsed.value, note);
    setBusy(false);
    if (error) { setProblem(describeError(error)); return; }
    notifyDayClosesChanged();
    setCounted("");
    setNote("");
    await load(date);
  }

  async function reopen(d: string) {
    setBusy(true);
    const { error } = await reopenDay(d, reason);
    setBusy(false);
    if (error) { setProblem(describeError(error)); return; }
    notifyDayClosesChanged();
    setReopening(null);
    setReason("");
    await load(date);
  }

  const time = (iso: string) => new Date(iso).toLocaleTimeString(lang, { hour: "numeric", minute: "2-digit" });
  const history = latestPerDate(closes);
  const pastUnclosed = unclosed.filter((d) => d !== summary?.business_date);

  return (
    <div className="space-y-4">
      <h1 className="text-lg font-semibold text-slate-800">{t("close.title")}</h1>

      {problem && (
        <p className="border border-red-200 bg-red-50 rounded-xl p-3 text-sm text-red-700">
          {t(problem.key)} <span className="text-xs text-slate-500">{problem.detail}</span>
        </p>
      )}

      {summary && (
        <section className="bg-white border border-slate-200 rounded-xl p-4 space-y-3">
          <div className="flex items-center justify-between gap-2">
            <p className="font-semibold text-slate-800">{formatBusinessDate(summary.business_date, lang)}</p>
            <p data-testid="close-status" className={`text-sm ${active ? "text-slate-600" : "text-green-700"}`}>
              {active
                ? t("close.statusClosed", { time: time(active.closed_at), name: active.closer ?? "—" })
                : t("close.statusOpen")}
            </p>
          </div>

          <dl className="grid grid-cols-[1fr_auto_auto] gap-x-3 gap-y-1 text-sm">
            {[...PAYMENT_MODES, ...(summary.split.unrecorded.count > 0 ? ["unrecorded" as const] : [])].map((m) => (
              <div key={m} data-testid={`close-split-${m}`} className="contents">
                <dt className="text-slate-600">
                  {t(`pay.${m}`)}
                  {m === "credit" && <span className="text-xs text-slate-400"> ({t("close.creditNote")})</span>}
                </dt>
                <dd className="text-slate-500 text-right">{t("close.bills", { n: summary.split[m].count })}</dd>
                <dd className="text-slate-800 text-right">{rupees(summary.split[m].total)}</dd>
              </div>
            ))}
          </dl>

          <div>
            <p className="text-sm text-slate-500">{t("close.expected")}</p>
            <p data-testid="close-expected" className="text-3xl font-semibold text-slate-800">
              {rupees(summary.expected_cash)}
            </p>
          </div>

          {summary.pending_tokens > 0 && (
            <p data-testid="close-carried" className="text-sm text-amber-700">
              {t("close.carriedOver", { n: summary.pending_tokens })}
            </p>
          )}

          {!active && (
            <div className="space-y-2">
              <label className="block text-sm text-slate-700">
                {t("close.counted")}
                <input
                  data-testid="close-counted"
                  inputMode="decimal"
                  value={counted}
                  onChange={(e) => setCounted(e.target.value)}
                  className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 min-h-[44px]"
                />
              </label>
              {counted.trim() !== "" && !parsed.ok && (
                <p data-testid="close-bad-cash" className="text-xs text-red-700">{t("close.badCash")}</p>
              )}
              {diff !== null && (
                <p
                  data-testid="close-difference"
                  className={`text-sm font-semibold ${diff === 0 ? "text-green-700" : "text-amber-700"}`}
                >
                  {t("close.difference")}: {diff > 0 ? "+" : ""}{rupees(diff)}
                </p>
              )}
              <label className="block text-sm text-slate-700">
                {t("close.note")}
                <textarea
                  data-testid="close-note"
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2"
                />
              </label>
              {needsNote && note.trim() === "" && (
                <p className="text-xs text-amber-700">{t("close.noteRequired")}</p>
              )}
              <button
                data-testid="close-submit"
                disabled={!canSubmit}
                onClick={() => setConfirming(true)}
                className="w-full rounded-lg px-4 py-3 min-h-[44px] bg-emerald-600 text-white font-semibold disabled:opacity-50"
              >
                {t("close.closeBtn")}
              </button>
            </div>
          )}

          {date !== null && (
            <button data-testid="close-today" onClick={() => pick(null)}
                    className="text-sm text-emerald-700 underline">
              {t("close.backToToday")}
            </button>
          )}
        </section>
      )}

      {pastUnclosed.length > 0 && (
        <section className="bg-white border border-amber-200 rounded-xl p-4 space-y-2">
          <h2 className="font-semibold text-slate-800">{t("close.notClosedList")}</h2>
          <ul className="space-y-1">
            {pastUnclosed.map((d) => (
              <li key={d} className="flex items-center justify-between text-sm">
                <span className="text-slate-700">{formatBusinessDate(d, lang)}</span>
                <button data-testid={`close-pick-${d}`} onClick={() => pick(d)}
                        className="border border-slate-300 rounded-lg px-3 py-2 bg-white min-h-[44px]">
                  {t("close.closeThis")}
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      {history.length > 0 && (
        <section className="bg-white border border-slate-200 rounded-xl p-4 space-y-2">
          <h2 className="font-semibold text-slate-800">{t("close.history")}</h2>
          <ul className="space-y-2">
            {history.map((c) => (
              <li key={c.id} className="text-sm space-y-1">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-slate-700">{formatBusinessDate(c.business_date, lang)}</span>
                  <span className={c.difference === 0 ? "text-green-700" : "text-amber-700"}>
                    {c.difference > 0 ? "+" : ""}{rupees(c.difference)}
                  </span>
                  <span className="text-slate-500">
                    {c.reopened_at ? t("close.reopened") : (c.closer ?? "—")}
                  </span>
                  {isAdmin && c.reopened_at === null && (
                    <button data-testid={`close-reopen-${c.business_date}`}
                            onClick={() => { setReopening(c.business_date); setReason(""); }}
                            className="border border-slate-300 rounded-lg px-3 py-2 bg-white min-h-[44px]">
                      {t("close.reopen")}
                    </button>
                  )}
                </div>
                {c.note && <p className="text-xs text-slate-500">{c.note}</p>}
                {reopening === c.business_date && (
                  <div className="space-y-2">
                    <label className="block text-sm text-slate-700">
                      {t("close.reopenReason")}
                      <input data-testid="close-reopen-reason" value={reason}
                             onChange={(e) => setReason(e.target.value)}
                             className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 min-h-[44px]" />
                    </label>
                    <button data-testid="close-reopen-accept"
                            disabled={reason.trim() === "" || busy}
                            onClick={() => void reopen(c.business_date)}
                            className="rounded-lg px-4 py-2 min-h-[44px] bg-amber-600 text-white font-semibold disabled:opacity-50">
                      {t("close.reopenAccept")}
                    </button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}

      {confirming && summary && (
        <div role="dialog" aria-modal="true" aria-labelledby="close-confirm-title"
             className="fixed inset-0 bg-black/40 flex items-end sm:items-center justify-center p-4">
          <div className="bg-white rounded-xl p-4 w-full max-w-sm space-y-3">
            <h2 id="close-confirm-title" className="font-semibold text-slate-800">
              {t("close.confirmTitle", { date: formatBusinessDate(summary.business_date, lang) })}
            </h2>
            <p className="text-slate-700">{t("close.confirmBody")}</p>
            <button data-testid="close-confirm" onClick={() => void submit()}
                    className="w-full rounded-lg px-3 py-3 min-h-[44px] bg-emerald-600 text-white font-semibold">
              {t("close.confirmAccept")}
            </button>
            <button onClick={() => setConfirming(false)}
                    className="w-full rounded-lg px-3 py-2 min-h-[44px] border border-slate-300">
              {t("close.cancel")}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
```

i18n — add `"close"` to the `nav` object and these keys to the existing `close` object from Task 4:

`en.json` — `nav`: `"close": "Close day"`; `close`:
```json
"title": "Close the day", "statusOpen": "Open", "statusClosed": "Closed at {{time}} by {{name}}",
"expected": "Cash expected in the drawer", "counted": "Cash counted", "difference": "Difference",
"note": "Note", "noteRequired": "The cash does not match. Add a note saying why.",
"badCash": "Enter an amount of zero or more, with at most two decimals.",
"carriedOver": "Carried over: {{n}} pending tokens", "closeBtn": "Close day",
"confirmTitle": "Close {{date}}?", "confirmBody": "No more sales or voids on this day after this.",
"confirmAccept": "Yes, close it", "cancel": "Cancel", "history": "Recent days",
"notClosedList": "Not closed yet", "closeThis": "Close", "backToToday": "Back to today",
"reopen": "Reopen", "reopenReason": "Why reopen?", "reopenAccept": "Reopen day",
"reopened": "Reopened", "creditNote": "not yet collected", "bills": "{{n}} bills"
```

`hi.json` — `nav`: `"close": "दिन बंद करें"`; `close`:
```json
"title": "दिन बंद करें", "statusOpen": "खुला", "statusClosed": "{{time}} बजे {{name}} ने बंद किया",
"expected": "गल्ले में अपेक्षित नकद", "counted": "गिना हुआ नकद", "difference": "अंतर",
"note": "टिप्पणी", "noteRequired": "नकद मेल नहीं खा रहा। कारण लिखें।",
"badCash": "शून्य या अधिक राशि लिखें, अधिकतम दो दशमलव।",
"carriedOver": "आगे ले जाए गए: {{n}} बाकी टोकन", "closeBtn": "दिन बंद करें",
"confirmTitle": "{{date}} बंद करें?", "confirmBody": "इसके बाद इस दिन कोई बिक्री या रद्द नहीं होगा।",
"confirmAccept": "हाँ, बंद करें", "cancel": "रद्द करें", "history": "हाल के दिन",
"notClosedList": "अभी बंद नहीं", "closeThis": "बंद करें", "backToToday": "आज पर वापस",
"reopen": "फिर खोलें", "reopenReason": "फिर क्यों खोल रहे हैं?", "reopenAccept": "दिन फिर खोलें",
"reopened": "फिर खोला गया", "creditNote": "अभी वसूल नहीं", "bills": "{{n}} बिल"
```

`mr.json` — `nav`: `"close": "दिवस बंद करा"`; `close`:
```json
"title": "दिवस बंद करा", "statusOpen": "चालू", "statusClosed": "{{time}} वाजता {{name}} यांनी बंद केला",
"expected": "गल्ल्यात अपेक्षित रोख", "counted": "मोजलेली रोख", "difference": "फरक",
"note": "टीप", "noteRequired": "रोख जुळत नाही. कारण लिहा.",
"badCash": "शून्य किंवा जास्त रक्कम लिहा, जास्तीत जास्त दोन दशांश.",
"carriedOver": "पुढे नेलेले: {{n}} बाकी टोकन", "closeBtn": "दिवस बंद करा",
"confirmTitle": "{{date}} बंद करायचा?", "confirmBody": "यानंतर या दिवशी विक्री किंवा रद्द करता येणार नाही.",
"confirmAccept": "हो, बंद करा", "cancel": "रद्द करा", "history": "अलीकडचे दिवस",
"notClosedList": "अजून बंद नाही", "closeThis": "बंद करा", "backToToday": "आजवर परत",
"reopen": "पुन्हा उघडा", "reopenReason": "पुन्हा का उघडत आहात?", "reopenAccept": "दिवस पुन्हा उघडा",
"reopened": "पुन्हा उघडला", "creditNote": "अजून वसूल नाही", "bills": "{{n}} बिले"
```

- [ ] **Step 4: Run tests and type check**

Run (in `web/`): `npm test` then `npx tsc --noEmit`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add web/src
git commit -m "feat(web): Close day screen for admin and biller

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: The unclosed-days banner

**Files:**
- Create: `web/src/components/UnclosedBanner.tsx`
- Modify: `web/src/components/Shell.tsx`
- Modify: `web/src/i18n/en.json`, `hi.json`, `mr.json`
- Test: `web/src/__tests__/UnclosedBanner.test.tsx`

**Interfaces:**
- Consumes: `loadUnclosedDays`, `DAY_CLOSES_CHANGED` (Task 6); `formatBusinessDate` (Task 6).
- Produces: `<UnclosedBanner role={role} />`; i18n `close.banner`, `close.bannerMore`, `close.bannerAction`.

- [ ] **Step 1: Write the failing test**

Create `web/src/__tests__/UnclosedBanner.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import i18n from "../i18n";

const loadUnclosedDays = vi.fn();
vi.mock("../dayClose", () => ({
  loadUnclosedDays: (...a: unknown[]) => loadUnclosedDays(...a),
  DAY_CLOSES_CHANGED: "day-closes-changed",
}));

const { UnclosedBanner } = await import("../components/UnclosedBanner");

const renderAs = (role: "admin" | "biller" | "recorder") =>
  render(<MemoryRouter><UnclosedBanner role={role} /></MemoryRouter>);

beforeEach(async () => {
  vi.clearAllMocks();
  await i18n.changeLanguage("en");
  loadUnclosedDays.mockResolvedValue({ data: ["2026-09-22"], error: null });
});

describe("UnclosedBanner", () => {
  it("names the unclosed day and links to the close screen", async () => {
    renderAs("biller");
    const banner = await screen.findByTestId("unclosed-banner");
    expect(banner.textContent).toMatch(/22/);
    expect(screen.getByRole("link").getAttribute("href")).toBe("/close");
  });

  it("names the oldest day and counts the rest", async () => {
    loadUnclosedDays.mockResolvedValue({ data: ["2026-09-22", "2026-09-21", "2026-09-20"], error: null });
    renderAs("admin");
    const banner = await screen.findByTestId("unclosed-banner");
    expect(banner.textContent).toMatch(/20/);
    expect(banner.textContent).toMatch(/2 more/);
  });

  it("never shows, or even asks, for a recorder", async () => {
    renderAs("recorder");
    await new Promise((r) => setTimeout(r, 0));
    expect(loadUnclosedDays).not.toHaveBeenCalled();
    expect(screen.queryByTestId("unclosed-banner")).toBeNull();
  });

  it("shows nothing when every day is closed or the read fails", async () => {
    loadUnclosedDays.mockResolvedValue({ data: null, error: { message: "boom" } });
    renderAs("admin");
    await waitFor(() => expect(loadUnclosedDays).toHaveBeenCalled());
    expect(screen.queryByTestId("unclosed-banner")).toBeNull();
  });

  it("re-reads when a day is closed", async () => {
    renderAs("biller");
    await screen.findByTestId("unclosed-banner");
    loadUnclosedDays.mockResolvedValue({ data: [], error: null });
    act(() => { window.dispatchEvent(new Event("day-closes-changed")); });
    await waitFor(() => expect(screen.queryByTestId("unclosed-banner")).toBeNull());
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run (in `web/`): `npm test`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement**

Create `web/src/components/UnclosedBanner.tsx`:

```tsx
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import { DAY_CLOSES_CHANGED, loadUnclosedDays } from "../dayClose";
import { formatBusinessDate } from "../closeRules";
import type { Role } from "../config";

const EVERY_MS = 5 * 60 * 1000;

/**
 * "22 Sept is not closed." A nudge, never a block: billing works regardless (the owner
 * chose a warning over stopping the first sale of the morning). Admin and biller only --
 * a recorder cannot close a day, so telling them is noise.
 *
 * Polls like useLowStock, and also re-reads the moment the close screen closes or reopens
 * a day, so the banner never lingers over the day just closed.
 */
export function UnclosedBanner({ role }: { role: Role }) {
  const { t, i18n } = useTranslation();
  const enabled = role === "admin" || role === "biller";
  const [days, setDays] = useState<string[]>([]);

  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    const read = async () => {
      const { data, error } = await loadUnclosedDays();
      // A failed read keeps what was shown rather than flashing the banner away.
      if (alive && !error && data) setDays(data);
    };
    void read();
    const timer = setInterval(() => void read(), EVERY_MS);
    window.addEventListener("focus", read);
    window.addEventListener(DAY_CLOSES_CHANGED, read);
    return () => {
      alive = false;
      clearInterval(timer);
      window.removeEventListener("focus", read);
      window.removeEventListener(DAY_CLOSES_CHANGED, read);
    };
  }, [enabled]);

  if (!enabled || days.length === 0) return null;
  // Newest first from the server; name the OLDEST, which is the one most overdue.
  const date = formatBusinessDate(days[days.length - 1], i18n.language);
  return (
    <div data-testid="unclosed-banner"
         className="bg-amber-50 text-amber-900 text-sm px-4 py-2 flex items-center justify-center gap-3">
      <span>
        {days.length === 1 ? t("close.banner", { date }) : t("close.bannerMore", { date, n: days.length - 1 })}
      </span>
      <Link to="/close" className="underline font-semibold">{t("close.bannerAction")}</Link>
    </div>
  );
}
```

In `web/src/components/Shell.tsx`: `import { UnclosedBanner } from "./UnclosedBanner";` and render `<UnclosedBanner role={role} />` directly after `<OfflineBanner />`.

i18n — add to the `close` object:
- en: `"banner": "{{date}} is not closed.", "bannerMore": "{{date}} and {{n}} more days are not closed.", "bannerAction": "Close now"`
- hi: `"banner": "{{date}} बंद नहीं हुआ है।", "bannerMore": "{{date}} और {{n}} और दिन बंद नहीं हुए हैं।", "bannerAction": "अभी बंद करें"`
- mr: `"banner": "{{date}} बंद झालेला नाही.", "bannerMore": "{{date}} आणि आणखी {{n}} दिवस बंद झालेले नाहीत.", "bannerAction": "आता बंद करा"`

- [ ] **Step 4: Run tests and type check**

Run (in `web/`): `npm test` then `npx tsc --noEmit`
Expected: all PASS, including `App.test.tsx` (its `../dayClose` stub from Task 7 serves the banner).

- [ ] **Step 5: Commit**

```bash
git add web/src
git commit -m "feat(web): banner for past days not yet closed

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: Payment split on the dashboard

**Files:**
- Modify: `web/src/history.ts`
- Modify: `web/src/screens/Dashboards.tsx`
- Modify: `web/src/i18n/en.json`, `hi.json`, `mr.json`
- Test: `web/src/__tests__/Dashboards.test.tsx`, `web/src/__tests__/history.test.ts`

**Interfaces:**
- Consumes: `payment_split_between` (Task 1); `PAYMENT_MODES`, `SplitMode` (Task 4); `close.creditNote` (Task 7).
- Produces: `paymentSplitBetween(range: Range)`, `type PaymentSplit = { mode: SplitMode; total: string | number; bill_count: string | number }`; i18n `dash.split`.

- [ ] **Step 1: Write the failing tests**

In `web/src/__tests__/history.test.ts`, add (following that file's existing `rpc` mock pattern for `collectedBetween`):

```ts
  it("asks payment_split_between for the same bounds as the other cards", async () => {
    await paymentSplitBetween({ from: "2026-09-01", to: "2026-09-30" });
    expect(rpc).toHaveBeenCalledWith("payment_split_between", {
      p_from: expect.any(String), p_to: expect.any(String),
    });
  });
```

(Add `paymentSplitBetween` to that file's import from `../history`.)

In `web/src/__tests__/Dashboards.test.tsx`, add a mock beside the others:

```ts
const paymentSplitBetween = vi.fn(async (..._a: unknown[]): Promise<{
  data: { mode: string; total: string; bill_count: string }[] | null;
  error: { code?: string; message?: string } | null;
}> => ({ data: [
  { mode: "cash", total: "200.00", bill_count: "1" },
  { mode: "credit", total: "40.00", bill_count: "1" },
  { mode: "upi", total: "110.50", bill_count: "1" },
], error: null }));
```

add `paymentSplitBetween: (...a: unknown[]) => paymentSplitBetween(...a),` to the `vi.mock("../history", ...)` object, and add:

```tsx
  it("splits the money collected by payment mode", async () => {
    render(<Dashboards />);
    expect((await screen.findByTestId("dash-split-cash")).textContent).toMatch(/200\.00/);
    expect(screen.getByTestId("dash-split-upi").textContent).toMatch(/110\.50/);
    expect(screen.getByTestId("dash-split-card").textContent).toMatch(/0\.00/);
    expect(screen.getByTestId("dash-split-credit").textContent).toMatch(/40\.00/);
    expect(screen.queryByTestId("dash-split-unrecorded")).toBeNull();
  });

  it("shows Not recorded only when there are such bills", async () => {
    paymentSplitBetween.mockResolvedValueOnce({
      data: [{ mode: "unrecorded", total: "90.00", bill_count: "2" }], error: null,
    });
    render(<Dashboards />);
    expect((await screen.findByTestId("dash-split-unrecorded")).textContent).toMatch(/90\.00/);
  });
```

(Match how the file's other tests render `Dashboards` — if they wrap it or set a language first, do the same.)

- [ ] **Step 2: Run to verify failure**

Run (in `web/`): `npm test`
Expected: FAIL — `paymentSplitBetween` not exported, `dash-split-*` missing.

- [ ] **Step 3: Implement**

In `web/src/history.ts`, add `import type { SplitMode } from "./payments";` and, after `collectedBetween`:

```ts
export type PaymentSplit = { mode: SplitMode; total: string | number; bill_count: string | number };

/** Money collected per payment mode, summed in SQL for the same reasons as collectedBetween.
 *  'unrecorded' is a done bill with no payment row -- completed before 0021. */
export async function paymentSplitBetween(range: Range) {
  const { fromTs, toTs } = toBounds(range);
  return supabase.rpc("payment_split_between", { p_from: fromTs, p_to: toTs });
}
```

In `web/src/screens/Dashboards.tsx`:
- Add `paymentSplitBetween, type PaymentSplit` to the `../history` import and `import { PAYMENT_MODES, type SplitMode } from "../payments";`
- State: `const [split, setSplit] = useState<Record<string, number>>({});`
- In `load`, add `paymentSplitBetween(r)` as a sixth entry of `Promise.all` (destructure as `byMode`), append `?? describeError(byMode.error)` to the `setProblem` chain, and after the voided lines:
  ```ts
  // numeric arrives as a string from PostgREST; Number() before it reaches rupees().
  setSplit(Object.fromEntries(
    ((byMode.data ?? []) as PaymentSplit[]).map((s) => [s.mode, Number(s.total)]),
  ));
  ```
- In the Collected `Card`, after the `dash-uncosted` paragraph:
  ```tsx
  <p className="mt-3 text-xs text-slate-500">{t("dash.split")}</p>
  <dl className="mt-1 text-sm grid grid-cols-2 gap-y-1">
    {([...PAYMENT_MODES, ...((split.unrecorded ?? 0) > 0 ? ["unrecorded"] : [])] as SplitMode[]).map((m) => (
      <div key={m} data-testid={`dash-split-${m}`} className="contents">
        <dt className="text-slate-500">
          {t(`pay.${m}`)}
          {m === "credit" && <span className="text-xs text-slate-400"> ({t("close.creditNote")})</span>}
        </dt>
        <dd className="text-right text-slate-700">{rupees(split[m] ?? 0)}</dd>
      </div>
    ))}
  </dl>
  ```

i18n — add to the `dash` object:
- en: `"split": "By payment mode"`
- hi: `"split": "भुगतान के तरीके से"`
- mr: `"split": "पैसे देण्याच्या पद्धतीनुसार"`

- [ ] **Step 4: Run tests and type check**

Run (in `web/`): `npm test` then `npx tsc --noEmit`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add web/src
git commit -m "feat(web): split money collected by payment mode on the dashboard

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 10: README and full verification

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Update the README**

In `README.md`:
- Change "all nineteen migrations" to "all twenty-one migrations" (check the current wording and count the files in `supabase/migrations/` — it must match).
- Add two bullets to the "Covered" list, after the "Platform owner" bullet:

```markdown
- **Payment mode.** `complete_bill()` refuses a missing or unknown mode and writes exactly
  one `bill_payments` row for the amount collected after points (zero when points cover the
  bill); a retry writes no second row; nobody can write the table directly and it does not
  leak across vendors. `payment_split_between` groups by mode, leaves voided bills out and
  reports bills completed before modes existed as `unrecorded`.

- **Day close.** `close_day()` admits admin and biller, computes expected cash on the
  server from cash payments only, needs a note when the count differs, and refuses a
  double close, a future date and a bad amount. While a date is closed `complete_bill` and
  `void_bill` refuse and `issue_token` does not; a retry of an already-done bill still
  succeeds; a completion waiting on a close in progress is refused once it commits.
  `reopen_day()` is admin only with a reason and keeps history. `unclosed_days()` ignores
  days before `vendors.day_close_from`. Clearing a shop's data removes its payments and
  closes.
```

- Update the `✅ Verified: N cases` heading and the matching sentence below it to the count `npm test` prints in Step 2.

- [ ] **Step 2: Run everything**

Run, each on its own, and read the exit status of each:
- Repo root: `npm test` — expected `N passed, 0 failed`, exit 0.
- `web/`: `npm test` — expected all files pass, exit 0.
- `web/`: `npx tsc --noEmit` — expected no output, exit 0.
- `web/`: `npm run build` — expected a successful Vite build.

Put the real DB count into the README heading from Step 1.

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs: README coverage for payment mode and day close

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

## Deploy notes (not a task — for whoever ships this)

- No Edge Function changes.
- **0021 and the web push must go out back to back.** From the moment 0021 is applied, the live (old) app cannot complete a bill — it does not send a mode. Apply 0021 on Cloud, then `git push` / merge immediately so Pages redeploys.
- `supabase db push` 401s on this machine unless `SUPABASE_ACCESS_TOKEN` is passed inline; 0021 can also be applied by hand in the SQL editor (confirm the project ref first), then recorded in `supabase_migrations.schema_migrations`.
