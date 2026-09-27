-- Updating prices from a rate-list photo.
-- Spec: docs/superpowers/specs/2026-09-27-rate-list-import-design.md
--
-- The photo is read by the read-rate-list Edge Function and reviewed in the app; nothing
-- reaches the database until the admin taps Apply, which is this file's one RPC.

-- Names the shop's rate list uses for an item, learned whenever a list line is linked to
-- or creates an item. Unique per shop ignoring case: one name points at one item.
create table item_aliases (
  id         uuid primary key default gen_random_uuid(),
  vendor_id  uuid not null references vendors(id) on delete cascade,
  item_id    uuid not null references items(id) on delete cascade,
  alias      text not null check (length(btrim(alias)) > 0),
  created_at timestamptz not null default now()
);
create unique index item_aliases_vendor_alias_idx on item_aliases (vendor_id, lower(alias));

alter table item_aliases enable row level security;
-- Read by the shop's staff (the review screen matches against it). Written only by
-- apply_price_list, which is security definer, so there is no write policy.
create policy item_aliases_read on item_aliases for select
  using (vendor_id = current_vendor_id());

-- Who changed which price, from what, when. Only the rate list writes here for now.
create table price_changes (
  id         uuid primary key default gen_random_uuid(),
  vendor_id  uuid not null references vendors(id) on delete cascade,
  item_id    uuid not null references items(id) on delete cascade,
  old_price  numeric(10,2) not null,
  new_price  numeric(10,2) not null,
  source     text not null check (source in ('rate_list')),
  changed_by uuid references app_users(id),
  changed_at timestamptz not null default now()
);
create index price_changes_item_idx on price_changes (item_id, changed_at);

alter table price_changes enable row level security;
create policy price_changes_admin_read on price_changes for select
  using (vendor_id = current_vendor_id() and current_user_role() = 'admin');

create function apply_price_list(p_rows jsonb) returns jsonb
  language plpgsql security definer set search_path = public as $$
declare
  r           jsonb;
  v_item      items%rowtype;
  v_price     numeric;
  v_alias     text;
  v_updated   jsonb := '[]'::jsonb;
  v_created   jsonb := '[]'::jsonb;
  v_unchanged integer := 0;
begin
  if current_vendor_id() is null or current_user_role() <> 'admin' then
    raise exception 'only an admin may apply a price list' using errcode = '42501';
  end if;
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' then
    raise exception 'rows must be an array' using errcode = '22023';
  end if;

  -- One transaction: any bad row raises and nothing above it survives.
  for r in select value from jsonb_array_elements(p_rows) loop
    v_price := round((r->>'price')::numeric, 2);
    if v_price is null or v_price <= 0 then
      raise exception 'a price must be more than zero' using errcode = '22023';
    end if;
    v_alias := nullif(btrim(coalesce(r->>'alias', '')), '');

    if r->>'kind' = 'update' then
      select * into v_item from items
       where id = (r->>'item_id')::uuid and vendor_id = current_vendor_id()
         for update;
      if not found then
        raise exception 'item % is not in your shop', r->>'item_id' using errcode = '42501';
      end if;
      if v_item.price <> v_price then
        -- The 0025 trigger reprices pending bills from here.
        update items set price = v_price where id = v_item.id;
        insert into price_changes (vendor_id, item_id, old_price, new_price, source, changed_by)
        values (v_item.vendor_id, v_item.id, v_item.price, v_price, 'rate_list', auth.uid());
        v_updated := v_updated || jsonb_build_object(
          'item_id', v_item.id, 'name_en', v_item.name_en, 'name_hi', v_item.name_hi,
          'name_mr', v_item.name_mr, 'unit', v_item.unit,
          'old_price', v_item.price, 'new_price', v_price);
      else
        v_unchanged := v_unchanged + 1;
      end if;

    elsif r->>'kind' = 'create' then
      if length(btrim(coalesce(r->'names'->>'name_en', ''))) = 0
         or length(btrim(coalesce(r->'names'->>'name_hi', ''))) = 0
         or length(btrim(coalesce(r->'names'->>'name_mr', ''))) = 0 then
        raise exception 'a new item needs all three names' using errcode = '22023';
      end if;
      -- Owner decision: cost = price, stock 30, low stock 10, in the item's unit.
      -- create_item_with_cost checks the unit and logs the opening stock.
      v_item := create_item_with_cost(
        jsonb_build_object('name_en', btrim(r->'names'->>'name_en'),
                           'name_hi', btrim(r->'names'->>'name_hi'),
                           'name_mr', btrim(r->'names'->>'name_mr')),
        v_price, 30, r->>'unit', 10, v_price);
      v_created := v_created || jsonb_build_object(
        'item_id', v_item.id, 'name_en', v_item.name_en, 'name_hi', v_item.name_hi,
        'name_mr', v_item.name_mr, 'unit', v_item.unit, 'price', v_item.price);

    else
      raise exception 'unknown row kind %', r->>'kind' using errcode = '22023';
    end if;

    if v_alias is not null then
      insert into item_aliases (vendor_id, item_id, alias)
      values (current_vendor_id(), v_item.id, v_alias)
      on conflict (vendor_id, lower(alias)) do update set item_id = excluded.item_id;
    end if;
  end loop;

  return jsonb_build_object('updated', v_updated, 'created', v_created, 'unchanged', v_unchanged);
end $$;

revoke all on function apply_price_list(jsonb) from public, anon;
grant execute on function apply_price_list(jsonb) to authenticated;
