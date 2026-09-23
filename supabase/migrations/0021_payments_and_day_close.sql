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
