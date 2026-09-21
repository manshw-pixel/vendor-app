-- Editing a bill after recording, and cost on the item form.
-- Spec: docs/superpowers/specs/2026-09-21-bill-edit-and-item-cost-design.md
--
-- Two features in one migration because they share nothing but the file. Part 1 lets a
-- pending bill be amended in place; part 2 lets an item be created with its cost, logging
-- the opening stock as a real purchase.

-- --------------------------------------------------------------------------
-- Part 1a: schema
-- --------------------------------------------------------------------------

-- Nullable, and deliberately NOT tied to a status by a check constraint the way
-- voided_at/voided_by are (0017): a bill may be amended and then completed, and the
-- stamps have to survive that transition.
alter table bills
  add column amended_at timestamptz,
  -- No ON DELETE, matching recorder_id/biller_id/voided_by: a staff member with history
  -- stays referenced.
  add column amended_by uuid references app_users(id);

comment on column bills.amended_at is 'When the basket was last rewritten after a token was issued (0020).';

-- outbound_messages (0001) has no way back to a bill: issue_token writes only
-- {token_no, total} into the payload. Amending a bill has to find the message quoting the
-- now-wrong total, so the link becomes a column.
--
-- Nullable: rows written before this migration have no bill, and neither does any future
-- message that is not about one.
alter table outbound_messages
  add column bill_id uuid references bills(id) on delete cascade;

-- Partial: the only query is "the still-pending messages for this bill".
create index outbound_bill_idx on outbound_messages(bill_id) where status = 'pending';

comment on column outbound_messages.bill_id is 'The bill this message is about, when it is about one (0020).';

-- --------------------------------------------------------------------------
-- Part 1b: issue_token, re-created to stamp bill_id.
-- Byte-for-byte 0003_functions.sql except for the insert at the end.
-- --------------------------------------------------------------------------
create or replace function issue_token(p_bill_id uuid)
  returns integer
  language plpgsql security definer set search_path = public as $$
declare
  v_bill   bills%rowtype;
  v_token  integer;
  v_total  numeric;
begin
  -- Lock the bill first so two calls on the SAME bill serialise; the status guard below
  -- then makes the second one fail rather than issue a second token.
  select * into v_bill from bills where id = p_bill_id for update;
  if not found then
    raise exception 'bill % not found', p_bill_id;
  end if;

  -- SECURITY DEFINER bypasses RLS, so the tenant and role checks that would normally
  -- live in policy have to be written here instead. current_vendor_id() is null for a
  -- caller with no end-user session (service role, or the superuser connection the test
  -- suite and the Edge Function use) — that's not an end user impersonating a vendor, so
  -- it's allowed through. A non-null vendor must match this bill's tenant.
  if current_vendor_id() is not null and current_vendor_id() <> v_bill.vendor_id then
    raise exception 'bill % does not belong to your vendor', p_bill_id;
  end if;
  if current_vendor_id() is not null and current_user_role() not in ('admin', 'recorder') then
    raise exception 'role % may not issue tokens', current_user_role();
  end if;

  if v_bill.status <> 'recording' then
    raise exception 'bill % is %, expected recording', p_bill_id, v_bill.status;
  end if;

  -- #3 (forgeable total): a recorder can set bills.total to anything while the bill is
  -- still 'recording' — trust the line items, not the client-supplied total.
  select coalesce(sum(line_total), 0) into v_total from bill_items where bill_id = p_bill_id;

  update vendor_counters
     set last_token = last_token + 1
   where vendor_id = v_bill.vendor_id
  returning last_token into v_token;

  update bills
     set token_no = v_token, status = 'billed', total = v_total
   where id = p_bill_id;

  -- #13: the customer is told their token and what to pay. Queued, never sent inline —
  -- a WhatsApp outage must not roll back a finished basket.
  -- bill_id added in 0020 so amend_pending_bill can find and supersede this row.
  insert into outbound_messages (vendor_id, customer_id, bill_id, template_key, payload)
  values (v_bill.vendor_id, v_bill.customer_id, p_bill_id, 'token_issued',
          jsonb_build_object('token_no', v_token, 'total', v_total));

  return v_token;
end $$;

-- --------------------------------------------------------------------------
-- Part 1c: amending a pending bill.
--
-- replace_bill_lines (0015, re-created in 0018) refuses anything past 'recording', and
-- the refusal is right for what that function does: past 'recording' the customer holds a
-- token, has been told a total, and a message quoting that total is queued. Rewriting the
-- lines there makes both of those a lie, and replace_bill_lines has no way to fix either.
--
-- This function is the same rewrite with those two consequences handled: the total is
-- recomputed the way issue_token computes it, and the queued message is superseded. The
-- token is deliberately KEPT -- the slip in the customer's hand stays valid, and the
-- counter is not advanced for a correction.
--
-- A done bill is not accepted here. Its effects have already landed (stock, points,
-- receipt, the day's figures) and void_bill (0017) already reverses all of them; "editing"
-- a completed bill is void-then-rebuild, which needs no function of its own.
-- --------------------------------------------------------------------------
create function amend_pending_bill(p_bill_id uuid, p_lines jsonb)
  returns void
  language plpgsql security definer set search_path = public as $$
declare
  v_bill  bills%rowtype;
  v_total numeric;
begin
  select * into v_bill from bills where id = p_bill_id for update;
  if not found then
    raise exception 'bill % not found', p_bill_id;
  end if;

  -- The same trust decision and the same role pair as replace_bill_lines: a null
  -- current_vendor_id() is a caller with no end-user session (service role, or the
  -- superuser connection the suite uses); a non-null one must own this bill. A biller
  -- does not rewrite baskets.
  if current_vendor_id() is not null and current_vendor_id() <> v_bill.vendor_id then
    raise exception 'bill % does not belong to your vendor', p_bill_id
      using errcode = '42501';
  end if;
  if current_vendor_id() is not null and current_user_role() not in ('admin', 'recorder') then
    raise exception 'role % may not amend a bill', current_user_role()
      using errcode = '42501';
  end if;

  if v_bill.status <> 'billed' then
    raise exception 'bill % is %, expected billed', p_bill_id, v_bill.status
      using errcode = 'P0001';
  end if;

  -- Refused, never treated as "clear the bill" -- same reasoning as replace_bill_lines.
  if jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) = 0 then
    raise exception 'refusing to leave bill % with no lines', p_bill_id
      using errcode = '22023';
  end if;

  -- Checked BEFORE the delete, so a refused basket leaves the existing lines untouched.
  perform assert_whole_qty(l.item_id, l.qty_kg)
    from jsonb_to_recordset(p_lines) as l(item_id uuid, qty_kg numeric);

  delete from bill_items where bill_id = p_bill_id;

  -- line_total computed, unit_price the caller's: identical to replace_bill_lines, and
  -- for the identical reasons (a client-supplied line_total would forge the total; a
  -- live items.price read would change a basket already on screen).
  insert into bill_items (bill_id, vendor_id, item_id, qty_kg, unit_price, line_total)
  select p_bill_id, v_bill.vendor_id, l.item_id, l.qty_kg, l.unit_price,
         round(l.qty_kg * l.unit_price, 2)
    from jsonb_to_recordset(p_lines)
      as l(item_id uuid, qty_kg numeric, unit_price numeric);

  -- The total issue_token would have computed, from the rows just written.
  select coalesce(sum(line_total), 0) into v_total from bill_items where bill_id = p_bill_id;

  update bills
     set total = v_total, amended_at = now(), amended_by = auth.uid()
   where id = p_bill_id;

  -- Supersede, by DELETING the still-pending rows rather than adding a 'cancelled'
  -- status: the row was never sent, so there is no history in it to keep, and a delete
  -- needs no change to the status check constraint or to the sender's pending scan.
  -- A row already 'sent' or 'failed' is history and is left exactly where it is.
  delete from outbound_messages
   where bill_id = p_bill_id and status = 'pending';

  insert into outbound_messages (vendor_id, customer_id, bill_id, template_key, payload)
  values (v_bill.vendor_id, v_bill.customer_id, p_bill_id, 'token_amended',
          jsonb_build_object('token_no', v_bill.token_no, 'total', v_total));
end $$;

revoke all on function amend_pending_bill(uuid, jsonb) from public, anon;
grant execute on function amend_pending_bill(uuid, jsonb) to authenticated;
