-- Requirements #20, #10 and the #9 bell's data source, plus an i18n fix to the
-- bought-together card.
--
-- #20 was specified as customers messaging the WhatsApp bot. WhatsApp is on hold for
-- want of a sender number, and the demand data behind #10 does not need the bot: staff
-- hear the requests at the counter, and logging them there also catches the walk-ins who
-- ask and leave without buying.

alter table stock_requests
  add column status text not null default 'open'
    check (status in ('open', 'handled'));

comment on column stock_requests.status is
  'Worklist state for staff. v_stock_request_counts and stock_requests_between() ignore '
  'it DELIBERATELY: handling a request does not un-ask it, and #10 is demand history.';

-- item_name is what v_stock_request_counts groups on. A blank one is a row that can
-- never be acted on and silently skews nothing -- refuse it at the boundary.
alter table stock_requests
  add constraint stock_requests_item_name_not_blank
    check (length(btrim(item_name)) > 0);

-- 0001 shipped this table with a read policy and an admin delete, on the assumption the
-- bot would insert as service_role (which bypasses RLS). Staff now write it directly.
create policy stock_requests_staff_insert on stock_requests for insert to authenticated
  with check (vendor_id = current_vendor_id()
              and current_user_role() in ('recorder', 'admin'));

-- The update permits editing item_name as well as status, not just status alone. No
-- screen exposes editing item_name today, but v_stock_request_counts groups on
-- lower(item_name), so a typo fragments the count into two rows, and this leaves room
-- for a future affordance to let the person who made it repair it. Narrowing this to
-- status alone would need a column-level grant; no migration in this project issues
-- explicit grants, and this is not the place to introduce the pattern.
create policy stock_requests_staff_update on stock_requests for update to authenticated
  using (vendor_id = current_vendor_id()
         and current_user_role() in ('recorder', 'admin'))
  with check (vendor_id = current_vendor_id());

-- Deleting a handled request destroys the evidence of the demand that #10 reports:
-- stock the item because eleven people asked, clear those eleven, and the dashboard
-- then says nobody ever wanted it. Marking handled replaces clearing.
drop policy if exists stock_requests_admin_delete on stock_requests;

-- #10, date-ranged. Deliberately the same shape as top_items_between() in 0007: the
-- dashboard has one date filter and every card respects it.
create function stock_requests_between(p_from timestamptz, p_to timestamptz)
  returns table (
    item_name         text,
    request_count     bigint,
    last_requested_at timestamptz
  )
  language sql stable as $$
  select lower(sr.item_name) as item_name,
         count(*) as request_count,
         max(sr.created_at) as last_requested_at
    from stock_requests sr
   where sr.created_at >= p_from
     and sr.created_at <  p_to
   group by lower(sr.item_name)
   order by count(*) desc, lower(sr.item_name)
   limit 10;
$$;

revoke all on function stock_requests_between(timestamptz, timestamptz) from public, anon;
grant execute on function stock_requests_between(timestamptz, timestamptz) to authenticated, service_role;

-- The bought-together card rendered name_en regardless of the UI language, so a Marathi
-- admin saw Marathi in the Top Items card and English in the card directly below it.
-- Return all three names per side and let the client pick.
--
-- DROP then CREATE, not CREATE OR REPLACE: Postgres will not let a replace change a
-- return type. The argument list is unchanged, so the PostgREST overload ambiguity that
-- 0010 warns about does not arise here.
drop function if exists bought_together_between(timestamptz, timestamptz);

create function bought_together_between(p_from timestamptz, p_to timestamptz)
  returns table (
    item_a     uuid,
    item_b     uuid,
    name_a_en  text,
    name_a_hi  text,
    name_a_mr  text,
    name_b_en  text,
    name_b_hi  text,
    name_b_mr  text,
    bill_count bigint
  )
  language sql stable as $$
  select a.item_id as item_a, b.item_id as item_b,
         ia.name_en, ia.name_hi, ia.name_mr,
         ib.name_en, ib.name_hi, ib.name_mr,
         count(distinct a.bill_id) as bill_count
    from bill_items a
    join bill_items b on b.bill_id = a.bill_id and a.item_id < b.item_id
    join bills bl on bl.id = a.bill_id
                 and bl.status = 'done'
                 and bl.completed_at >= p_from
                 and bl.completed_at <  p_to
    join items ia on ia.id = a.item_id
    join items ib on ib.id = b.item_id
   group by a.item_id, b.item_id,
            ia.name_en, ia.name_hi, ia.name_mr,
            ib.name_en, ib.name_hi, ib.name_mr
  having count(distinct a.bill_id) >= 3
   order by count(distinct a.bill_id) desc, a.item_id, b.item_id
   limit 10;
$$;

revoke all on function bought_together_between(timestamptz, timestamptz) from public, anon;
grant execute on function bought_together_between(timestamptz, timestamptz) to authenticated, service_role;
