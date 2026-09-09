-- Billing lifecycle. Both functions are SECURITY DEFINER: the client may CALL them but has
-- no write policy on vendor_counters, items.stock_kg or points_ledger, so tokens, stock and
-- points cannot be forged from the browser.

-- #12: recorder finishes the basket. Token comes from UPDATE ... RETURNING, which is
-- atomic under the row lock. max(token_no) + 1 in app code would hand two recorders
-- pressing Done in the same second the same token.
create function issue_token(p_bill_id uuid)
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
  insert into outbound_messages (vendor_id, customer_id, template_key, payload)
  values (v_bill.vendor_id, v_bill.customer_id, 'token_issued',
          jsonb_build_object('token_no', v_token, 'total', v_total));

  return v_token;
end $$;

revoke all on function issue_token(uuid) from public, anon;
grant execute on function issue_token(uuid) to authenticated;

-- #14/#15: biller takes payment. Stock, points and status move together or not at all —
-- a bill that is 'done' with stock unadjusted is the failure this design exists to prevent.
create function complete_bill(p_bill_id uuid, p_biller_id uuid default null)
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
  -- NOTE: superseded by 0006, which makes threshold 1 inclusive as well. This body is
  -- kept as the historical record of what was deployed; the live definition is 0006's.
  if v_total >= v_vendor.points_threshold_2 then
    v_points := v_vendor.points_reward_2;
  elsif v_total > v_vendor.points_threshold_1 then
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

revoke all on function complete_bill(uuid, uuid) from public, anon;
grant execute on function complete_bill(uuid, uuid) to authenticated;

-- #17: the bot answers "how many points do I have, and how long have I got?"
-- Called by the webhook with the service role, so it is a definer function reading across
-- the tenant boundary deliberately — the caller has already matched the customer by their
-- WhatsApp sender number.
-- Same null-aware tenant guard as issue_token()/complete_bill(): a null current_vendor_id()
-- means no end-user session (the webhook calls this as service_role after matching the
-- sender's phone number itself, deliberately crossing tenants), so it passes through; a
-- signed-in end user may only ever ask about a customer in their own vendor.
create function customer_points_balance(p_customer_id uuid)
  returns table (balance integer, days_left integer)
  language plpgsql stable security definer set search_path = public as $$
begin
  if current_vendor_id() is not null and current_vendor_id() <>
     (select vendor_id from customers where id = p_customer_id) then
    raise exception 'customer % does not belong to your vendor', p_customer_id;
  end if;

  return query
  select
    coalesce(sum(points), 0)::integer as balance,
    case when coalesce(sum(points), 0) > 0
         then ceil(extract(epoch from (min(expires_at) - now())) / 86400)::integer
    end as days_left
  from points_ledger
  where customer_id = p_customer_id
    and expires_at > now();
end $$;

revoke all on function customer_points_balance(uuid) from public, anon;
grant execute on function customer_points_balance(uuid) to authenticated, service_role;
