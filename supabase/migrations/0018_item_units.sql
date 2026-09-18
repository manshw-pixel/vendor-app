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
