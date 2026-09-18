-- Voiding a completed bill: spec docs/superpowers/specs/2026-09-18-void-bill-design.md
--
-- A status, not a delete. Every dashboard function, view, the completed list and the
-- receipt lookup filter on status = 'done', so a voided bill leaves every figure by
-- itself while its token, lines, receipt and ledger rows stay on record.

alter table bills drop constraint bills_status_check;
alter table bills add constraint bills_status_check
  check (status in ('recording','billed','done','voided'));

alter table bills
  add column voided_at   timestamptz,
  -- No ON DELETE, like recorder_id/biller_id: a staff member with history stays.
  add column voided_by   uuid references app_users(id),
  add column void_reason text;

alter table bills add constraint bills_voided_stamps_check check (
  (status = 'voided' and voided_at is not null and length(btrim(coalesce(void_reason,''))) > 0)
  or (status <> 'voided' and voided_at is null and voided_by is null and void_reason is null)
);

create function void_bill(p_bill_id uuid, p_reason text) returns void
  language plpgsql security definer set search_path = public as $$
declare
  v_bill      bills%rowtype;
  v_reversed  integer := 0;
  v_refunded  integer := 0;
begin
  -- Only a signed-in admin or biller of the bill's own shop. A null vendor (service role)
  -- is refused: voided_by must be a real staff member.
  if current_vendor_id() is null or current_user_role() not in ('admin', 'biller') then
    raise exception 'only an admin or biller may void a bill' using errcode = '42501';
  end if;

  select * into v_bill from bills where id = p_bill_id and vendor_id = current_vendor_id() for update;
  if not found then
    raise exception 'bill % is not in your shop', p_bill_id using errcode = '42501';
  end if;

  -- Idempotent: a double tap or a retried request must not restore stock twice.
  if v_bill.status = 'voided' then
    return;
  end if;
  if v_bill.status <> 'done' then
    raise exception 'bill is not done' using errcode = 'P0001';
  end if;

  -- Same calendar day as completion, in the shops' timezone. Every shop is in India, so
  -- the zone is a business rule here even though the web avoids hardcoding one for
  -- display. A bill voided after the day is closed would move totals the owner has
  -- already reconciled against the cash drawer.
  if (v_bill.completed_at at time zone 'Asia/Kolkata')::date
     <> (now() at time zone 'Asia/Kolkata')::date then
    raise exception 'void window closed' using errcode = 'P0001';
  end if;

  if p_reason is null or length(btrim(p_reason)) = 0 then
    raise exception 'a reason is required' using errcode = '22023';
  end if;

  -- Stock back. Not capped: stock has no upper bound. No stock_movements row -- the
  -- voided bill is itself the record of why stock rose.
  update items i
     set stock_kg = i.stock_kg + agg.qty
    from (select item_id, sum(qty_kg) as qty from bill_items where bill_id = p_bill_id group by item_id) agg
   where i.id = agg.item_id;

  -- Points: mirror every ledger row of this bill with the opposite sign and the SAME
  -- expires_at, so each reversal lapses with the batch it cancels. Awards (positive)
  -- become claw-backs and may push the balance negative if already spent -- the owner
  -- chose an honest ledger over a windfall. Redemptions (negative) become refunds.
  select coalesce(sum(points) filter (where points > 0), 0),
         coalesce(-sum(points) filter (where points < 0), 0)
    into v_reversed, v_refunded
    from points_ledger where bill_id = p_bill_id;

  insert into points_ledger (vendor_id, customer_id, bill_id, points, expires_at)
  select vendor_id, customer_id, bill_id, -points, expires_at
    from points_ledger
   where bill_id = p_bill_id;

  if v_bill.customer_id is not null then
    insert into outbound_messages (vendor_id, customer_id, template_key, payload)
    values (v_bill.vendor_id, v_bill.customer_id, 'bill_voided',
            jsonb_build_object('bill_id', p_bill_id, 'token_no', v_bill.token_no,
                               'total', v_bill.total,
                               'points_reversed', coalesce(v_reversed, 0),
                               'points_refunded', coalesce(v_refunded, 0)));
  end if;

  update bills
     set status = 'voided', voided_at = now(), voided_by = auth.uid(), void_reason = btrim(p_reason)
   where id = p_bill_id;
end $$;

revoke all on function void_bill(uuid, text) from public, anon;
grant execute on function void_bill(uuid, text) to authenticated;
