-- Pending reprice + delete pending token.
-- Spec: docs/superpowers/specs/2026-09-27-pending-reprice-search-delete-design.md

-- --------------------------------------------------------------------------
-- Part 1: an item's new price reaches every bill not yet completed.
-- Every pending line is overwritten, hand-edited ones included (owner decision).
-- security definer: the admin editing the item may not hold write rights on
-- bill_items/bills under RLS; the trigger only touches new.vendor_id's rows.
-- --------------------------------------------------------------------------
create function reprice_pending_lines() returns trigger
  language plpgsql security definer set search_path = public as $$
declare
  v_bills uuid[];
begin
  -- Lock order: bills row before its bill_items, in bill id order -- the same
  -- order complete_bill / issue_token / amend and replace_bill_lines use, so
  -- this trigger cannot deadlock with them or reprice a bill completed under it.
  perform 1
     from bills b
    where b.vendor_id = new.vendor_id
      and b.status in ('recording', 'billed')
      and exists (select 1 from bill_items bi
                   where bi.bill_id = b.id and bi.item_id = new.id)
    order by b.id
      for update;

  -- Re-filter after locking: a bill may have completed while we waited.
  select array_agg(b.id) into v_bills
    from bills b
   where b.vendor_id = new.vendor_id
     and b.status in ('recording', 'billed')
     and exists (select 1 from bill_items bi
                  where bi.bill_id = b.id and bi.item_id = new.id);

  if v_bills is not null then
    update bill_items bi
       set unit_price = new.price,
           line_total = round(bi.qty_kg * new.price, 2)
     where bi.bill_id = any(v_bills)
       and bi.item_id = new.id;
  end if;

  if v_bills is null then
    return new;
  end if;

  -- Totals/messages filter status='billed': a recording bill's total is set by issue_token.
  update bills b
     set total = (select coalesce(sum(line_total), 0) from bill_items where bill_id = b.id)
   where b.id = any(v_bills) and b.status = 'billed';

  -- An unsent token message would quote the old figure.
  update outbound_messages m
     set payload = jsonb_set(m.payload, '{total}', to_jsonb(b.total))
    from bills b
   where m.bill_id = b.id and b.id = any(v_bills)
     and b.status = 'billed' and m.status = 'pending';

  return new;
end $$;

create trigger items_reprice_pending
  after update of price on items
  for each row
  when (new.price is distinct from old.price)
  execute function reprice_pending_lines();

-- --------------------------------------------------------------------------
-- Part 2: deleting a bill before it is completed.
-- A delete, not a status: nothing has happened yet (no stock, points or payment moves
-- before complete_bill), so there is nothing to keep on record. bill_items and
-- outbound_messages (bill_id, 0020) cascade.
-- The token comes back only when it was the latest one; renumbering later tokens
-- would confuse customers already holding them.
-- --------------------------------------------------------------------------
create function delete_pending_bill(p_bill_id uuid) returns void
  language plpgsql security definer set search_path = public as $$
declare
  v_bill bills%rowtype;
  v_last integer;
begin
  if current_vendor_id() is null or current_user_role() not in ('admin', 'biller') then
    raise exception 'only an admin or biller may delete a pending bill' using errcode = '42501';
  end if;

  -- Same order as issue_token: bill, then counter. issue_token locks the bill first and
  -- the counter second; taking them in the other order here could deadlock against a
  -- concurrent issue_token on the same bill.
  select * into v_bill from bills
   where id = p_bill_id and vendor_id = current_vendor_id() for update;
  if not found then
    raise exception 'bill % is not in your shop', p_bill_id using errcode = '42501';
  end if;
  if v_bill.status not in ('recording', 'billed') then
    raise exception 'bill % is %, only a pending bill may be deleted', p_bill_id, v_bill.status
      using errcode = '22023';
  end if;

  select last_token into v_last from vendor_counters
   where vendor_id = current_vendor_id() for update;

  delete from bills where id = p_bill_id;

  if v_bill.token_no is not null and v_bill.token_no = v_last then
    update vendor_counters
       set last_token = coalesce(
             (select max(token_no) from bills where vendor_id = v_bill.vendor_id), 0)
     where vendor_id = v_bill.vendor_id;
  end if;
end $$;

revoke all on function delete_pending_bill(uuid) from public, anon;
grant execute on function delete_pending_bill(uuid) to authenticated;
