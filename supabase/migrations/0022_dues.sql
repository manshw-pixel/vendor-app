-- Dues (udhaar): opening balances, repayments and reversals.
-- Spec: docs/superpowers/specs/2026-09-24-dues-design.md

-- ---------------------------------------------------------------------------
-- Entries
-- ---------------------------------------------------------------------------

-- Only what bills do not already record. A credit CHARGE is a done bill with a 'credit'
-- bill_payments row; it is never copied here, so a void needs no second write.
create table dues_entries (
  id             uuid primary key default gen_random_uuid(),
  vendor_id      uuid not null references vendors(id) on delete cascade,
  -- No ON DELETE: only clear_vendor_data deletes customers, and it deletes these first.
  customer_id    uuid not null references customers(id),
  kind           text not null check (kind in ('opening', 'repayment')),
  amount         numeric(10,2) not null check (amount > 0),
  mode           text check (mode in ('cash', 'upi', 'card')),
  note           text,
  -- The Asia/Kolkata date the entry was made: the day whose cash a repayment belongs to.
  business_date  date not null,
  created_by     uuid not null references app_users(id),
  created_at     timestamptz not null default now(),
  reversed_at    timestamptz,
  reversed_by    uuid references app_users(id),
  reverse_reason text,
  constraint dues_entries_mode_iff_repayment check ((kind = 'repayment') = (mode is not null)),
  constraint dues_entries_opening_note check (kind <> 'opening' or length(btrim(coalesce(note, ''))) > 0),
  constraint dues_entries_reverse_stamps check (
    (reversed_at is null and reversed_by is null and reverse_reason is null)
    or (reversed_at is not null and reversed_by is not null
        and length(btrim(coalesce(reverse_reason, ''))) > 0)
  )
);
create index dues_entries_customer_idx on dues_entries(vendor_id, customer_id);
create index dues_entries_day_idx on dues_entries(vendor_id, business_date) where kind = 'repayment';

alter table dues_entries enable row level security;

-- Read for every role in the shop. No write policy: the functions below are the only writers.
create policy dues_entries_read on dues_entries for select to authenticated
  using (vendor_id = current_vendor_id());

-- ---------------------------------------------------------------------------
-- The balance: the ONE definition every reader and writer uses
-- ---------------------------------------------------------------------------

-- Credit bills still done, plus openings, minus repayments; reversed entries ignored.
-- Negative means overpaid (a credit bill voided after a part-payment). Invoker rights: a
-- client sees 0 for another shop's customer because RLS hides every row it would sum.
create function customer_due(p_customer uuid) returns numeric
  language sql stable as $$
  select coalesce((select sum(p.amount)
                     from bills b join bill_payments p on p.bill_id = b.id
                    where b.customer_id = p_customer and b.status = 'done' and p.mode = 'credit'), 0)
       + coalesce((select sum(amount) from dues_entries
                    where customer_id = p_customer and kind = 'opening' and reversed_at is null), 0)
       - coalesce((select sum(amount) from dues_entries
                    where customer_id = p_customer and kind = 'repayment' and reversed_at is null), 0);
$$;

revoke all on function customer_due(uuid) from public, anon;
grant execute on function customer_due(uuid) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Writers
-- ---------------------------------------------------------------------------

create function record_repayment(p_customer uuid, p_amount numeric, p_mode text, p_note text default null)
  returns dues_entries
  language plpgsql security definer set search_path = public as $$
declare
  v_vendor uuid := current_vendor_id();
  v_today  date := (now() at time zone 'Asia/Kolkata')::date;
  v_row    dues_entries%rowtype;
begin
  if v_vendor is null or current_user_role() not in ('admin', 'biller') then
    raise exception 'only an admin or biller may record a repayment' using errcode = '42501';
  end if;
  if p_mode is null or p_mode not in ('cash', 'upi', 'card') then
    raise exception 'a repayment mode is required (cash, upi or card)' using errcode = '22023';
  end if;
  if p_amount is null or p_amount <= 0 or p_amount <> round(p_amount, 2) then
    raise exception 'amount must be more than zero, to the paisa' using errcode = '22023';
  end if;

  -- Same order as complete_bill: the vendor FOR SHARE (so close_day, which takes it FOR
  -- UPDATE, either counts this repayment or makes it wait and refuses it below), then the
  -- customer FOR UPDATE (so two tills cannot both take the last payment -- a row lock on
  -- existing entries would not stop a concurrent INSERT).
  perform 1 from vendors where id = v_vendor for share;
  perform 1 from customers where id = p_customer and vendor_id = v_vendor for update;
  if not found then
    raise exception 'customer is not in your shop' using errcode = '42501';
  end if;

  if exists (select 1 from day_closes
              where vendor_id = v_vendor and business_date = v_today and reopened_at is null) then
    raise exception 'day is closed' using errcode = 'P0001';
  end if;

  -- A new statement after both locks, so under READ COMMITTED it sees a payment the other
  -- till just committed.
  if p_amount > customer_due(p_customer) then
    raise exception 'more than the balance' using errcode = 'P0001';
  end if;

  insert into dues_entries (vendor_id, customer_id, kind, amount, mode, note, business_date, created_by)
  values (v_vendor, p_customer, 'repayment', p_amount, p_mode,
          nullif(btrim(coalesce(p_note, '')), ''), v_today, auth.uid())
  returning * into v_row;
  return v_row;
end $$;

revoke all on function record_repayment(uuid, numeric, text, text) from public, anon;
grant execute on function record_repayment(uuid, numeric, text, text) to authenticated;

-- Udhaar already in the paper khata. Moves no cash, so no day lock.
create function record_opening_balance(p_customer uuid, p_amount numeric, p_note text)
  returns dues_entries
  language plpgsql security definer set search_path = public as $$
declare
  v_vendor uuid := current_vendor_id();
  v_row    dues_entries%rowtype;
begin
  if v_vendor is null or current_user_role() <> 'admin' then
    raise exception 'only an admin may add an opening balance' using errcode = '42501';
  end if;
  if p_amount is null or p_amount <= 0 or p_amount <> round(p_amount, 2) then
    raise exception 'amount must be more than zero, to the paisa' using errcode = '22023';
  end if;
  if length(btrim(coalesce(p_note, ''))) = 0 then
    raise exception 'a note is required' using errcode = '22023';
  end if;

  perform 1 from customers where id = p_customer and vendor_id = v_vendor for update;
  if not found then
    raise exception 'customer is not in your shop' using errcode = '42501';
  end if;

  insert into dues_entries (vendor_id, customer_id, kind, amount, mode, note, business_date, created_by)
  values (v_vendor, p_customer, 'opening', p_amount, null, btrim(p_note),
          (now() at time zone 'Asia/Kolkata')::date, auth.uid())
  returning * into v_row;
  return v_row;
end $$;

revoke all on function record_opening_balance(uuid, numeric, text) from public, anon;
grant execute on function record_opening_balance(uuid, numeric, text) to authenticated;

-- Stamps, never deletes: who, when and why stay on record.
create function reverse_dues_entry(p_entry uuid, p_reason text) returns dues_entries
  language plpgsql security definer set search_path = public as $$
declare
  v_vendor uuid := current_vendor_id();
  v_row    dues_entries%rowtype;
begin
  if v_vendor is null or current_user_role() not in ('admin', 'biller') then
    raise exception 'only an admin or biller may reverse an entry' using errcode = '42501';
  end if;
  if length(btrim(coalesce(p_reason, ''))) = 0 then
    raise exception 'a reason is required' using errcode = '22023';
  end if;

  -- The vendor first, as in record_repayment: a reversal of today's cash repayment must
  -- not slip past a close that is counting it.
  perform 1 from vendors where id = v_vendor for share;
  select * into v_row from dues_entries where id = p_entry and vendor_id = v_vendor for update;
  if not found then
    raise exception 'entry is not in your shop' using errcode = '42501';
  end if;
  if v_row.kind = 'opening' and current_user_role() <> 'admin' then
    raise exception 'only an admin may reverse an opening balance' using errcode = '42501';
  end if;
  if v_row.reversed_at is not null then
    raise exception 'already reversed' using errcode = 'P0001';
  end if;
  -- A closed day's cash never changes afterwards.
  if v_row.kind = 'repayment' and exists (
       select 1 from day_closes
        where vendor_id = v_vendor and business_date = v_row.business_date and reopened_at is null) then
    raise exception 'day is closed' using errcode = 'P0001';
  end if;

  update dues_entries
     set reversed_at = now(), reversed_by = auth.uid(), reverse_reason = btrim(p_reason)
   where id = p_entry
  returning * into v_row;
  return v_row;
end $$;

revoke all on function reverse_dues_entry(uuid, text) from public, anon;
grant execute on function reverse_dues_entry(uuid, text) to authenticated;

-- ---------------------------------------------------------------------------
-- Credit needs a customer
-- ---------------------------------------------------------------------------

-- complete_bill: byte-for-byte 0021 except the credit-needs-a-customer guard. Same
-- signature, so create or replace is correct and creates no overload.
create or replace function complete_bill(
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

-- Credit bills completed before this rule, with no customer. Invoker rights: RLS scopes it.
create function unassigned_credit()
  returns table (bill_id uuid, token_no integer, completed_at timestamptz, amount numeric)
  language sql stable as $$
  select b.id, b.token_no, b.completed_at, p.amount
    from bills b
    join bill_payments p on p.bill_id = b.id
   where b.status = 'done' and p.mode = 'credit' and b.customer_id is null
     and current_user_role() = 'admin'
   order by b.completed_at desc;
$$;

revoke all on function unassigned_credit() from public, anon;
grant execute on function unassigned_credit() to authenticated, service_role;

-- Gives an old customer-less credit bill its customer, so the udhaar is owed by someone.
-- Moves no cash, so no day lock. Awards no points and sends no message: the sale was
-- settled on the day, and this only records who owes for it.
create function assign_credit_customer(p_bill uuid, p_customer uuid) returns void
  language plpgsql security definer set search_path = public as $$
declare
  v_vendor uuid := current_vendor_id();
  v_bill   bills%rowtype;
begin
  if v_vendor is null or current_user_role() <> 'admin' then
    raise exception 'only an admin may assign a customer' using errcode = '42501';
  end if;
  select * into v_bill from bills where id = p_bill and vendor_id = v_vendor for update;
  if not found then
    raise exception 'bill is not in your shop' using errcode = '42501';
  end if;
  perform 1 from customers where id = p_customer and vendor_id = v_vendor;
  if not found then
    raise exception 'customer is not in your shop' using errcode = '42501';
  end if;
  if v_bill.status <> 'done' or v_bill.customer_id is not null
     or not exists (select 1 from bill_payments where bill_id = p_bill and mode = 'credit') then
    raise exception 'bill cannot be assigned' using errcode = 'P0001';
  end if;
  update bills set customer_id = p_customer where id = p_bill;
end $$;

revoke all on function assign_credit_customer(uuid, uuid) from public, anon;
grant execute on function assign_credit_customer(uuid, uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- What the Dues screens read
-- ---------------------------------------------------------------------------

-- Every customer whose balance is not zero, most owed first, overpaid last. oldest_unpaid
-- is FIFO, like a khata: repayments clear the oldest charge first, so it is the date of the
-- first charge the running total of charges has not yet been paid past. Invoker rights: RLS
-- on customers, bills, bill_payments and dues_entries scopes every row.
create function dues_list()
  returns table (customer_id uuid, name text, flat_no text, mobile text, balance numeric, oldest_unpaid date)
  language sql stable as $$
  with charges as (
    select b.customer_id, b.completed_at as at,
           (b.completed_at at time zone 'Asia/Kolkata')::date as day, p.amount
      from bills b join bill_payments p on p.bill_id = b.id
     where b.status = 'done' and p.mode = 'credit' and b.customer_id is not null
    union all
    select e.customer_id, e.created_at, e.business_date, e.amount
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
           sum(c.amount) over (partition by c.customer_id order by c.at, c.day
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

-- One customer's history, newest first. Voided credit bills are left out: they are not
-- owed. day_closed is set only for a repayment whose day has an active close -- the web
-- hides Reverse for it, and reverse_dues_entry refuses it anyway. Invoker rights.
create function customer_dues(p_customer uuid)
  returns table (kind text, id uuid, at timestamptz, business_date date, amount numeric, mode text,
                 note text, by_name text, token_no integer, reversed_at timestamptz,
                 reversed_by_name text, reverse_reason text, day_closed boolean)
  language sql stable as $$
  select 'credit_bill'::text, b.id, b.completed_at, (b.completed_at at time zone 'Asia/Kolkata')::date,
         p.amount, null::text, null::text, u.name, b.token_no, null::timestamptz, null::text, null::text,
         false
    from bills b
    join bill_payments p on p.bill_id = b.id
    left join app_users u on u.id = b.biller_id
   where b.customer_id = p_customer and b.status = 'done' and p.mode = 'credit'
  union all
  select e.kind, e.id, e.created_at, e.business_date, e.amount, e.mode, e.note, u.name, null::integer,
         e.reversed_at, ru.name, e.reverse_reason,
         e.kind = 'repayment' and exists (
           select 1 from day_closes dc
            where dc.vendor_id = e.vendor_id and dc.business_date = e.business_date
              and dc.reopened_at is null)
    from dues_entries e
    left join app_users u on u.id = e.created_by
    left join app_users ru on ru.id = e.reversed_by
   where e.customer_id = p_customer
   order by 3 desc;
$$;

revoke all on function customer_dues(uuid) from public, anon;
grant execute on function customer_dues(uuid) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Repayments in the day's cash
-- ---------------------------------------------------------------------------

-- Same signature as 0021, so create or replace. Cash sales plus un-reversed cash repayments.
create or replace function expected_cash_for(p_vendor uuid, p_date date) returns numeric
  language sql stable as $$
  select coalesce((select sum(p.amount)
                     from bill_payments p
                     join bills b on b.id = p.bill_id
                    where b.vendor_id = p_vendor
                      and b.status = 'done'
                      and p.mode = 'cash'
                      and (b.completed_at at time zone 'Asia/Kolkata')::date = p_date), 0)
       + coalesce((select sum(e.amount)
                     from dues_entries e
                    where e.vendor_id = p_vendor
                      and e.kind = 'repayment' and e.mode = 'cash'
                      and e.reversed_at is null
                      and e.business_date = p_date), 0);
$$;

revoke all on function expected_cash_for(uuid, date) from public, anon, authenticated;

-- The return type grows, so DROP then CREATE (create or replace cannot change it). The 0021
-- columns keep their names and order; the dues columns are appended, so an old tab reading
-- this by column name is unaffected.
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
    dues_card        numeric, dues_card_count  bigint
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
  )
  select (select day from d),
         s.cash, s.cash_count, s.upi, s.upi_count, s.card, s.card_count,
         s.credit, s.credit_count, s.unrecorded, s.unrecorded_count,
         s.cash + r.dues_cash,
         (select count(*) from bills where status = 'billed'),
         r.dues_cash, r.dues_cash_count, r.dues_upi, r.dues_upi_count, r.dues_card, r.dues_card_count
    from s, r;
$$;

revoke all on function day_summary(date) from public, anon;
grant execute on function day_summary(date) to authenticated, service_role;

-- clear_vendor_data(): byte-for-byte 0021 plus dues_entries, deleted before customers (its FK has no cascade).
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

  delete from dues_entries where vendor_id = v_vendor;
  delete from customers where vendor_id = v_vendor;
  get diagnostics v_custs = row_count;

  -- Tokens restart at 1. Safe only because the bills are gone.
  update vendor_counters set last_token = 0 where vendor_id = v_vendor;

  return query select v_bills, v_custs, v_points;
end $$;

-- unclosed_days(): 0021's body verbatim, plus past days whose only cash came from dues
-- repayments. A repayment moves cash into the till, so its day needs a close just as a
-- sales day does. Un-reversed repayments only: a reversed one moved no cash, and an
-- opening balance never does. Invoker rights: RLS on bills, dues_entries, vendors and
-- day_closes scopes it.
create or replace function unclosed_days() returns table (business_date date)
  language sql stable as $$
  select distinct d.business_date
    from (
      select (b.completed_at at time zone 'Asia/Kolkata')::date as business_date
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
      union
      select e.business_date
        from dues_entries e
        join vendors v on v.id = e.vendor_id
       where e.kind = 'repayment'
         and e.reversed_at is null
         and e.business_date <  (now() at time zone 'Asia/Kolkata')::date
         and e.business_date >= (now() at time zone 'Asia/Kolkata')::date - 30
         and e.business_date >= v.day_close_from
         and not exists (
           select 1 from day_closes c
            where c.vendor_id = e.vendor_id
              and c.business_date = e.business_date
              and c.reopened_at is null)
    ) d
   order by d.business_date desc;
$$;

revoke all on function unclosed_days() from public, anon;
grant execute on function unclosed_days() to authenticated, service_role;
