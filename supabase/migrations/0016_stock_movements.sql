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
