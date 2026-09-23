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
