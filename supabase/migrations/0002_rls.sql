-- The security boundary. There is no application server: these policies ARE the
-- authorization layer, so a missing policy is a cross-vendor data breach.

-- Resolve the caller's tenant and role from app_users. SECURITY DEFINER because
-- app_users itself is behind RLS and the policies below would otherwise recurse.
create function current_vendor_id() returns uuid
  language sql stable security definer set search_path = public as $$
  select vendor_id from app_users where id = auth.uid()
$$;

create function current_user_role() returns text
  language sql stable security definer set search_path = public as $$
  select role from app_users where id = auth.uid()
$$;

alter table vendors           enable row level security;
alter table vendor_counters   enable row level security;
alter table app_users         enable row level security;
alter table items             enable row level security;
alter table customers         enable row level security;
alter table bills             enable row level security;
alter table bill_items        enable row level security;
alter table points_ledger     enable row level security;
alter table stock_requests    enable row level security;
alter table outbound_messages enable row level security;

-- vendors: everyone in the tenant reads their own vendor row; only admin tunes the
-- loyalty config (#5).
create policy vendors_read on vendors for select to authenticated
  using (id = current_vendor_id());
create policy vendors_admin_update on vendors for update to authenticated
  using (id = current_vendor_id() and current_user_role() = 'admin')
  with check (id = current_vendor_id());

-- vendor_counters: readable within the tenant, writable by NO ONE. The only writer is
-- issue_token(), which is SECURITY DEFINER and therefore bypasses RLS entirely. This is
-- what makes token numbers unforgeable (#12).
create policy counters_read on vendor_counters for select to authenticated
  using (vendor_id = current_vendor_id());

-- app_users: visible within the tenant; only admin creates staff (#4).
create policy users_read on app_users for select to authenticated
  using (vendor_id = current_vendor_id());
create policy users_admin_write on app_users for all to authenticated
  using (vendor_id = current_vendor_id() and current_user_role() = 'admin')
  with check (vendor_id = current_vendor_id() and current_user_role() = 'admin');

-- items: everyone in the tenant reads (recorders need prices to build a basket);
-- only admin maintains the list, prices and stock (#2, #3). Stock is also written by
-- complete_bill(), which is SECURITY DEFINER and unaffected by this.
create policy items_read on items for select to authenticated
  using (vendor_id = current_vendor_id());
create policy items_admin_write on items for all to authenticated
  using (vendor_id = current_vendor_id() and current_user_role() = 'admin')
  with check (vendor_id = current_vendor_id() and current_user_role() = 'admin');

-- customers: readable in the tenant; admins and recorders create them (#11).
create policy customers_read on customers for select to authenticated
  using (vendor_id = current_vendor_id());
create policy customers_write on customers for all to authenticated
  using (vendor_id = current_vendor_id() and current_user_role() in ('admin','recorder'))
  with check (vendor_id = current_vendor_id() and current_user_role() in ('admin','recorder'));

-- bills: readable in the tenant (#14 history, dashboards). A recorder may create and edit
-- a basket only while it is still 'recording' — once issue_token has moved it to 'billed',
-- the basket is frozen and only complete_bill() may touch it.
create policy bills_read on bills for select to authenticated
  using (vendor_id = current_vendor_id());
create policy bills_recorder_insert on bills for insert to authenticated
  with check (vendor_id = current_vendor_id()
              and current_user_role() in ('admin','recorder')
              and status = 'recording');
create policy bills_recorder_update on bills for update to authenticated
  using (vendor_id = current_vendor_id()
         and current_user_role() in ('admin','recorder')
         and status = 'recording')
  with check (vendor_id = current_vendor_id() and status = 'recording');
create policy bills_recorder_delete on bills for delete to authenticated
  using (vendor_id = current_vendor_id()
         and current_user_role() in ('admin','recorder')
         and status = 'recording');

-- bill_items: same rule, expressed against the parent's status (#12 edit-before-Done).
create policy bill_items_read on bill_items for select to authenticated
  using (vendor_id = current_vendor_id());
create policy bill_items_write on bill_items for all to authenticated
  using (vendor_id = current_vendor_id()
         and current_user_role() in ('admin','recorder')
         and exists (select 1 from bills b where b.id = bill_id and b.status = 'recording'))
  with check (vendor_id = current_vendor_id()
              and current_user_role() in ('admin','recorder')
              and exists (select 1 from bills b where b.id = bill_id and b.status = 'recording'));

-- points_ledger: read-only to every role, forever. Append-only means no insert, update or
-- delete policy exists; complete_bill() writes it as definer (#15).
create policy points_read on points_ledger for select to authenticated
  using (vendor_id = current_vendor_id());

-- stock_requests: readable for the #10 dashboard. The bot inserts them as service_role,
-- which bypasses RLS; staff may clear handled ones.
create policy stock_requests_read on stock_requests for select to authenticated
  using (vendor_id = current_vendor_id());
create policy stock_requests_admin_delete on stock_requests for delete to authenticated
  using (vendor_id = current_vendor_id() and current_user_role() = 'admin');

-- outbound_messages: readable in the tenant so staff can see whether a message went out.
-- Written only by the billing functions and drained only by the Edge Function's
-- service_role key — no client write policy at all.
create policy outbound_read on outbound_messages for select to authenticated
  using (vendor_id = current_vendor_id());
