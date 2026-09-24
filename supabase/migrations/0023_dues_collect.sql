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

-- dues_list: 0022's body, with its running window put in credit_open's FIFO order (openings
-- first, then by time, ties by id). 0022 ordered by time alone, so an opening entered after
-- a credit bill counted as newer, and the list's "since" date contradicted Close day's
-- Credit line. Same return type, so create or replace.
create or replace function dues_list()
  returns table (customer_id uuid, name text, flat_no text, mobile text, balance numeric, oldest_unpaid date)
  language sql stable as $$
  with charges as (
    select b.customer_id, 1 as rank, b.completed_at as at, b.id as tie,
           (b.completed_at at time zone 'Asia/Kolkata')::date as day, p.amount
      from bills b join bill_payments p on p.bill_id = b.id
     where b.status = 'done' and p.mode = 'credit' and b.customer_id is not null
    union all
    select e.customer_id, 0, e.created_at, e.id, e.business_date, e.amount
      from dues_entries e
     where e.kind = 'opening' and e.reversed_at is null
  ), repaid as (
    select e.customer_id, sum(e.amount) as total
      from dues_entries e
     where e.kind = 'repayment' and e.reversed_at is null
     group by e.customer_id
  ), charged as (
    select c.customer_id, sum(c.amount) as total from charges c group by c.customer_id
  ), running as (
    select c.customer_id, c.day,
           sum(c.amount) over (partition by c.customer_id order by c.rank, c.at, c.tie
                               rows between unbounded preceding and current row) as upto
      from charges c
  ), bal as (
    select cu.id, cu.name, cu.flat_no, cu.mobile,
           coalesce(ch.total, 0) - coalesce(rp.total, 0) as balance,
           coalesce(rp.total, 0) as paid
      from customers cu
      left join charged ch on ch.customer_id = cu.id
      left join repaid rp on rp.customer_id = cu.id
  )
  select bal.id, bal.name, bal.flat_no, bal.mobile, bal.balance,
         case when bal.balance > 0 then
           (select min(r.day) from running r where r.customer_id = bal.id and r.upto > bal.paid)
         end
    from bal
   where bal.balance <> 0
   order by bal.balance desc, bal.name;
$$;

revoke all on function dues_list() from public, anon;
grant execute on function dues_list() to authenticated, service_role;

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
  -- The row list is additive; a zero row would only be noise, so omit it when nothing is open.
  select 'credit_open', coalesce(sum(co.open), 0), count(*) filter (where co.open > 0)
    from credit_open() co
    join bills b on b.id = co.bill_id
   where b.completed_at >= p_from
     and b.completed_at <  p_to
  having count(*) filter (where co.open > 0) > 0
  order by 1;
$$;

revoke all on function payment_split_between(timestamptz, timestamptz) from public, anon;
grant execute on function payment_split_between(timestamptz, timestamptz) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- complete_bill collects a previous due
-- ---------------------------------------------------------------------------

-- The signature grows, so DROP then CREATE, as in 0021. A caller that does not send
-- p_collect_due (a tab that has not reloaded) still resolves: it has a default.
drop function complete_bill(uuid, uuid, integer, text);

-- complete_bill: byte-for-byte 0022 except p_collect_due and the block that records it.
create function complete_bill(
  p_bill_id uuid,
  p_biller_id uuid default null,
  p_redeem_points integer default 0,
  -- Defaulted only because Postgres requires every parameter after a defaulted one to have
  -- a default too. A null is refused below.
  p_payment_mode text default null,
  -- 0023: an old due collected with this bill, as a repayment. 0 = none.
  p_collect_due numeric default 0
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

  -- Udhaar belongs to someone: a credit bill with no customer could never be collected
  -- through the app. After the idempotency guard, so a retry of a sale that already
  -- committed is still success.
  if p_payment_mode = 'credit' and v_bill.customer_id is null then
    raise exception 'credit needs a customer' using errcode = '22023';
  end if;

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

revoke all on function complete_bill(uuid, uuid, integer, text, numeric) from public, anon;
grant execute on function complete_bill(uuid, uuid, integer, text, numeric) to authenticated;
