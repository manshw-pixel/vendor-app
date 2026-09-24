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
