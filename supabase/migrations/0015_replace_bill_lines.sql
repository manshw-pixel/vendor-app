-- Slice B: make the line-write safe to repeat.
--
-- The client used to say "add these lines". That cannot be repeated safely: a reply lost
-- after a committed insert leads the retry to insert the same basket again, issue_token
-- recomputes a doubled total, and the customer is asked to pay twice for one basket.
-- Nothing downstream can detect it -- the doubled total IS the total, on every screen and
-- on the printed receipt.
--
-- data.ts carried a check-then-insert mitigation (billHasLines) and its own comment said
-- what this is: "a mitigation, not a fix". The check is not atomic with the insert, so a
-- request still genuinely in flight defeats it.
--
-- This function says "the lines for this bill are exactly these" instead. Delete and
-- insert in one transaction is idempotent by construction: called once or five times with
-- the same basket, the rows are identical. The retry needs no cleverness at all, which is
-- why the client loses code rather than gaining a layer.
create function replace_bill_lines(p_bill_id uuid, p_lines jsonb)
  returns void
  language plpgsql security definer set search_path = public as $$
declare
  v_bill bills%rowtype;
begin
  select * into v_bill from bills where id = p_bill_id for update;
  if not found then
    raise exception 'bill % not found', p_bill_id;
  end if;

  -- Same trust decision as issue_token() and complete_bill(): a null current_vendor_id()
  -- means the caller has no end-user session (service role, or the superuser connection
  -- the test suite uses), which is allowed; a non-null one must own this bill. A biller
  -- has no business rewriting a basket, so only admin and recorder pass -- the same pair
  -- issue_token() accepts.
  if current_vendor_id() is not null and current_vendor_id() <> v_bill.vendor_id then
    raise exception 'bill % does not belong to your vendor', p_bill_id;
  end if;
  if current_vendor_id() is not null and current_user_role() not in ('admin', 'recorder') then
    raise exception 'role % may not record bill lines', current_user_role();
  end if;

  -- The bill's own lifecycle is what makes a DESTRUCTIVE replace safe. Past 'recording'
  -- the customer has been handed a token and told a total, and the outbound_messages row
  -- quoting that total is already queued (0003_functions.sql:54-56). Rewriting the lines
  -- then would make both of those a lie, and issue_token's guard cannot catch it because
  -- issue_token has already run.
  if v_bill.status <> 'recording' then
    raise exception 'bill % is %, expected recording', p_bill_id, v_bill.status;
  end if;

  -- Refused, never treated as "clear the bill". Bill.tsx disables Done at zero lines, so
  -- an empty basket can only be a bug -- and accepting one would let a retry turn a real
  -- bill into a zero-rupee one.
  if jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) = 0 then
    raise exception 'refusing to leave bill % with no lines', p_bill_id;
  end if;

  delete from bill_items where bill_id = p_bill_id;

  -- line_total is COMPUTED here, and is deliberately absent from the input. issue_token
  -- sums the stored line_totals, so a client-supplied one let a crafted request set a
  -- bill's total to anything -- RLS stops another vendor's data being touched, but not a
  -- recorder's own client sending line_total 1 for 5kg of tomatoes.
  --
  -- unit_price is still the caller's, NOT items.price. The price at the moment of
  -- recording is the correct price; reading the live one would let an admin editing a
  -- price mid-bill change a basket already on the recorder's screen.
  --
  -- round(x, 2) matches billing.ts's Math.round(x * 100) / 100 for every value the app can
  -- produce (validateWeight caps qty at two decimals). The two must agree: runningTotal()
  -- is what the recorder reads off the screen, and issue_token sums these rows.
  insert into bill_items (bill_id, vendor_id, item_id, qty_kg, unit_price, line_total)
  select p_bill_id, v_bill.vendor_id, l.item_id, l.qty_kg, l.unit_price,
         round(l.qty_kg * l.unit_price, 2)
    from jsonb_to_recordset(p_lines)
      as l(item_id uuid, qty_kg numeric, unit_price numeric);
end $$;

revoke all on function replace_bill_lines(uuid, jsonb) from public, anon;
grant execute on function replace_bill_lines(uuid, jsonb) to authenticated;
