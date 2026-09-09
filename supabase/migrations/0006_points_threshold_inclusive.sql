-- Make the first spend tier inclusive, so a bill at exactly the threshold earns points.
--
-- 0003 implemented product-spec #15 literally: "spend above 600 -> 50 points; spend 1000
-- or above -> 100 points". That asymmetry is faithful to the sentence and wrong in a
-- shop. A vendor sets a 600 target, rings up a 600 sale, and the customer earns nothing
-- -- while a 1000 sale on the identical rule does pay out. It was reported from the live
-- shop as a bug, which is the useful signal: the rule cannot be explained to the person
-- standing at the counter.
--
-- Both tiers are now inclusive. The spec sentence has been corrected to match.
--
-- This is NOT retroactive. points_ledger is append-only and nothing recomputes a past
-- bill, so customers who were skipped at exactly the threshold stay skipped unless
-- someone inserts ledger rows by hand. Same property the Settings screen warns admins
-- about when they change these numbers.
--
-- Replaces the function whole rather than patching it: create or replace needs the full
-- body, and a partial copy here would rot against 0003 the first time either changes.
create or replace function complete_bill(p_bill_id uuid, p_biller_id uuid default null)
  returns void
  language plpgsql security definer set search_path = public as $$
declare
  v_bill    bills%rowtype;
  v_vendor  vendors%rowtype;
  v_points  integer := 0;
  v_total   numeric;
begin
  select * into v_bill from bills where id = p_bill_id for update;
  if not found then
    raise exception 'bill % not found', p_bill_id;
  end if;

  -- Same trust decision as issue_token(): a null current_vendor_id() means the caller has
  -- no end-user session (service role / superuser), which is allowed; a non-null one must
  -- own this bill, and if it's an end user, only admin or biller may complete a sale.
  if current_vendor_id() is not null and current_vendor_id() <> v_bill.vendor_id then
    raise exception 'bill % does not belong to your vendor', p_bill_id;
  end if;
  if current_vendor_id() is not null and current_user_role() not in ('admin', 'biller') then
    raise exception 'role % may not complete bills', current_user_role();
  end if;

  -- Idempotent by guard: a retried request (double click, network retry) must not award
  -- points twice or decrement stock twice. Already-done is success, not an error.
  if v_bill.status = 'done' then
    return;
  end if;
  if v_bill.status <> 'billed' then
    raise exception 'bill % is %, expected billed', p_bill_id, v_bill.status;
  end if;

  select * into v_vendor from vendors where id = v_bill.vendor_id;

  -- #3 (forgeable total): recompute the authoritative total from the line items rather
  -- than trusting bills.total, which a recorder could set to anything while the bill was
  -- still 'recording'. This is what the points decision (and the stored total) is based on.
  select coalesce(sum(line_total), 0) into v_total from bill_items where bill_id = p_bill_id;

  -- Stock (#3). greatest(...,0) keeps the non-negative check from turning an
  -- over-sold line into a hard failure at the counter with a customer waiting.
  update items i
     set stock_kg = greatest(i.stock_kg - agg.qty, 0)
    from (select item_id, sum(qty_kg) as qty
            from bill_items where bill_id = p_bill_id group by item_id) agg
   where i.id = agg.item_id;

  -- Points (#15). Thresholds and rewards are this vendor's config, never constants.
  -- Both comparisons are >=: a spend that reaches a target earns that target's reward.
  -- The strict > on tier 1 is what 0006 exists to correct.
  if v_total >= v_vendor.points_threshold_2 then
    v_points := v_vendor.points_reward_2;
  elsif v_total >= v_vendor.points_threshold_1 then
    v_points := v_vendor.points_reward_1;
  end if;

  if v_points > 0 and v_bill.customer_id is not null then
    insert into points_ledger (vendor_id, customer_id, bill_id, points, expires_at)
    values (v_bill.vendor_id, v_bill.customer_id, p_bill_id, v_points,
            now() + (v_vendor.redeem_days || ' days')::interval);

    -- #16: tell the customer their points, queued in the same transaction.
    insert into outbound_messages (vendor_id, customer_id, template_key, payload)
    values (v_bill.vendor_id, v_bill.customer_id, 'points_awarded',
            jsonb_build_object('points', v_points, 'total', v_total,
                               'expires_in_days', v_vendor.redeem_days));
  end if;

  -- #7 (forgeable attribution): prefer the real signed-in caller over the client-supplied
  -- argument. p_biller_id only applies for a service-role caller, which has no auth.uid().
  update bills
     set status = 'done',
         completed_at = now(),
         total = v_total,
         biller_id = coalesce(auth.uid(), p_biller_id, biller_id)
   where id = p_bill_id;
end $$;

-- create or replace preserves the existing grants, but restate them so this file stands
-- on its own if it is ever replayed into a fresh database.
revoke all on function complete_bill(uuid, uuid) from public, anon;
grant execute on function complete_bill(uuid, uuid) to authenticated;
