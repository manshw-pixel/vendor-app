# Dues Follow-up (Credit That Shrinks When Paid, Collect Due With Next Bill) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Two changes:
- A day's Credit line shows only the credit still uncollected, and each mode line includes the dues received that day.
- A biller can collect a customer's previous due together with their next bill, in one server call.

**Architecture:** One migration, `0023_dues_collect.sql`, built over Tasks 1-2:
- **`credit_open()`:** an invoker-rights function that allocates each customer's repayments over their charges, FIFO, with opening balances first.
- **`day_summary` and `payment_split_between`:** gain uncollected-credit figures. Existing columns keep their meaning.
- **`complete_bill`:** gains `p_collect_due`, which writes a repayment linked to the bill in the same transaction.

The web merges the figures on Close day and the dashboard, adds the collect section to Pending, and prints the collected due on the receipt.

**Tech Stack:** Postgres 17 (Supabase Cloud; tests on native PostgreSQL via `tests/run.mjs`), plpgsql, React 19 + react-router 7 + i18next, Vitest 5 + Testing Library, TypeScript 7.

**Spec:** `docs/superpowers/specs/2026-09-24-dues-collect-design.md`

## Global Constraints

- Branch: `dues-collect`. Never commit to `main`. `0022_dues.sql` is **live**: never edit it; all DB changes go in `0023_dues_collect.sql`.
- DB suite: `npm test` at the repo root (currently 302/0). Web: `npm test` in `web/` (647). Type check: `npx tsc --noEmit` in `web/`. **Never pipe a test command, never use watch mode — the exit code is the gate.**
- Every calendar-day rule uses `(ts at time zone 'Asia/Kolkata')::date`.
- **FIFO order for allocation:** opening balances first (ordered by `created_at`), then credit bills by `completed_at`, ties broken by id. This settles the spec's "opening balances … allocated first" (the owner was told the khata opening is the oldest debt and is paid off first).
- Existing `day_summary` and `payment_split_between` columns/rows keep their meaning (cash/upi/card = sales only; credit = credit given). New figures are appended; the **web** merges.
- Read functions are invoker rights (`language sql stable`). Every function: `revoke all ... from public, anon;` then `grant execute ... to authenticated` (+ `service_role` on reads).
- Exact refusal messages: `'more than the balance'`, `'credit needs a customer'`, `'a due can only be collected in cash, upi or card'`, `'a due needs a signed-in biller'`, `'a due to collect must be zero or more, to the paisa'`.
- Every i18n key in `en.json`, `hi.json`, `mr.json` together; Hindi sentences end `।`, Marathi `.`; short labels no terminator. Keys removed from one are removed from all three.
- PostgREST `numeric` arrives as a string — `Number()` before arithmetic or `rupees()`.
- Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **A lost reply after collecting a due.** The retry must record the due once, not twice. Pinned in Task 2 ("a retry records nothing more").
2. **A collect that is refused (over the balance).** The bill must stay pending and nothing — no payment, no stock move, no repayment — is written. Pinned in Task 2.
3. **An old tab completing a bill** without `p_collect_due`. It still works exactly as before. Pinned in Task 2.
4. **A repayment after a day is closed.** That day's Credit falls; its stored close (expected/counted cash) does not change. Pinned in Task 1.
5. **An opening balance and credit bills on one customer.** A payment clears the opening before any bill. Pinned in Task 1.

---

## File Structure

| File | Responsibility |
|---|---|
| `supabase/migrations/0023_dues_collect.sql` (create) | `bill_id`, `credit_open`, `day_summary`, `payment_split_between` (T1); `complete_bill` (T2) |
| `tests/dues_collect.test.mjs` (create) + `tests/run.mjs` | DB tests |
| `web/src/dayClose.ts`, `screens/CloseDay.tsx` | Merged mode lines, credit-open line (T3) |
| `web/src/screens/Dashboards.tsx` | Merged split (T4) |
| `web/src/data.ts`, `screens/Pending.tsx`, `errors.ts` | Collect-due section (T5) |
| `web/src/receipt.ts`, `screens/Receipt.tsx` | Due paid + total collected (T6) |
| `web/src/i18n/{en,hi,mr}.json` | Keys per task |
| `README.md` | Coverage + count (T7) |

---

### Task 1: `bill_id`, `credit_open`, and the uncollected-credit figures

**Files:**
- Create: `supabase/migrations/0023_dues_collect.sql`
- Create: `tests/dues_collect.test.mjs`
- Modify: `tests/run.mjs` (add `import "./dues_collect.test.mjs";` after `import "./dues.test.mjs";`)

**Interfaces:**
- Produces: `dues_entries.bill_id uuid` (nullable); `credit_open() returns table (bill_id uuid, customer_id uuid, business_date date, amount numeric, open numeric)`; `day_summary(p_date)` with appended `credit_open numeric, credit_open_count bigint`; `payment_split_between(p_from, p_to)` with extra rows `dues_cash`, `dues_upi`, `dues_card`, `credit_open` (columns `mode, total, bill_count` unchanged).

- [ ] **Step 1: Write the failing tests**

Create `tests/dues_collect.test.mjs`:

```js
import { test, assert, assertEqual } from "./framework.mjs";
import { sql } from "./fixtures.mjs";
import { seedTwoVendors } from "./seed.mjs";

async function billedBill(v, { qty = 5, price = 40, customerId = v.customerId } = {}) {
  const { rows: [b] } = await sql(
    `insert into bills (vendor_id, customer_id, recorder_id, total, status)
     values ($1,$2,$3,0,'recording') returning id`, [v.vendorId, customerId, v.recorderId]);
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
const backdate = (id, days) =>
  sql(`update bills set completed_at = completed_at - ($2 || ' days')::interval where id = $1`, [id, String(days)]);
const kolkataDay = async (offset = 0) => (await sql(
  `select ((now() at time zone 'Asia/Kolkata')::date + $1::int)::text d`, [offset])).rows[0].d;
const repay = (client, customer, amount, mode = "cash") =>
  client.rpc("record_repayment", { p_customer: customer, p_amount: amount, p_mode: mode, p_note: null });
// credit_open() as superuser sees every vendor; filter to one.
const openOf = async (billId) =>
  Number((await sql(`select open from credit_open() where bill_id = $1`, [billId])).rows[0]?.open ?? NaN);

test("credit_open is FIFO: the opening is cleared first, then the oldest bill", async () => {
  const w = await seedTwoVendors();
  const a = await doneBill(w.a, "credit");                 // 200, two days ago
  await backdate(a, 2);
  const b = await doneBill(w.a, "credit", { qty: 2 });     // 80, yesterday
  await backdate(b, 1);
  await w.a.clients.admin.rpc("record_opening_balance",
    { p_customer: w.a.customerId, p_amount: 100, p_note: "khata" });   // entered today, still first
  await repay(w.a.clients.biller, w.a.customerId, 150);
  assertEqual([await openOf(a), await openOf(b)], [150, 80], "opening 100 cleared, then 50 off the oldest bill");
  await repay(w.a.clients.biller, w.a.customerId, 200);
  assertEqual([await openOf(a), await openOf(b)], [0, 30], "oldest bill cleared, then 50 off the next");
});

test("credit_open: overpaid customer is all zero; unassigned bill is fully open; voided bill is gone", async () => {
  const w = await seedTwoVendors();
  const kept = await doneBill(w.a, "credit", { qty: 1 });  // 40
  const voided = await doneBill(w.a, "credit");            // 200
  await repay(w.a.clients.biller, w.a.customerId, 150);
  await w.a.clients.biller.rpc("void_bill", { p_bill_id: voided, p_reason: "x" });   // paid 150 > owed 40
  assertEqual(await openOf(kept), 0, "overpaid");
  const { rows } = await sql(`select count(*)::int n from credit_open() where bill_id = $1`, [voided]);
  assertEqual(rows[0].n, 0, "a voided bill is not listed");
  const orphan = await doneBill(w.a, "credit", { qty: 2 }); // 80
  await sql(`update bills set customer_id = null where id = $1`, [orphan]);
  assertEqual(await openOf(orphan), 80, "an unassigned bill cannot be repaid, so it is fully open");
  const { data } = await w.b.clients.admin.rpc("credit_open");
  assertEqual(data, [], "B sees none of A's");
});

test("day_summary: credit_open falls as dues are paid, even after the day is closed; the close is untouched", async () => {
  const w = await seedTwoVendors();
  const bill = await doneBill(w.a, "credit");              // 200, yesterday
  await backdate(bill, 1);
  const yesterday = await kolkataDay(-1);
  const summary = async () => (await w.a.clients.biller.rpc("day_summary", { p_date: yesterday })).data[0];

  let s = await summary();
  assertEqual([Number(s.credit), Number(s.credit_count), Number(s.credit_open), Number(s.credit_open_count)],
    [200, 1, 200, 1], "before any payment");
  const { error: c } = await w.a.clients.biller.rpc("close_day", { p_date: yesterday, p_counted_cash: 0, p_note: null });
  assert(!c, c?.message);

  await repay(w.a.clients.biller, w.a.customerId, 50, "upi");
  s = await summary();
  assertEqual([Number(s.credit), Number(s.credit_open), Number(s.credit_open_count)], [200, 150, 1], "part paid");
  await repay(w.a.clients.biller, w.a.customerId, 150, "cash");
  s = await summary();
  assertEqual([Number(s.credit_open), Number(s.credit_open_count)], [0, 0], "fully paid");

  const { rows } = await sql(`select expected_cash, counted_cash from day_closes
                               where vendor_id = $1 and business_date = $2::date`, [w.a.vendorId, yesterday]);
  assertEqual([Number(rows[0].expected_cash), Number(rows[0].counted_cash)], [0, 0], "the closed count never moves");
});

test("payment_split_between adds dues by mode and uncollected credit", async () => {
  const w = await seedTwoVendors();
  await doneBill(w.a, "cash");                              // 200 cash sale
  await doneBill(w.a, "credit");                            // 200 credit
  await repay(w.a.clients.biller, w.a.customerId, 30, "upi");
  await repay(w.a.clients.biller, w.a.customerId, 20, "cash");
  const { data, error } = await w.a.clients.admin.rpc("payment_split_between",
    { p_from: new Date(Date.now() - 86400000).toISOString(), p_to: new Date(Date.now() + 86400000).toISOString() });
  assert(!error, error?.message);
  const by = Object.fromEntries(data.map((r) => [r.mode, [Number(r.total), Number(r.bill_count)]]));
  assertEqual(by.cash, [200, 1], "sales unchanged");
  assertEqual(by.credit, [200, 1], "credit given unchanged");
  assertEqual(by.dues_upi, [30, 1], "dues by upi");
  assertEqual(by.dues_cash, [20, 1], "dues by cash");
  assertEqual(by.credit_open, [150, 1], "uncollected credit");
});
```

Add to `tests/run.mjs` after `import "./dues.test.mjs";`:

```js
import "./dues_collect.test.mjs";
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test` (repo root). Expected: the four new cases FAIL (`function credit_open() does not exist`, `credit_open` undefined → NaN, `by.dues_upi` undefined); every other case passes.

- [ ] **Step 3: Write the migration**

Create `supabase/migrations/0023_dues_collect.sql`:

```sql
-- Dues follow-up: credit that shrinks when paid, and collecting a due with the next bill.
-- Spec: docs/superpowers/specs/2026-09-24-dues-collect-design.md

-- A repayment collected together with a bill (complete_bill's p_collect_due) remembers the
-- bill, so the slip can print it. SET NULL: clear_vendor_data deletes bills before it
-- deletes these entries; a void never deletes a bill.
alter table dues_entries add column bill_id uuid references bills(id) on delete set null;
create index dues_entries_bill_idx on dues_entries(bill_id) where bill_id is not null;

-- ---------------------------------------------------------------------------
-- Credit still uncollected, per credit bill
-- ---------------------------------------------------------------------------

-- Each customer's repayments allocated over their charges, FIFO: opening balances first
-- (the khata is the oldest debt), then credit bills by completion, ties by id. A bill's
-- `open` is what of it is still unpaid. Openings take part in the allocation but are not
-- returned. A credit bill with no customer cannot be repaid, so it is fully open. Invoker
-- rights: RLS scopes every row.
create function credit_open()
  returns table (bill_id uuid, customer_id uuid, business_date date, amount numeric, open numeric)
  language sql stable as $$
  with charges as (
    select b.id as bill_id, b.customer_id, 1 as rank, b.completed_at as at, b.id as tie,
           (b.completed_at at time zone 'Asia/Kolkata')::date as business_date, p.amount
      from bills b join bill_payments p on p.bill_id = b.id
     where b.status = 'done' and p.mode = 'credit' and b.customer_id is not null
    union all
    select null::uuid, e.customer_id, 0, e.created_at, e.id, e.business_date, e.amount
      from dues_entries e
     where e.kind = 'opening' and e.reversed_at is null
  ), paid as (
    select e.customer_id, sum(e.amount) as total
      from dues_entries e
     where e.kind = 'repayment' and e.reversed_at is null
     group by e.customer_id
  ), running as (
    select c.*,
           sum(c.amount) over (partition by c.customer_id order by c.rank, c.at, c.tie
                               rows between unbounded preceding and current row) as upto
      from charges c
  )
  select r.bill_id, r.customer_id, r.business_date, r.amount,
         greatest(0, least(r.amount, r.upto - coalesce(p.total, 0)))
    from running r
    left join paid p on p.customer_id = r.customer_id
   where r.bill_id is not null
  union all
  select b.id, null::uuid, (b.completed_at at time zone 'Asia/Kolkata')::date, p.amount, p.amount
    from bills b join bill_payments p on p.bill_id = b.id
   where b.status = 'done' and p.mode = 'credit' and b.customer_id is null;
$$;

revoke all on function credit_open() from public, anon;
grant execute on function credit_open() to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- day_summary: 0022's columns unchanged, credit_open appended
-- ---------------------------------------------------------------------------

-- The return type grows, so DROP then CREATE. Every 0022 column keeps its name, order and
-- meaning (cash/upi/card are sales only; credit is credit GIVEN), so a tab that has not
-- reloaded shows exactly what it showed before. The web merges dues into the mode lines.
drop function day_summary(date);

create function day_summary(p_date date default null)
  returns table (
    business_date    date,
    cash             numeric, cash_count       bigint,
    upi              numeric, upi_count        bigint,
    card             numeric, card_count       bigint,
    credit           numeric, credit_count     bigint,
    unrecorded       numeric, unrecorded_count bigint,
    expected_cash    numeric,
    pending_tokens   bigint,
    dues_cash        numeric, dues_cash_count  bigint,
    dues_upi         numeric, dues_upi_count   bigint,
    dues_card        numeric, dues_card_count  bigint,
    credit_open      numeric, credit_open_count bigint
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
  ), repaid as (
    select e.mode, e.amount
      from dues_entries e
     where e.kind = 'repayment' and e.reversed_at is null
       and e.business_date = (select day from d)
  ), s as (
    select coalesce(sum(amount) filter (where mode = 'cash'), 0)   as cash,   count(*) filter (where mode = 'cash')   as cash_count,
           coalesce(sum(amount) filter (where mode = 'upi'), 0)    as upi,    count(*) filter (where mode = 'upi')    as upi_count,
           coalesce(sum(amount) filter (where mode = 'card'), 0)   as card,   count(*) filter (where mode = 'card')   as card_count,
           coalesce(sum(amount) filter (where mode = 'credit'), 0) as credit, count(*) filter (where mode = 'credit') as credit_count,
           coalesce(sum(total) filter (where mode is null), 0)     as unrecorded, count(*) filter (where mode is null) as unrecorded_count
      from done
  ), r as (
    select coalesce(sum(amount) filter (where mode = 'cash'), 0) as dues_cash, count(*) filter (where mode = 'cash') as dues_cash_count,
           coalesce(sum(amount) filter (where mode = 'upi'), 0)  as dues_upi,  count(*) filter (where mode = 'upi')  as dues_upi_count,
           coalesce(sum(amount) filter (where mode = 'card'), 0) as dues_card, count(*) filter (where mode = 'card') as dues_card_count
      from repaid
  ), o as (
    select coalesce(sum(co.open), 0) as credit_open, count(*) filter (where co.open > 0) as credit_open_count
      from credit_open() co
     where co.business_date = (select day from d)
  )
  select (select day from d),
         s.cash, s.cash_count, s.upi, s.upi_count, s.card, s.card_count,
         s.credit, s.credit_count, s.unrecorded, s.unrecorded_count,
         s.cash + r.dues_cash,
         (select count(*) from bills where status = 'billed'),
         r.dues_cash, r.dues_cash_count, r.dues_upi, r.dues_upi_count, r.dues_card, r.dues_card_count,
         o.credit_open, o.credit_open_count
    from s, r, o;
$$;

revoke all on function day_summary(date) from public, anon;
grant execute on function day_summary(date) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- payment_split_between: 0021's rows unchanged, dues and uncollected credit appended
-- ---------------------------------------------------------------------------

-- Same return type, so create or replace. The old web keys rows by mode and renders only
-- the modes it knows, so the extra rows are invisible to it.
create or replace function payment_split_between(p_from timestamptz, p_to timestamptz)
  returns table (mode text, total numeric, bill_count bigint)
  language sql stable as $$
  select coalesce(p.mode, 'unrecorded')                as mode,
         coalesce(sum(coalesce(p.amount, b.total)), 0) as total,
         count(*)                                      as bill_count
    from bills b
    left join bill_payments p on p.bill_id = b.id
   where b.status = 'done'
     and b.completed_at >= p_from
     and b.completed_at <  p_to
   group by 1
  union all
  select 'dues_' || e.mode, sum(e.amount), count(*)
    from dues_entries e
   where e.kind = 'repayment' and e.reversed_at is null
     and e.created_at >= p_from
     and e.created_at <  p_to
   group by e.mode
  union all
  select 'credit_open', coalesce(sum(co.open), 0), count(*) filter (where co.open > 0)
    from credit_open() co
    join bills b on b.id = co.bill_id
   where b.completed_at >= p_from
     and b.completed_at <  p_to
  order by 1;
$$;

revoke all on function payment_split_between(timestamptz, timestamptz) from public, anon;
grant execute on function payment_split_between(timestamptz, timestamptz) to authenticated, service_role;
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test` (repo root). Expected: `N passed, 0 failed`, exit 0 — every existing `day_close`, `dues`, `analytics` case still passes.

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/0023_dues_collect.sql tests/dues_collect.test.mjs tests/run.mjs
git commit -m "feat(db): credit still uncollected, FIFO; day and range figures for it

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: `complete_bill` collects a previous due

**Files:**
- Modify: `supabase/migrations/0023_dues_collect.sql` (append)
- Modify: `tests/dues_collect.test.mjs` (append)

**Interfaces:**
- Consumes: `dues_entries.bill_id` (Task 1), `customer_due(uuid)` (0022).
- Produces: `complete_bill(p_bill_id uuid, p_biller_id uuid default null, p_redeem_points integer default 0, p_payment_mode text default null, p_collect_due numeric default 0) returns void`.

- [ ] **Step 1: Write the failing tests**

Append to `tests/dues_collect.test.mjs`:

```js
const due = async (customerId) =>
  Number((await sql(`select customer_due($1) d`, [customerId])).rows[0].d);
const complete = (client, bill, mode, collect) =>
  client.rpc("complete_bill", collect === undefined
    ? { p_bill_id: bill, p_payment_mode: mode }
    : { p_bill_id: bill, p_payment_mode: mode, p_collect_due: collect });

test("collecting a due with a bill: one repayment linked to the bill, counted in the day's cash", async () => {
  const w = await seedTwoVendors();
  await doneBill(w.a, "credit");                            // owes 200
  const bill = await billedBill(w.a);                       // new 200 bill
  const { error } = await complete(w.a.clients.biller, bill, "cash", 150);
  assert(!error, error?.message);
  const { rows } = await sql(`select kind, mode, amount, bill_id, created_by from dues_entries where vendor_id = $1`, [w.a.vendorId]);
  assertEqual(rows.map((r) => [r.kind, r.mode, Number(r.amount), r.bill_id, r.created_by]),
    [["repayment", "cash", 150, bill, w.a.billerId]], "one linked repayment");
  assertEqual(await due(w.a.customerId), 50, "balance after");
  const { data } = await w.a.clients.biller.rpc("day_summary", {});
  assertEqual([Number(data[0].cash), Number(data[0].dues_cash), Number(data[0].expected_cash)], [200, 150, 350],
    "the sale stays a sale; the due is a repayment; both are cash in the drawer");
});

test("a retry of a completed bill that collected a due records nothing more", async () => {
  const w = await seedTwoVendors();
  await doneBill(w.a, "credit");
  const bill = await billedBill(w.a);
  await complete(w.a.clients.biller, bill, "upi", 100);
  const { error } = await complete(w.a.clients.biller, bill, "upi", 100);
  assert(!error, `retry refused: ${error?.message}`);
  const { rows } = await sql(`select count(*)::int n from dues_entries where bill_id = $1`, [bill]);
  assertEqual(rows[0].n, 1, "recorded once");
});

test("a refused collect writes nothing: the bill stays pending", async () => {
  const w = await seedTwoVendors();
  await doneBill(w.a, "credit", { qty: 1 });                // owes 40
  const bill = await billedBill(w.a);
  const cases = [
    [40.01, "cash", /more than the balance/],
    [10, "credit", /can only be collected in cash, upi or card/],
    [1.005, "cash", /zero or more, to the paisa/],
    [-1, "cash", /zero or more, to the paisa/],
  ];
  for (const [amount, mode, re] of cases) {
    const { error } = await complete(w.a.clients.biller, bill, mode, amount);
    assert(error && re.test(error.message), `amount=${amount} mode=${mode}: ${error?.message ?? "success"}`);
  }
  const { rows: [b] } = await sql(`select status from bills where id = $1`, [bill]);
  assertEqual(b.status, "billed", "still pending");
  const { rows } = await sql(
    `select (select count(*) from dues_entries where vendor_id = $1 and kind = 'repayment')::int d,
            (select count(*) from bill_payments where bill_id = $2)::int p`, [w.a.vendorId, bill]);
  assertEqual(rows[0], { d: 0, p: 0 }, "nothing written");
});

test("a collect on a bill with no customer is refused", async () => {
  const w = await seedTwoVendors();
  const bill = await billedBill(w.a, { customerId: null });
  const { error } = await complete(w.a.clients.biller, bill, "cash", 10);
  assert(error && /credit needs a customer/.test(error.message), `got ${error?.message ?? "success"}`);
});

test("without p_collect_due (an old tab) or with 0, completion is unchanged and records no due", async () => {
  const w = await seedTwoVendors();
  await doneBill(w.a, "credit");
  const old = await billedBill(w.a);
  const { error: e1 } = await complete(w.a.clients.biller, old, "cash");
  assert(!e1, e1?.message);
  const zero = await billedBill(w.a);
  const { error: e2 } = await complete(w.a.clients.biller, zero, "card", 0);
  assert(!e2, e2?.message);
  const { rows } = await sql(`select count(*)::int n from dues_entries where vendor_id = $1`, [w.a.vendorId]);
  assertEqual(rows[0].n, 0, "no due recorded");
  assertEqual(await due(w.a.customerId), 200, "still owed");
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test` (repo root). Expected: the first four new cases FAIL (`p_collect_due` is not a known argument → function not found; the last case passes already).

- [ ] **Step 3: Append to the migration**

Append to `supabase/migrations/0023_dues_collect.sql`. The signature changes, so drop the 4-argument function first:

```sql
-- ---------------------------------------------------------------------------
-- complete_bill collects a previous due
-- ---------------------------------------------------------------------------

-- The signature grows, so DROP then CREATE, as in 0021. A caller that does not send
-- p_collect_due (a tab that has not reloaded) still resolves: it has a default.
drop function complete_bill(uuid, uuid, integer, text);
```

Then:
1. Copy the whole `create or replace function complete_bill(` … `end $$;` statement from `supabase/migrations/0022_dues.sql` (it starts at line 200 and ends at the `end $$;` just before `revoke all on function complete_bill(uuid, uuid, integer, text)`, line ~373) **verbatim**.
2. Change its first line to `create function complete_bill(`.
3. After the `p_payment_mode text default null` parameter, add a comma and the new parameter so the list ends:

```sql
  p_payment_mode text default null,
  -- 0023: an old due collected with this bill, as a repayment. 0 = none.
  p_collect_due numeric default 0
) returns void
```

4. Replace the copied header comment above it with:

```sql
-- complete_bill: byte-for-byte 0022 except p_collect_due and the block that records it.
```

5. Insert this block **immediately after** the day-closed check (the `if exists (select 1 from day_closes ... ) then raise exception 'day is closed' ... end if;` that follows the vendor `for share` lock), before `-- #3 (forgeable total)`:

```sql
  -- 0023: collect an old due with this sale. Recorded as a repayment, never a sale, in
  -- this same transaction -- so a refusal writes nothing, and a lost reply's retry returns
  -- at the idempotency guard above and can never record it twice.
  if p_collect_due is null or p_collect_due < 0 or p_collect_due <> round(p_collect_due, 2) then
    raise exception 'a due to collect must be zero or more, to the paisa' using errcode = '22023';
  end if;
  if p_collect_due > 0 then
    if p_payment_mode not in ('cash', 'upi', 'card') then
      raise exception 'a due can only be collected in cash, upi or card' using errcode = '22023';
    end if;
    if v_bill.customer_id is null then
      raise exception 'credit needs a customer' using errcode = '22023';
    end if;
    if coalesce(auth.uid(), p_biller_id) is null then
      raise exception 'a due needs a signed-in biller' using errcode = '22023';
    end if;
    -- Bill, then vendor (above), then customer: the same order as record_repayment's
    -- vendor-then-customer, so no lock cycle. The redemption path below takes the same
    -- customer lock again; a second lock on a row this transaction holds is a no-op.
    perform 1 from customers where id = v_bill.customer_id for update;
    -- Read before this bill counts -- and this bill is never credit here.
    if p_collect_due > customer_due(v_bill.customer_id) then
      raise exception 'more than the balance' using errcode = 'P0001';
    end if;
    insert into dues_entries (vendor_id, customer_id, kind, amount, mode, note, business_date,
                              created_by, bill_id)
    values (v_bill.vendor_id, v_bill.customer_id, 'repayment', p_collect_due, p_payment_mode, null,
            (now() at time zone 'Asia/Kolkata')::date, coalesce(auth.uid(), p_biller_id), p_bill_id);
  end if;
```

6. After the function, append:

```sql
revoke all on function complete_bill(uuid, uuid, integer, text, numeric) from public, anon;
grant execute on function complete_bill(uuid, uuid, integer, text, numeric) to authenticated;
```

After committing, diff your function body against 0022's (extract both to temp files outside the repo) and put the diff in your report: it must show only the header comment, `create`, the new parameter and the inserted block.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test` (repo root). Expected: `N passed, 0 failed`, exit 0 — every existing `complete_bill`, `payments`, `day_close`, `dues`, `redemption` case still passes.

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/0023_dues_collect.sql tests/dues_collect.test.mjs
git commit -m "feat(db): complete_bill collects a previous due in the same transaction

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Close day — dues merged into the mode lines, Credit is what is uncollected

**Files:**
- Modify: `web/src/dayClose.ts`
- Modify: `web/src/screens/CloseDay.tsx`
- Modify: `web/src/i18n/en.json`, `hi.json`, `mr.json`
- Test: `web/src/__tests__/CloseDay.test.tsx`, `web/src/__tests__/dayClose.test.ts`

**Interfaces:**
- Consumes: `day_summary` columns `credit_open`, `credit_open_count` (Task 1).
- Produces: `DaySummary.creditOpen: { total: number; count: number }`.

- [ ] **Step 1: Write the failing tests**

In `web/src/__tests__/dayClose.test.ts`, inside the existing `describe("loadDaySummary", ...)` (it already mocks `../supabase` with an `rpc` spy), add:

```ts
  it("coerces the uncollected credit", async () => {
    rpc.mockResolvedValue({ data: [{ business_date: "2026-09-24", credit: "200", credit_count: "1",
      credit_open: "150.00", credit_open_count: "1" }], error: null });
    const { data } = await loadDaySummary();
    expect(data?.creditOpen).toEqual({ total: 150, count: 1 });
  });
```

In `web/src/__tests__/CloseDay.test.tsx`:
- Add `creditOpen: { total: 150, count: 1 },` to `SUMMARY` (its `credit` split is `{ total: 150, count: 1 }`, so every existing credit assertion still holds).
- **Delete** the two tests that assert the old separate dues lines: the one containing `close-dues-upi` / `close-dues-card` (it also checks `close-expected-breakdown`) — replace it with the first test below — and `"counts repayments as payments, not bills"`.
- Add:

```tsx
  it("merges dues into the mode lines, with a note, and keeps the cash breakdown", async () => {
    loadDaySummary.mockResolvedValue({ data: {
      ...SUMMARY, expected_cash: 1500,
      dues: { cash: { total: 300, count: 2 }, upi: { total: 100, count: 1 }, card: { total: 0, count: 0 } },
    }, error: null });
    renderAs("biller");
    const cash = (await screen.findByTestId("close-split-cash")).textContent ?? "";
    expect(cash).toMatch(/1,500\.00/);                       // 1200 sales + 300 dues
    expect(cash).toMatch(/6 bills, 2 payments/);
    expect(screen.getByTestId("close-incl-cash").textContent).toMatch(/incl\..*300\.00.*dues/);
    expect(screen.getByTestId("close-split-upi").textContent).toMatch(/900\.00/);
    expect(screen.queryByTestId("close-incl-card")).toBeNull();
    expect(screen.queryByTestId("close-dues-cash")).toBeNull();
    const breakdown = screen.getByTestId("close-expected-breakdown").textContent ?? "";
    expect(breakdown).toMatch(/Cash sales.*1,200\.00/);
    expect(breakdown).toMatch(/Dues received in cash.*300\.00/);
  });

  it("shows credit still uncollected, not credit given", async () => {
    loadDaySummary.mockResolvedValue({ data: {
      ...SUMMARY, split: { ...SUMMARY.split, credit: { total: 500, count: 3 } }, creditOpen: { total: 0, count: 0 },
    }, error: null });
    renderAs("biller");
    const credit = (await screen.findByTestId("close-split-credit")).textContent ?? "";
    expect(credit).toMatch(/0\.00/);
    expect(credit).not.toMatch(/500\.00/);
    expect(credit).toMatch(/not yet collected/i);
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test` in `web/`. Expected: FAIL — `creditOpen` undefined, `close-incl-cash` missing, credit still shows 500.

- [ ] **Step 3: Implement**

In `web/src/dayClose.ts`, add to the `DaySummary` type:

```ts
  /** Credit given that day that is still uncollected, as of now (0023). Falls as the
   *  customer pays, FIFO -- even after the day is closed. */
  creditOpen: { total: number; count: number };
```

and to the object `loadDaySummary` returns:

```ts
      creditOpen: { total: num(r.credit_open), count: num(r.credit_open_count) },
```

In `web/src/screens/CloseDay.tsx`, replace the split `<dl>` block (the `[...PAYMENT_MODES, ...]` map rendering `close-split-${m}`) **and** the following `REPAY_MODES.some(...)` dues `<dl>` block with:

```tsx
          <dl className="grid grid-cols-[1fr_auto_auto] gap-x-3 gap-y-1 text-sm">
            {[...PAYMENT_MODES, ...(summary.split.unrecorded.count > 0 ? ["unrecorded" as const] : [])].map((m) => {
              // Dues received today count under the mode they were paid in; Credit is what of
              // today's credit is still uncollected. The server keeps both apart (0023).
              const dues = m === "cash" || m === "upi" || m === "card" ? summary.dues[m] : null;
              const total = m === "credit" ? summary.creditOpen.total : summary.split[m].total + (dues?.total ?? 0);
              const bills = m === "credit" ? summary.creditOpen.count : summary.split[m].count;
              return (
                <div key={m} data-testid={`close-split-${m}`} className="contents">
                  <dt className="text-slate-600">
                    {t(`pay.${m}`)}
                    {m === "credit" && <span className="text-xs text-slate-400"> ({t("close.creditNote")})</span>}
                    {dues && dues.total > 0 && (
                      <span data-testid={`close-incl-${m}`} className="block text-xs text-slate-400">
                        {t("close.inclDues", { amount: rupees(dues.total) })}
                      </span>
                    )}
                  </dt>
                  <dd className="text-slate-500 text-right">
                    {dues && dues.count > 0
                      ? t("close.billsAndPayments", { bills, payments: dues.count })
                      : t("close.bills", { n: bills })}
                  </dd>
                  <dd className="text-slate-800 text-right">{rupees(total)}</dd>
                </div>
              );
            })}
          </dl>
```

Remove `REPAY_MODES` from the `../payments` import if it is now unused. Keep the `close-expected-breakdown` paragraph unchanged.

i18n — in each locale's `close` object **remove** `duesMode` and `payments` (no longer used; grep `web/src` to confirm), and **add**:

- `en`: `"billsAndPayments": "{{bills}} bills, {{payments}} payments"`, `"inclDues": "incl. {{amount}} dues"`
- `hi`: `"billsAndPayments": "{{bills}} बिल, {{payments}} भुगतान"`, `"inclDues": "{{amount}} उधार वसूली सहित"`
- `mr`: `"billsAndPayments": "{{bills}} बिले, {{payments}} पेमेंट"`, `"inclDues": "{{amount}} उधारी वसुलीसह"`

- [ ] **Step 4: Run tests to verify they pass**

Run in `web/`: `npm test`, then `npx tsc --noEmit`. Expected: both exit 0.

- [ ] **Step 5: Commit**

```bash
git add web/src/dayClose.ts web/src/screens/CloseDay.tsx web/src/i18n web/src/__tests__/CloseDay.test.tsx web/src/__tests__/dayClose.test.ts
git commit -m "feat(web): Close day merges dues into the mode lines; credit shows what is uncollected

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Dashboard — the same merge for the selected range

**Files:**
- Modify: `web/src/screens/Dashboards.tsx`
- Test: `web/src/__tests__/Dashboards.test.tsx`

**Interfaces:**
- Consumes: `payment_split_between` rows `dues_cash`, `dues_upi`, `dues_card`, `credit_open` (Task 1). The screen already keys rows into `split: Record<string, number>` by `mode`.

- [ ] **Step 1: Write the failing test**

In `web/src/__tests__/Dashboards.test.tsx`, append inside the top-level `describe`:

```tsx
  it("merges dues into the split and shows credit still uncollected", async () => {
    paymentSplitBetween.mockResolvedValueOnce({ data: [
      { mode: "cash", total: "200.00", bill_count: "1" },
      { mode: "credit", total: "40.00", bill_count: "1" },
      { mode: "credit_open", total: "10.00", bill_count: "1" },
      { mode: "dues_cash", total: "30.00", bill_count: "1" },
      { mode: "upi", total: "110.50", bill_count: "1" },
    ], error: null });
    render(<Dashboards />);
    await waitFor(() => expect(screen.getByTestId("dash-split-cash").textContent).toMatch(/230\.00/));
    expect(screen.getByTestId("dash-incl-cash").textContent).toMatch(/30\.00/);
    expect(screen.getByTestId("dash-split-credit").textContent).toMatch(/10\.00/);
    expect(screen.getByTestId("dash-split-credit").textContent).not.toMatch(/40\.00/);
    expect(screen.getByTestId("dash-split-upi").textContent).toMatch(/110\.50/);
    expect(screen.queryByTestId("dash-incl-upi")).toBeNull();
  });
```

(If an existing test asserts the Credit line shows the `credit` row's total, update its fixture to add a matching `credit_open` row and keep its assertion.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test` in `web/`. Expected: FAIL — cash shows 200.00, no `dash-incl-cash`.

- [ ] **Step 3: Implement**

In `web/src/screens/Dashboards.tsx`, replace the split `<dl>`'s map body (the `(([...PAYMENT_MODES, ...]) as SplitMode[]).map((m) => ( ... ))`) with:

```tsx
            {([...PAYMENT_MODES, ...((split.unrecorded ?? 0) > 0 ? ["unrecorded"] : [])] as SplitMode[]).map((m) => {
              // Dues received in the range count under their mode; Credit is what of the
              // range's credit is still uncollected (0023). The server returns them apart.
              const dues = split[`dues_${m}`] ?? 0;
              const total = m === "credit" ? (split.credit_open ?? 0) : (split[m] ?? 0) + dues;
              return (
                <div key={m} data-testid={`dash-split-${m}`} className="contents">
                  <dt className="text-slate-500">
                    {t(`pay.${m}`)}
                    {m === "credit" && <span className="text-xs text-slate-400"> ({t("close.creditNote")})</span>}
                    {m !== "credit" && dues > 0 && (
                      <span data-testid={`dash-incl-${m}`} className="block text-xs text-slate-400">
                        {t("close.inclDues", { amount: rupees(dues) })}
                      </span>
                    )}
                  </dt>
                  <dd className="text-right text-slate-700">{rupees(total)}</dd>
                </div>
              );
            })}
```

- [ ] **Step 4: Run tests to verify they pass**

Run in `web/`: `npm test`, then `npx tsc --noEmit`. Expected: both exit 0.

- [ ] **Step 5: Commit**

```bash
git add web/src/screens/Dashboards.tsx web/src/__tests__/Dashboards.test.tsx
git commit -m "feat(web): dashboard split merges dues and shows credit still uncollected

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Pending — "Also collect previous due"

**Files:**
- Modify: `web/src/data.ts` (`completeBill`)
- Modify: `web/src/screens/Pending.tsx`
- Modify: `web/src/errors.ts`
- Modify: `web/src/i18n/en.json`, `hi.json`, `mr.json`
- Test: `web/src/__tests__/Pending.test.tsx`, `web/src/__tests__/errors.test.ts`, `web/src/__tests__/data.test.ts` (if it covers `completeBill`)

**Interfaces:**
- Consumes: `complete_bill(..., p_collect_due)` (Task 2); `owes` state already in Pending (from `loadCustomerDue`); `parseAmount` from `../duesRules`.
- Produces: `completeBill(billId: string, mode: PaymentMode, redeemPoints?: number, collectDue?: number)` — sends `p_collect_due` only when `collectDue > 0`.

- [ ] **Step 1: Write the failing tests**

In `web/src/__tests__/Pending.test.tsx`, append (the file already mocks `../dues` with `loadCustomerDue` and `../data` with `completeBill`):

```tsx
describe("collecting a previous due with the bill", () => {
  it("offers it only when they owe and the mode is not Credit, pre-filled with what they owe", async () => {
    loadCustomerDue.mockResolvedValueOnce({ data: 1240, error: null });
    renderPending({ role: "biller" });
    fireEvent.click(await screen.findByTestId("pending-complete-b1"));
    await screen.findByTestId("pending-owes");
    expect(screen.queryByTestId("pending-collect")).toBeNull();          // no mode yet
    fireEvent.click(screen.getByTestId("pay-mode-credit"));
    expect(screen.queryByTestId("pending-collect")).toBeNull();          // credit: hidden
    fireEvent.click(screen.getByTestId("pay-mode-cash"));
    const box = screen.getByTestId("pending-collect") as HTMLInputElement;
    expect(box.checked).toBe(false);
    fireEvent.click(box);
    expect(screen.getByTestId("pending-collect-amount")).toHaveProperty("value", "1240");
  });

  it("sends the due and shows the combined total on the button", async () => {
    loadCustomerDue.mockResolvedValueOnce({ data: 1240, error: null });
    renderPending({ role: "biller" });
    fireEvent.click(await screen.findByTestId("pending-complete-b1"));
    await screen.findByTestId("pending-owes");
    fireEvent.click(screen.getByTestId("pay-mode-upi"));
    fireEvent.click(screen.getByTestId("pending-collect"));
    fireEvent.change(screen.getByTestId("pending-collect-amount"), { target: { value: "240" } });
    const confirm = screen.getByTestId("pending-confirm-b1");
    expect(confirm.textContent).toMatch(/Collect ₹740\.00/);            // 500 bill + 240 due
    fireEvent.click(confirm);
    await waitFor(() => expect(completeBill).toHaveBeenCalledWith("b1", "upi", 0, 240));
  });

  it("will not send more than they owe", async () => {
    loadCustomerDue.mockResolvedValueOnce({ data: 100, error: null });
    renderPending({ role: "biller" });
    fireEvent.click(await screen.findByTestId("pending-complete-b1"));
    await screen.findByTestId("pending-owes");
    fireEvent.click(screen.getByTestId("pay-mode-cash"));
    fireEvent.click(screen.getByTestId("pending-collect"));
    fireEvent.change(screen.getByTestId("pending-collect-amount"), { target: { value: "100.01" } });
    expect(screen.getByTestId("pending-confirm-b1")).toHaveProperty("disabled", true);
    expect(screen.getByText(/more than they owe/)).toBeTruthy();
  });

  it("an unticked box sends no due, exactly as before", async () => {
    loadCustomerDue.mockResolvedValueOnce({ data: 100, error: null });
    renderPending({ role: "biller" });
    fireEvent.click(await screen.findByTestId("pending-complete-b1"));
    await screen.findByTestId("pending-owes");
    fireEvent.click(screen.getByTestId("pay-mode-cash"));
    fireEvent.click(screen.getByTestId("pending-confirm-b1"));
    await waitFor(() => expect(completeBill).toHaveBeenCalledWith("b1", "cash", 0));
  });
});
```

In `web/src/__tests__/errors.test.ts`, add inside the existing describe:

```ts
  it("maps a due collected on the wrong mode", () => {
    expect(describeError({ message: "a due can only be collected in cash, upi or card", code: "22023" })?.key)
      .toBe("dues.collectModeOnly");
  });
```

If `web/src/__tests__/data.test.ts` tests `completeBill`, add a case asserting `completeBill("b1", "cash", 0, 240)` calls `rpc("complete_bill", { p_bill_id: "b1", p_payment_mode: "cash", p_collect_due: 240 })` and that a `collectDue` of `0` or `undefined` sends no `p_collect_due` key.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test` in `web/`. Expected: FAIL — `pending-collect` missing, errors test gets `error.unknown`.

- [ ] **Step 3: Implement**

In `web/src/data.ts`, change `completeBill`:

```ts
export async function completeBill(billId: string, mode: PaymentMode, redeemPoints?: number, collectDue?: number) {
  const args: Record<string, unknown> = { p_bill_id: billId, p_payment_mode: mode };
  if (redeemPoints && redeemPoints > 0) args.p_redeem_points = redeemPoints;
  // 0023: an old due collected with this sale, recorded as a repayment in the same
  // transaction. Omitted when zero, so the call is byte-identical to before.
  if (collectDue && collectDue > 0) args.p_collect_due = collectDue;
  return supabase.rpc("complete_bill", args);
}
```

(Update its doc comment's last sentence to mention `p_collect_due` and 0023.)

In `web/src/screens/Pending.tsx`:

Add `import { parseAmount } from "../duesRules";`.

Add state beside `owes`:

```tsx
  // "Also collect previous due" (0023): unticked by default, pre-filled with what they owe.
  const [collect, setCollect] = useState(false);
  const [collectInput, setCollectInput] = useState("");
```

In `openConfirm`, next to `setOwes(null);`, add `setCollect(false); setCollectInput("");`. After `setOwes(...)` at the end of `openConfirm`, add:

```tsx
    if (due.data !== null && due.data > 0) setCollectInput(String(due.data));
```

In the confirm dialog's render function (the IIFE that computes `points` and `net`), after `const net = bill.total - points;` add:

```tsx
        const collectParsed = parseAmount(collectInput);
        const collecting = collect && owes !== null && mode !== null && mode !== "credit";
        const collectOver = collecting && collectParsed.ok && collectParsed.value > (owes ?? 0);
        const collectValid = collecting && collectParsed.ok && !collectOver;
        const collectAmount = collectValid && collectParsed.ok ? collectParsed.value : 0;
```

After the `</fieldset>` (and its credit hint) and before the confirm button, add:

```tsx
              {owes !== null && mode !== null && mode !== "credit" && (
                <div className="space-y-1">
                  <label className="flex items-center gap-2 text-sm text-slate-700 min-h-[44px]">
                    <input type="checkbox" data-testid="pending-collect" checked={collect}
                           onChange={(e) => setCollect(e.target.checked)} />
                    {t("pending.collectDue")}
                  </label>
                  {collect && (
                    <>
                      <label className="block text-sm text-slate-700">
                        {t("pending.collectAmount")}
                        <input data-testid="pending-collect-amount" inputMode="decimal" value={collectInput}
                               onChange={(e) => setCollectInput(e.target.value)}
                               className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 min-h-[44px]" />
                      </label>
                      {collectInput.trim() !== "" && !collectParsed.ok && (
                        <p className="text-xs text-red-700">{t("dues.badAmount")}</p>
                      )}
                      {collectOver && <p className="text-xs text-red-700">{t("dues.overBalanceHint")}</p>}
                    </>
                  )}
                </div>
              )}
```

Change the confirm button's `onClick`, `disabled` and label:

```tsx
                onClick={() => void confirm(bill, collectAmount)}
                disabled={mode === null || (collecting && !collectValid)}
              >
                {mode === "credit"
                  ? t("pending.confirmCredit")
                  : collectAmount > 0
                    ? t("pending.collectTotal", { amount: rupees(net + collectAmount) })
                    : t("pending.confirmAccept")}
```

Change `confirm`'s signature to `async function confirm(bill: PendingBill, collectDue = 0)` and the call inside it to:

```tsx
    const { error } = collectDue > 0
      ? await completeBill(id, chosen, points, collectDue)
      : await completeBill(id, chosen, points);
```

In `web/src/errors.ts`, next to the other dues mappings:

```ts
  if (/due can only be collected/i.test(detail)) return { key: "dues.collectModeOnly", detail };
```

i18n — add to each locale's `pending` object: `collectDue`, `collectAmount`, `collectTotal`; to `dues`: `collectModeOnly`:

- `en`: `"collectDue": "Also collect previous due"`, `"collectAmount": "Due to collect"`, `"collectTotal": "Collect {{amount}}"`; `"collectModeOnly": "A due can only be collected in cash, UPI or card."`
- `hi`: `"collectDue": "पिछला बकाया भी लें"`, `"collectAmount": "लेने वाला बकाया"`, `"collectTotal": "{{amount}} लें"`; `"collectModeOnly": "बकाया सिर्फ़ नकद, UPI या कार्ड से लिया जा सकता है।"`
- `mr`: `"collectDue": "मागील थकबाकीही घ्या"`, `"collectAmount": "घ्यायची थकबाकी"`, `"collectTotal": "{{amount}} घ्या"`; `"collectModeOnly": "थकबाकी फक्त रोख, UPI किंवा कार्डने घेता येते."`

- [ ] **Step 4: Run tests to verify they pass**

Run in `web/`: `npm test`, then `npx tsc --noEmit`. Expected: both exit 0; every earlier Pending case still passes (their `completeBill` assertions are 3-argument).

- [ ] **Step 5: Commit**

```bash
git add web/src/data.ts web/src/screens/Pending.tsx web/src/errors.ts web/src/i18n web/src/__tests__/Pending.test.tsx web/src/__tests__/errors.test.ts web/src/__tests__/data.test.ts
git commit -m "feat(web): collect a previous due with the bill on Pending

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

(Drop `data.test.ts` from `git add` if you did not change it.)

---

### Task 6: Receipt — previous due paid and total collected

**Files:**
- Modify: `web/src/receipt.ts`
- Modify: `web/src/screens/Receipt.tsx`
- Modify: `web/src/i18n/en.json`, `hi.json`, `mr.json`
- Test: `web/src/__tests__/receipt.test.ts`, `web/src/__tests__/Receipt.test.tsx`

**Interfaces:**
- Consumes: `dues_entries.bill_id` (Task 1).
- Produces: `Receipt.due_collected: number` (0 when none).

Deviation from the spec (recorded): the due is read with its own query (`from("dues_entries").select("amount").eq("bill_id", id).is("reversed_at", null)`) rather than an embed with a foreign-key hint, matching how `receipt.ts` already reads `bill_items` and `points_ledger`.

- [ ] **Step 1: Write the failing tests**

In `web/src/__tests__/receipt.test.ts`:
- Add `dues: [] as Row[]` to `responses`, and reset `responses.dues = [];` in `beforeEach`.
- Add `"is"` to the method list in `make` (`["select", "eq", "in", "gt", "is", "order", "limit"]`).
- In `make`'s `then`, return the dues rows for that table:

```ts
    const data = table === "bill_items" ? responses.lines
      : table === "dues_entries" ? responses.dues
      : responses.ledger;
```

- Add:

```ts
  it("reports a due collected with the bill, reversed ones excluded by the query", async () => {
    responses.dues = [{ amount: "240.00" }];
    const { data } = await loadReceipt("b1");
    expect(data?.due_collected).toBe(240);
    expect(captured.tables).toContain("dues_entries");
  });

  it("reports no due when none was collected", async () => {
    const { data } = await loadReceipt("b1");
    expect(data?.due_collected).toBe(0);
  });
```

In `web/src/__tests__/Receipt.test.tsx`, add `due_collected: 0,` to the `FULL` fixture (after `payment_mode: null,`, so `tsc` passes), then add inside `describe("Receipt", ...)`:

```tsx
  it("prints the previous due paid and the total collected", async () => {
    await i18n.changeLanguage("en");
    loadReceipt.mockResolvedValue({ data: { ...FULL, payment_mode: "cash", due_collected: 240 }, error: null });
    renderAt();
    expect((await screen.findByTestId("receipt-due-paid")).textContent).toMatch(/Previous due paid.*240\.00/);
    expect(screen.getByTestId("receipt-total-collected").textContent).toMatch(/Total collected.*406\.00/);
    expect(screen.getByTestId("receipt-paid").textContent).toMatch(/166\.00/);   // the sale is unchanged
  });

  it("prints neither line when no due was collected", async () => {
    await i18n.changeLanguage("en");
    loadReceipt.mockResolvedValue({ data: { ...FULL, payment_mode: "cash" }, error: null });
    renderAt();
    await screen.findByTestId("receipt-paid");
    expect(screen.queryByTestId("receipt-due-paid")).toBeNull();
    expect(screen.queryByTestId("receipt-total-collected")).toBeNull();
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test` in `web/`. Expected: FAIL — `due_collected` undefined, `receipt-due-paid` missing.

- [ ] **Step 3: Implement**

In `web/src/receipt.ts`, add to the `Receipt` type:

```ts
  /** An old due collected together with this bill (0023), un-reversed; 0 when none. It is a
   *  repayment, not part of the sale, so it is printed after "Paid", never in the total. */
  due_collected: number;
```

After the `points_ledger` read and its error check, add:

```ts
  const { data: dueRows, error: dueError } = await supabase
    .from("dues_entries")
    .select("amount")
    .eq("bill_id", billId)
    .is("reversed_at", null);

  if (dueError) return { data: null, error: dueError };
```

and in the returned object:

```ts
    due_collected: ((dueRows ?? []) as { amount: string | number }[]).reduce((s, r) => s + num(r.amount), 0),
```

In `web/src/screens/Receipt.tsx`, inside the non-credit branch, after the `receipt-mode` block (still inside the fragment), add:

```tsx
            {data.due_collected > 0 && (
              <>
                <div data-testid="receipt-due-paid" className="flex justify-between">
                  <span>{t("receipt.duePaid")}</span>
                  <span>{amt(data.due_collected)}</span>
                </div>
                <div data-testid="receipt-total-collected" className="flex justify-between font-bold">
                  <span>{t("receipt.totalCollected")}</span>
                  <span>{amt(data.net + data.due_collected)}</span>
                </div>
              </>
            )}
```

i18n — add to each locale's `receipt` object:

- `en`: `"duePaid": "Previous due paid"`, `"totalCollected": "Total collected"`
- `hi`: `"duePaid": "पिछला बकाया चुकाया"`, `"totalCollected": "कुल प्राप्त"`
- `mr`: `"duePaid": "मागील थकबाकी भरली"`, `"totalCollected": "एकूण मिळाले"`

- [ ] **Step 4: Run tests to verify they pass**

Run in `web/`: `npm test`, then `npx tsc --noEmit`. Expected: both exit 0.

- [ ] **Step 5: Commit**

```bash
git add web/src/receipt.ts web/src/screens/Receipt.tsx web/src/i18n web/src/__tests__/receipt.test.ts web/src/__tests__/Receipt.test.tsx
git commit -m "feat(web): the slip prints a due collected with the bill and the total collected

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: README and full verification

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Update the README**

- Change "all twenty-two migrations" to "all twenty-three migrations" (count the files in `supabase/migrations/` — it must match).
- Add after the "Dues (udhaar)" bullet in the "Covered" list:

```markdown
- **Collecting dues.** `credit_open()` allocates each customer's repayments over their
  charges FIFO — opening balances first, then credit bills by completion — so a day's
  uncollected credit falls when the customer pays, even after that day is closed, while the
  stored close never moves. `day_summary` and `payment_split_between` keep their existing
  figures and add uncollected credit and dues by mode. `complete_bill`'s `p_collect_due`
  records an old due as a repayment linked to the bill in the same transaction: a retry
  records it once, a refusal (over the balance, Credit mode, no customer, sub-paisa) writes
  nothing, and a call without it behaves exactly as before.
```

- Update the `✅ Verified: N cases` heading and the matching sentence below it to the count `npm test` prints in Step 2.

- [ ] **Step 2: Run everything**

Run, each on its own, reading each exit status:
- Repo root: `npm test` — `N passed, 0 failed`, exit 0.
- `web/`: `npm test` — all pass, exit 0.
- `web/`: `npx tsc --noEmit` — exit 0.
- `web/`: `npm run build` — success.

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs: README coverage for collecting dues

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

## Deploy notes (not a task — for whoever ships this)

- No Edge Function changes.
- Apply 0023 in the SQL editor (confirm project ref `cnnqidkmcxkgwxnulvig`), record `('0023', 'dues_collect')` in `supabase_migrations.schema_migrations`, then merge. Tabs not yet reloaded keep working: every existing column and row keeps its meaning, and `complete_bill` defaults the new argument.
- Smoke test: collect a due with a cash bill (slip prints both lines); Close day shows the cash line "incl. ₹X dues"; an older credit day's Credit line falls after a repayment.
