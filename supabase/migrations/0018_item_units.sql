-- Items sold by piece, bunch or dozen.
-- Spec: docs/superpowers/specs/2026-09-18-item-units-design.md
--
-- The quantity columns keep their _kg names. Renaming them would mean recreating every
-- function from 0003 to 0017 for no behavioural gain; the comments below record the new
-- meaning instead.

alter table items
  add column unit text not null default 'kg'
    constraint items_unit_check check (unit in ('kg', 'piece', 'bunch', 'dozen')),
  add column low_stock_at numeric(10,2) not null default 10
    constraint items_low_stock_at_check check (low_stock_at >= 0);

comment on column items.unit is 'Selling unit: kg, piece, bunch or dozen. One per item; locked once sold.';
comment on column items.low_stock_at is 'The low-stock bell rings below this many of items.unit. Default 10 (requirement #9).';
comment on column items.stock_kg is 'Quantity in the item''s unit (items.unit). The _kg suffix is historical.';
comment on column bill_items.qty_kg is 'Quantity in the item''s unit (items.unit). The _kg suffix is historical.';
comment on column stock_movements.qty_kg is 'Quantity in the item''s unit (items.unit). The _kg suffix is historical.';

-- Whole numbers for anything you cannot cut in half; and a unit that cannot change once
-- a sale has recorded a quantity in it, because the history would silently change meaning.
create function items_unit_rules() returns trigger language plpgsql as $$
begin
  if new.unit <> 'kg' and new.stock_kg <> floor(new.stock_kg) then
    raise exception 'stock must be a whole number for this unit' using errcode = '22023';
  end if;
  if tg_op = 'UPDATE' and new.unit <> old.unit
     and exists (select 1 from bill_items where item_id = new.id) then
    raise exception 'unit is locked once the item has been sold' using errcode = 'P0001';
  end if;
  return new;
end $$;

create trigger items_unit_rules before insert or update on items
  for each row execute function items_unit_rules();

-- #9 with a per-item threshold. security_invoker as in 0004, so RLS scopes it.
drop view if exists v_low_stock;
create view v_low_stock with (security_invoker = true) as
  select id, vendor_id, name_en, name_hi, name_mr, stock_kg, unit, low_stock_at
    from items where is_active and stock_kg < low_stock_at;

drop view if exists v_in_stock;
create view v_in_stock with (security_invoker = true) as
  select id, vendor_id, name_en, name_hi, name_mr, stock_kg, unit
    from items where is_active and stock_kg > 0;

-- Whole-number guard shared by the two write paths. Invoker rights: it only reads items,
-- which RLS already scopes, and both callers are security definer anyway.
create function assert_whole_qty(p_item_id uuid, p_qty numeric) returns void
  language plpgsql stable as $$
declare v_unit text;
begin
  select unit into v_unit from items where id = p_item_id;
  if v_unit is not null and v_unit <> 'kg' and p_qty <> floor(p_qty) then
    raise exception 'quantity must be a whole number for this unit' using errcode = '22023';
  end if;
end $$;

-- Slice B (0015), re-created here to add the 0018 whole-quantity guard.
create or replace function replace_bill_lines(p_bill_id uuid, p_lines jsonb)
  returns void
  language plpgsql security definer set search_path = public as $$
declare
  v_bill bills%rowtype;
begin
  select * into v_bill from bills where id = p_bill_id for update;
  if not found then
    raise exception 'bill % not found', p_bill_id;
  end if;

  -- Same trust decision as issue_token() and complete_bill(): a null current_vendor_id()
  -- means the caller has no end-user session (service role, or the superuser connection
  -- the test suite uses), which is allowed; a non-null one must own this bill. A biller
  -- has no business rewriting a basket, so only admin and recorder pass -- the same pair
  -- issue_token() accepts.
  if current_vendor_id() is not null and current_vendor_id() <> v_bill.vendor_id then
    raise exception 'bill % does not belong to your vendor', p_bill_id;
  end if;
  if current_vendor_id() is not null and current_user_role() not in ('admin', 'recorder') then
    raise exception 'role % may not record bill lines', current_user_role();
  end if;

  -- The bill's own lifecycle is what makes a DESTRUCTIVE replace safe. Past 'recording'
  -- the customer has been handed a token and told a total, and the outbound_messages row
  -- quoting that total is already queued (0003_functions.sql:54-56). Rewriting the lines
  -- then would make both of those a lie, and issue_token's guard cannot catch it because
  -- issue_token has already run.
  if v_bill.status <> 'recording' then
    raise exception 'bill % is %, expected recording', p_bill_id, v_bill.status;
  end if;

  -- Refused, never treated as "clear the bill". Bill.tsx disables Done at zero lines, so
  -- an empty basket can only be a bug -- and accepting one would let a retry turn a real
  -- bill into a zero-rupee one.
  if jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) = 0 then
    raise exception 'refusing to leave bill % with no lines', p_bill_id;
  end if;

  -- Whole numbers for piece/bunch/dozen items (0018). Checked before the delete so a
  -- refused basket leaves the existing lines untouched.
  perform assert_whole_qty(l.item_id, l.qty_kg)
    from jsonb_to_recordset(p_lines) as l(item_id uuid, qty_kg numeric);

  delete from bill_items where bill_id = p_bill_id;

  -- line_total is COMPUTED here, and is deliberately absent from the input. issue_token
  -- sums the stored line_totals, so a client-supplied one let a crafted request set a
  -- bill's total to anything -- RLS stops another vendor's data being touched, but not a
  -- recorder's own client sending line_total 1 for 5kg of tomatoes.
  --
  -- unit_price is still the caller's, NOT items.price. The price at the moment of
  -- recording is the correct price; reading the live one would let an admin editing a
  -- price mid-bill change a basket already on the recorder's screen.
  --
  -- round(x, 2) matches billing.ts's Math.round(x * 100) / 100 for every value the app can
  -- produce (validateWeight caps qty at two decimals). The two must agree: runningTotal()
  -- is what the recorder reads off the screen, and issue_token sums these rows.
  insert into bill_items (bill_id, vendor_id, item_id, qty_kg, unit_price, line_total)
  select p_bill_id, v_bill.vendor_id, l.item_id, l.qty_kg, l.unit_price,
         round(l.qty_kg * l.unit_price, 2)
    from jsonb_to_recordset(p_lines)
      as l(item_id uuid, qty_kg numeric, unit_price numeric);
end $$;

revoke all on function replace_bill_lines(uuid, jsonb) from public, anon;
grant execute on function replace_bill_lines(uuid, jsonb) to authenticated;

-- Slice D (0016), re-created here to add the 0018 whole-quantity guard.
create or replace function log_stock_movement(
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

  select * into v_item from items
   where id = p_item_id and vendor_id = current_vendor_id()
     for update;  -- another shop's row: no match, no lock
  if not found or v_item.vendor_id <> current_vendor_id() then
    raise exception 'item % is not in your shop', p_item_id using errcode = '42501';
  end if;

  perform assert_whole_qty(v_item.id, v_qty);

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

-- Slice D (0016) analytics, re-created here to add the item's unit.
drop function if exists top_items_between(timestamptz, timestamptz);

create function top_items_between(p_from timestamptz, p_to timestamptz)
  returns table (
    item_id        uuid,
    name_en        text,
    name_hi        text,
    name_mr        text,
    unit           text,
    total_qty_kg   numeric,
    total_revenue  numeric,
    total_cost     numeric,
    margin         numeric,
    uncosted_lines bigint
  )
  language sql stable as $$
  select bi.item_id, i.name_en, i.name_hi, i.name_mr, i.unit,
         sum(bi.qty_kg)                                   as total_qty_kg,
         sum(bi.line_total)                               as total_revenue,
         -- sum() over all-null input is null, which is what "cost unknown" should be.
         round(sum(bi.qty_kg * bi.unit_cost), 2)          as total_cost,
         -- Margin over the COSTED lines only. Subtracting a partial cost from the full
         -- revenue would overstate margin for a half-costed item.
         --
         -- On gross line_total, not bills.total: redeemed points are a bill-level discount
         -- (see 0010) that this per-item query has no way to attribute to one line among
         -- several. So per-item margins can sum to MORE than collected_between's headline
         -- profit, by the amount of points redeemed in the window -- expected, not a bug.
         round(sum(bi.line_total) filter (where bi.unit_cost is not null)
               - sum(bi.qty_kg * bi.unit_cost), 2)        as margin,
         count(*) filter (where bi.unit_cost is null)     as uncosted_lines
    from bill_items bi
    join bills b on b.id = bi.bill_id
                and b.status = 'done'
                and b.completed_at >= p_from
                and b.completed_at <  p_to
    join items i on i.id = bi.item_id
   group by bi.item_id, i.name_en, i.name_hi, i.name_mr, i.unit
   -- Ranked by sales value, not quantity: quantities in different units (kg, piece,
   -- bunch, dozen) are not comparable, so 5kg and 5 pieces cannot be ordered against
   -- each other honestly. Revenue is always comparable.
   order by sum(bi.line_total) desc, bi.item_id
   limit 10;
$$;

revoke all on function top_items_between(timestamptz, timestamptz) from public, anon;
grant execute on function top_items_between(timestamptz, timestamptz) to authenticated, service_role;

drop function if exists stock_movements_between(timestamptz, timestamptz);

-- The /stock screen's list. Plain language sql with no security definer, so RLS on
-- stock_movements, items and app_users scopes it to the caller's shop.
create function stock_movements_between(p_from timestamptz, p_to timestamptz)
  returns table (
    id              uuid,
    item_id         uuid,
    name_en         text,
    name_hi         text,
    name_mr         text,
    unit            text,
    kind            text,
    qty_kg          numeric,
    unit_cost       numeric,
    note            text,
    created_by_name text,
    created_at      timestamptz
  )
  language sql stable as $$
  select m.id, m.item_id, i.name_en, i.name_hi, i.name_mr, i.unit,
         m.kind, m.qty_kg, m.unit_cost, m.note, u.name, m.created_at
    from stock_movements m
    join items i on i.id = m.item_id
    left join app_users u on u.id = m.created_by
   where m.created_at >= p_from
     and m.created_at <  p_to
   order by m.created_at desc, m.id desc
   limit 500;
$$;

revoke all on function stock_movements_between(timestamptz, timestamptz) from public, anon;
grant execute on function stock_movements_between(timestamptz, timestamptz) to authenticated, service_role;
