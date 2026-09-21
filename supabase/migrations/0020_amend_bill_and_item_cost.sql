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

  if current_vendor_id() is not null and current_vendor_id() <> v_bill.vendor_id then
    raise exception 'bill % does not belong to your vendor', p_bill_id;
  end if;
  if current_vendor_id() is not null and current_user_role() not in ('admin', 'recorder') then
    raise exception 'role % may not issue tokens', current_user_role();
  end if;

  if v_bill.status <> 'recording' then
    raise exception 'bill % is %, expected recording', p_bill_id, v_bill.status;
  end if;

  -- #3 (forgeable total): trust the line items, not the client-supplied total.
  select coalesce(sum(line_total), 0) into v_total from bill_items where bill_id = p_bill_id;

  update vendor_counters
     set last_token = last_token + 1
   where vendor_id = v_bill.vendor_id
  returning last_token into v_token;

  update bills
     set token_no = v_token, status = 'billed', total = v_total
   where id = p_bill_id;

  -- #13: the customer is told their token and what to pay. Queued, never sent inline.
  -- bill_id added in 0020 so amend_pending_bill can find and supersede this row.
  insert into outbound_messages (vendor_id, customer_id, bill_id, template_key, payload)
  values (v_bill.vendor_id, v_bill.customer_id, p_bill_id, 'token_issued',
          jsonb_build_object('token_no', v_token, 'total', v_total));

  return v_token;
end $$;
