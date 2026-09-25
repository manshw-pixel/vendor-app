-- Offline billing: bills recorded with no connection, synced later.
-- Spec: docs/superpowers/specs/2026-09-25-offline-billing-design.md

-- ---------------------------------------------------------------------------
-- Part 1: complete_bill's body becomes a guard-free core both paths call, so the
-- online and offline sale can never drift apart. complete_bill's signature and
-- behaviour are unchanged: p_at = now(), p_notify = true.
-- ---------------------------------------------------------------------------
create function _complete_bill_core(
  p_bill_id uuid, p_biller_id uuid, p_redeem_points integer, p_payment_mode text,
  p_collect_due numeric, p_at timestamptz, p_notify boolean
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
                and business_date = (p_at at time zone 'Asia/Kolkata')::date
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
            (p_at at time zone 'Asia/Kolkata')::date, coalesce(auth.uid(), p_biller_id), p_bill_id);
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
            p_at + (v_vendor.redeem_days || ' days')::interval);

    -- #16: tell the customer their points, queued in the same transaction.
    if p_notify then
      insert into outbound_messages (vendor_id, customer_id, template_key, payload)
      values (v_bill.vendor_id, v_bill.customer_id, 'points_awarded',
              jsonb_build_object('points', v_points, 'total', v_net,
                                 'redeemed', v_redeemed,
                                 'expires_in_days', v_vendor.redeem_days));
    end if;
  end if;

  -- #7 (forgeable attribution): prefer the real signed-in caller over the client-supplied
  -- argument. p_biller_id only applies for a service-role caller, which has no auth.uid().
  update bills
     set status = 'done',
         completed_at = p_at,
         total = v_net,
         redeemed_points = v_redeemed,
         biller_id = coalesce(auth.uid(), p_biller_id, biller_id)
   where id = p_bill_id;

  -- What was collected, and how. v_net, not v_gross: points are not money in the drawer.
  insert into bill_payments (vendor_id, bill_id, mode, amount, created_by)
  values (v_bill.vendor_id, p_bill_id, p_payment_mode, v_net, coalesce(auth.uid(), p_biller_id));
end $$;

revoke all on function _complete_bill_core(uuid, uuid, integer, text, numeric, timestamptz, boolean)
  from public, anon, authenticated;

create or replace function complete_bill(
  p_bill_id uuid,
  p_biller_id uuid default null,
  p_redeem_points integer default 0,
  p_payment_mode text default null,
  p_collect_due numeric default 0
) returns void
  language plpgsql security definer set search_path = public as $$
declare
  v_vendor uuid;
begin
  select vendor_id into v_vendor from bills where id = p_bill_id;
  if not found then
    raise exception 'bill % not found', p_bill_id;
  end if;
  if current_vendor_id() is not null and current_vendor_id() <> v_vendor then
    raise exception 'bill % does not belong to your vendor', p_bill_id;
  end if;
  if current_vendor_id() is not null and current_user_role() not in ('admin', 'biller') then
    raise exception 'role % may not complete bills', current_user_role();
  end if;
  perform _complete_bill_core(p_bill_id, p_biller_id, p_redeem_points, p_payment_mode,
                              p_collect_due, now(), true);
end $$;
-- create or replace keeps 0023's grants.

-- ---------------------------------------------------------------------------
-- Part 2: the offline sale
-- ---------------------------------------------------------------------------
alter table bills
  add column client_id    uuid unique,
  add column occurred_at  timestamptz,
  add column device_label text;

create table sync_issues (
  id          uuid primary key default gen_random_uuid(),
  vendor_id   uuid not null references vendors(id) on delete cascade,
  bill_id     uuid not null references bills(id) on delete cascade,
  kind        text not null check (kind in ('redeem_shortfall','due_overcollected',
                                            'rebooked_closed_day','time_clamped')),
  amount      numeric(10,2),
  detail      jsonb not null default '{}',
  status      text not null default 'open' check (status in ('open','added_as_due','dismissed')),
  resolved_by uuid references app_users(id),
  resolved_at timestamptz,
  created_at  timestamptz not null default now()
);
create index sync_issues_open_idx on sync_issues(vendor_id) where status = 'open';

alter table sync_issues enable row level security;
-- The owner settles these; staff at the counter are not asked to.
create policy sync_issues_admin_read on sync_issues for select to authenticated
  using (vendor_id = current_vendor_id() and current_user_role() = 'admin');

create function _offline_result(p_bill_id uuid) returns jsonb
  language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'bill_id', b.id, 'token_no', b.token_no,
    'issues', coalesce((select jsonb_agg(jsonb_build_object('kind', s.kind, 'amount', s.amount)
                                          order by s.kind)
                          from sync_issues s where s.bill_id = b.id), '[]'::jsonb))
    from bills b where b.id = p_bill_id;
$$;
revoke all on function _offline_result(uuid) from public, anon, authenticated;

create function record_offline_bill(p_client_id uuid, p_bill jsonb) returns jsonb
  language plpgsql security definer set search_path = public as $$
declare
  v_vendor    uuid := current_vendor_id();
  v_existing  bills%rowtype;
  v_bill_id   uuid;
  v_token     integer;
  v_customer  uuid := nullif(p_bill->>'customer_id', '')::uuid;
  v_mode      text := p_bill->>'payment_mode';
  v_redeem    integer := coalesce((p_bill->>'redeem_points')::integer, 0);
  v_collect   numeric := coalesce((p_bill->>'collect_due')::numeric, 0);
  v_lines     jsonb := p_bill->'lines';
  v_req_at    timestamptz := (p_bill->>'occurred_at')::timestamptz;
  v_at        timestamptz;
  v_due       numeric;
  v_redeemed  integer;
begin
  if v_vendor is null or current_user_role() not in ('admin', 'recorder', 'biller') then
    raise exception 'only shop staff may record an offline bill' using errcode = '42501';
  end if;
  if p_client_id is null or v_req_at is null then
    raise exception 'client id and time are required' using errcode = '22023';
  end if;

  -- Idempotent by client_id: a lost reply's resend returns the first result. The unique
  -- constraint makes a concurrent double-send fail the second insert, and its retry lands here.
  select * into v_existing from bills where client_id = p_client_id;
  if found then
    if v_existing.vendor_id <> v_vendor then
      raise exception 'bill is not in your shop' using errcode = '42501';
    end if;
    return _offline_result(v_existing.id);
  end if;

  if jsonb_typeof(v_lines) <> 'array' or jsonb_array_length(v_lines) = 0 then
    raise exception 'refusing an offline bill with no lines' using errcode = '22023';
  end if;
  if exists (select 1 from jsonb_to_recordset(v_lines) l(item_id uuid)
              left join items i on i.id = l.item_id and i.vendor_id = v_vendor
             where i.id is null) then
    raise exception 'an item on this bill no longer exists' using errcode = 'P0002';
  end if;
  if v_customer is not null and not exists
       (select 1 from customers where id = v_customer and vendor_id = v_vendor) then
    raise exception 'the customer on this bill no longer exists' using errcode = 'P0002';
  end if;
  perform assert_whole_qty(l.item_id, l.qty_kg)
    from jsonb_to_recordset(v_lines) as l(item_id uuid, qty_kg numeric);

  insert into bills (vendor_id, customer_id, recorder_id, status, client_id, occurred_at, device_label)
  values (v_vendor, v_customer, auth.uid(), 'recording', p_client_id, v_req_at, p_bill->>'device_label')
  returning id into v_bill_id;

  v_at := least(greatest(v_req_at, now() - interval '7 days'), now());
  if v_at <> v_req_at then
    insert into sync_issues (vendor_id, bill_id, kind, detail)
    values (v_vendor, v_bill_id, 'time_clamped',
            jsonb_build_object('requested', v_req_at, 'used', v_at));
  end if;

  -- A closed day's signed-off cash is never changed: book the sale to now instead.
  if exists (select 1 from day_closes
              where vendor_id = v_vendor
                and business_date = (v_at at time zone 'Asia/Kolkata')::date
                and reopened_at is null) then
    insert into sync_issues (vendor_id, bill_id, kind, detail)
    values (v_vendor, v_bill_id, 'rebooked_closed_day',
            jsonb_build_object('from', (v_at at time zone 'Asia/Kolkata')::date,
                               'to', (now() at time zone 'Asia/Kolkata')::date));
    v_at := now();
  end if;

  -- The price the customer actually paid; totals computed here, as replace_bill_lines does.
  insert into bill_items (bill_id, vendor_id, item_id, qty_kg, unit_price, line_total)
  select v_bill_id, v_vendor, l.item_id, l.qty_kg, l.unit_price, round(l.qty_kg * l.unit_price, 2)
    from jsonb_to_recordset(v_lines) as l(item_id uuid, qty_kg numeric, unit_price numeric);

  -- A real token, as issue_token allocates it -- but no token_issued message: the customer
  -- has already left with their goods.
  update vendor_counters set last_token = last_token + 1
   where vendor_id = v_vendor returning last_token into v_token;
  update bills
     set token_no = v_token, status = 'billed',
         total = (select coalesce(sum(line_total), 0) from bill_items where bill_id = v_bill_id)
   where id = v_bill_id;

  -- Same lock order as the core: vendor, then customer.
  perform 1 from vendors where id = v_vendor for share;
  if v_customer is not null then
    perform 1 from customers where id = v_customer for update;
  end if;

  if v_collect > 0 and v_customer is not null then
    v_due := greatest(customer_due(v_customer), 0);
    if v_collect > v_due then
      insert into sync_issues (vendor_id, bill_id, kind, amount)
      values (v_vendor, v_bill_id, 'due_overcollected', v_collect - v_due);
      v_collect := v_due;
    end if;
  end if;

  perform _complete_bill_core(v_bill_id, auth.uid(), v_redeem, v_mode, v_collect, v_at, false);

  select redeemed_points into v_redeemed from bills where id = v_bill_id;
  if v_redeem > v_redeemed then
    insert into sync_issues (vendor_id, bill_id, kind, amount)
    values (v_vendor, v_bill_id, 'redeem_shortfall', v_redeem - v_redeemed);
  end if;

  return _offline_result(v_bill_id);
end $$;

revoke all on function record_offline_bill(uuid, jsonb) from public, anon;
grant execute on function record_offline_bill(uuid, jsonb) to authenticated;
