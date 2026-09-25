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
