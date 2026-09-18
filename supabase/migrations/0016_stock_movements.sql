-- Slice D: purchase cost, stock intake, wastage and margin.
-- Spec: docs/superpowers/specs/2026-09-18-purchase-cost-margin-design.md
--
-- Cost basis is the LATEST purchase price, copied onto each sold line when the bill is
-- completed (see complete_bill below). Copying rather than looking it up later is what
-- keeps last month's profit from moving when this morning's mandi price changes.

create table stock_movements (
  id         uuid primary key default gen_random_uuid(),
  vendor_id  uuid not null references vendors(id) on delete cascade,
  item_id    uuid not null references items(id),
  kind       text not null check (kind in ('purchase', 'wastage')),
  qty_kg     numeric(10,2) not null check (qty_kg > 0),
  unit_cost  numeric(10,2) check (unit_cost >= 0),
  note       text not null default '',
  -- No ON DELETE, like bills.recorder_id: a staff member with history cannot be deleted,
  -- and admin-delete-user already reports that 23503 as "has history".
  created_by uuid not null references app_users(id),
  created_at timestamptz not null default now(),
  constraint stock_movements_cost_matches_kind check (
    (kind = 'purchase' and unit_cost is not null)
    or (kind = 'wastage' and unit_cost is null)
  )
);
create index stock_movements_vendor_created_idx on stock_movements(vendor_id, created_at);
create index stock_movements_vendor_item_idx on stock_movements(vendor_id, item_id);

alter table stock_movements enable row level security;

-- Read for every role in the shop. Deliberately NO insert, update or delete policy: the
-- row and the stock change must commit together, so log_stock_movement() is the only
-- writer. A mistake is corrected by logging an opposite movement, never by editing one.
create policy stock_movements_read on stock_movements for select to authenticated
  using (vendor_id = current_vendor_id());

-- Null means "never purchased". It is never read as zero: a zero cost would report the
-- whole sale price as profit.
alter table items add column last_cost numeric(10,2) check (last_cost >= 0);

-- Stamped by complete_bill() from items.last_cost. Null on every bill completed before
-- this migration, and on lines for items never purchased.
alter table bill_items add column unit_cost numeric(10,2) check (unit_cost >= 0);

create function log_stock_movement(
  p_item_id   uuid,
  p_kind      text,
  p_qty_kg    numeric,
  p_unit_cost numeric default null,
  p_note      text default ''
) returns stock_movements
  language plpgsql security definer set search_path = public as $$
declare
  v_item items%rowtype;
  v_row  stock_movements%rowtype;
  v_qty  numeric := round(p_qty_kg, 2);
  v_cost numeric := round(p_unit_cost, 2);
begin
  -- A null vendor means no end-user session. Unlike complete_bill, that is refused here:
  -- created_by must be a real staff member and a service-role caller has no auth.uid().
  if current_vendor_id() is null or current_user_role() not in ('admin', 'recorder') then
    raise exception 'only an admin or recorder may log stock movements'
      using errcode = '42501';
  end if;

  select * into v_item from items where id = p_item_id for update;
  if not found or v_item.vendor_id <> current_vendor_id() then
    raise exception 'item % is not in your shop', p_item_id using errcode = '42501';
  end if;

  if p_kind is null or p_kind not in ('purchase', 'wastage') then
    raise exception 'unknown movement kind %', p_kind using errcode = '22023';
  end if;
  if v_qty is null or v_qty <= 0 then
    raise exception 'quantity must be above zero' using errcode = '22023';
  end if;
  if p_kind = 'purchase' and (v_cost is null or v_cost < 0) then
    raise exception 'a purchase needs a cost per kg' using errcode = '22023';
  end if;
  if p_kind = 'wastage' and v_cost is not null then
    raise exception 'a wastage has no cost' using errcode = '22023';
  end if;
  -- Refused, not clamped. complete_bill clamps because a customer is waiting; nobody is
  -- waiting on a wastage entry, and clamping would record waste that never happened.
  if p_kind = 'wastage' and v_qty > v_item.stock_kg then
    raise exception 'wastage exceeds stock'
      using errcode = 'P0001', detail = v_item.stock_kg::text;
  end if;

  insert into stock_movements (vendor_id, item_id, kind, qty_kg, unit_cost, note, created_by)
  values (v_item.vendor_id, v_item.id, p_kind, v_qty, v_cost, coalesce(btrim(p_note), ''), auth.uid())
  returning * into v_row;

  if p_kind = 'purchase' then
    update items set stock_kg = stock_kg + v_qty, last_cost = v_cost where id = v_item.id;
  else
    update items set stock_kg = stock_kg - v_qty where id = v_item.id;
  end if;

  return v_row;
end $$;

revoke all on function log_stock_movement(uuid, text, numeric, numeric, text) from public, anon;
grant execute on function log_stock_movement(uuid, text, numeric, numeric, text) to authenticated;

-- Slice D: complete_bill() also stamps today's cost onto each sold line, and
-- clear_vendor_data() also empties this vendor's stock_movements.
--
-- Same signature as 0010, so create or replace is correct here and creates no overload.
create or replace function complete_bill(
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

-- Slice D: clear_vendor_data() also empties this vendor's stock_movements.
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
  -- Those act on a bill that names its own tenant, so a caller without an end-user session
  -- (service role, or the superuser connection the test suite uses) is unambiguous. This
  -- one derives its entire scope FROM the caller, so a null vendor has nothing to mean.
  if v_vendor is null or current_user_role() <> 'admin' then
    raise exception 'only an admin may clear their shop''s data'
      using errcode = '42501';
  end if;

  -- Order is forced by the foreign keys, and the obvious order fails:
  --   points_ledger.bill_id -> bills   has NO cascade, so bills cannot go first;
  --   bills.customer_id     -> customers has NO cascade, so customers cannot go first.
  -- bill_items and points_ledger.customer_id DO cascade, but bill_items is deleted
  -- explicitly anyway so its count is not a guess.
  delete from points_ledger where vendor_id = v_vendor;
  get diagnostics v_points = row_count;

  delete from bill_items where vendor_id = v_vendor;
  delete from bills where vendor_id = v_vendor;
  get diagnostics v_bills = row_count;

  -- Records ABOUT the bills and points just deleted. Their customer_id is ON DELETE SET
  -- NULL, so leaving them would not raise -- it would quietly keep a queue of messages
  -- about sales that no longer exist, and requests from customers who no longer exist.
  delete from stock_requests where vendor_id = v_vendor;
  delete from stock_movements where vendor_id = v_vendor;
  delete from outbound_messages where vendor_id = v_vendor;

  delete from customers where vendor_id = v_vendor;
  get diagnostics v_custs = row_count;

  -- Tokens restart at 1. Safe only because the bills are gone: unique (vendor_id, token_no)
  -- is what a reissued token would otherwise collide with. A shop that "cleared" its data
  -- and then opened on token 58 would be confusing at the counter.
  update vendor_counters set last_token = 0 where vendor_id = v_vendor;

  return query select v_bills, v_custs, v_points;
end $$;

revoke all on function clear_vendor_data() from public, anon;
grant execute on function clear_vendor_data() to authenticated;
