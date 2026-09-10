-- Wipes a vendor's transactional history: bills, their line items, the points ledger,
-- customers, stock requests and the outbound queue. The item catalogue, the staff roster
-- and the vendors row survive.
--
-- SECURITY DEFINER is not a convenience here, it is the only option. 0002_rls.sql grants
-- NO write policy at all on points_ledger, vendor_counters or outbound_messages -- the
-- suite asserts "no role can write the points ledger directly" -- so a client cannot
-- perform these deletes under its own rights however it is authorised.
--
-- Everything is scoped to current_vendor_id(). A missing vendor_id predicate on any one
-- of these statements would silently destroy another shop's entire history, which is why
-- the test for that is the largest one in tests/clear_vendor_data.test.mjs.
create function clear_vendor_data()
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
