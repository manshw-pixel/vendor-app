-- Dues (udhaar): opening balances, repayments and reversals.
-- Spec: docs/superpowers/specs/2026-09-24-dues-design.md

-- ---------------------------------------------------------------------------
-- Entries
-- ---------------------------------------------------------------------------

-- Only what bills do not already record. A credit CHARGE is a done bill with a 'credit'
-- bill_payments row; it is never copied here, so a void needs no second write.
create table dues_entries (
  id             uuid primary key default gen_random_uuid(),
  vendor_id      uuid not null references vendors(id) on delete cascade,
  -- No ON DELETE: only clear_vendor_data deletes customers, and it deletes these first.
  customer_id    uuid not null references customers(id),
  kind           text not null check (kind in ('opening', 'repayment')),
  amount         numeric(10,2) not null check (amount > 0),
  mode           text check (mode in ('cash', 'upi', 'card')),
  note           text,
  -- The Asia/Kolkata date the entry was made: the day whose cash a repayment belongs to.
  business_date  date not null,
  created_by     uuid not null references app_users(id),
  created_at     timestamptz not null default now(),
  reversed_at    timestamptz,
  reversed_by    uuid references app_users(id),
  reverse_reason text,
  constraint dues_entries_mode_iff_repayment check ((kind = 'repayment') = (mode is not null)),
  constraint dues_entries_opening_note check (kind <> 'opening' or length(btrim(coalesce(note, ''))) > 0),
  constraint dues_entries_reverse_stamps check (
    (reversed_at is null and reversed_by is null and reverse_reason is null)
    or (reversed_at is not null and reversed_by is not null
        and length(btrim(coalesce(reverse_reason, ''))) > 0)
  )
);
create index dues_entries_customer_idx on dues_entries(vendor_id, customer_id);
create index dues_entries_day_idx on dues_entries(vendor_id, business_date) where kind = 'repayment';

alter table dues_entries enable row level security;

-- Read for every role in the shop. No write policy: the functions below are the only writers.
create policy dues_entries_read on dues_entries for select to authenticated
  using (vendor_id = current_vendor_id());

-- ---------------------------------------------------------------------------
-- The balance: the ONE definition every reader and writer uses
-- ---------------------------------------------------------------------------

-- Credit bills still done, plus openings, minus repayments; reversed entries ignored.
-- Negative means overpaid (a credit bill voided after a part-payment). Invoker rights: a
-- client sees 0 for another shop's customer because RLS hides every row it would sum.
create function customer_due(p_customer uuid) returns numeric
  language sql stable as $$
  select coalesce((select sum(p.amount)
                     from bills b join bill_payments p on p.bill_id = b.id
                    where b.customer_id = p_customer and b.status = 'done' and p.mode = 'credit'), 0)
       + coalesce((select sum(amount) from dues_entries
                    where customer_id = p_customer and kind = 'opening' and reversed_at is null), 0)
       - coalesce((select sum(amount) from dues_entries
                    where customer_id = p_customer and kind = 'repayment' and reversed_at is null), 0);
$$;

revoke all on function customer_due(uuid) from public, anon;
grant execute on function customer_due(uuid) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Writers
-- ---------------------------------------------------------------------------

create function record_repayment(p_customer uuid, p_amount numeric, p_mode text, p_note text default null)
  returns dues_entries
  language plpgsql security definer set search_path = public as $$
declare
  v_vendor uuid := current_vendor_id();
  v_today  date := (now() at time zone 'Asia/Kolkata')::date;
  v_row    dues_entries%rowtype;
begin
  if v_vendor is null or current_user_role() not in ('admin', 'biller') then
    raise exception 'only an admin or biller may record a repayment' using errcode = '42501';
  end if;
  if p_mode is null or p_mode not in ('cash', 'upi', 'card') then
    raise exception 'a repayment mode is required (cash, upi or card)' using errcode = '22023';
  end if;
  if p_amount is null or p_amount <= 0 or p_amount <> round(p_amount, 2) then
    raise exception 'amount must be more than zero, to the paisa' using errcode = '22023';
  end if;

  -- Same order as complete_bill: the vendor FOR SHARE (so close_day, which takes it FOR
  -- UPDATE, either counts this repayment or makes it wait and refuses it below), then the
  -- customer FOR UPDATE (so two tills cannot both take the last payment -- a row lock on
  -- existing entries would not stop a concurrent INSERT).
  perform 1 from vendors where id = v_vendor for share;
  perform 1 from customers where id = p_customer and vendor_id = v_vendor for update;
  if not found then
    raise exception 'customer is not in your shop' using errcode = '42501';
  end if;

  if exists (select 1 from day_closes
              where vendor_id = v_vendor and business_date = v_today and reopened_at is null) then
    raise exception 'day is closed' using errcode = 'P0001';
  end if;

  -- A new statement after both locks, so under READ COMMITTED it sees a payment the other
  -- till just committed.
  if p_amount > customer_due(p_customer) then
    raise exception 'more than the balance' using errcode = 'P0001';
  end if;

  insert into dues_entries (vendor_id, customer_id, kind, amount, mode, note, business_date, created_by)
  values (v_vendor, p_customer, 'repayment', p_amount, p_mode,
          nullif(btrim(coalesce(p_note, '')), ''), v_today, auth.uid())
  returning * into v_row;
  return v_row;
end $$;

revoke all on function record_repayment(uuid, numeric, text, text) from public, anon;
grant execute on function record_repayment(uuid, numeric, text, text) to authenticated;

-- Udhaar already in the paper khata. Moves no cash, so no day lock.
create function record_opening_balance(p_customer uuid, p_amount numeric, p_note text)
  returns dues_entries
  language plpgsql security definer set search_path = public as $$
declare
  v_vendor uuid := current_vendor_id();
  v_row    dues_entries%rowtype;
begin
  if v_vendor is null or current_user_role() <> 'admin' then
    raise exception 'only an admin may add an opening balance' using errcode = '42501';
  end if;
  if p_amount is null or p_amount <= 0 or p_amount <> round(p_amount, 2) then
    raise exception 'amount must be more than zero, to the paisa' using errcode = '22023';
  end if;
  if length(btrim(coalesce(p_note, ''))) = 0 then
    raise exception 'a note is required' using errcode = '22023';
  end if;

  perform 1 from customers where id = p_customer and vendor_id = v_vendor for update;
  if not found then
    raise exception 'customer is not in your shop' using errcode = '42501';
  end if;

  insert into dues_entries (vendor_id, customer_id, kind, amount, mode, note, business_date, created_by)
  values (v_vendor, p_customer, 'opening', p_amount, null, btrim(p_note),
          (now() at time zone 'Asia/Kolkata')::date, auth.uid())
  returning * into v_row;
  return v_row;
end $$;

revoke all on function record_opening_balance(uuid, numeric, text) from public, anon;
grant execute on function record_opening_balance(uuid, numeric, text) to authenticated;

-- Stamps, never deletes: who, when and why stay on record.
create function reverse_dues_entry(p_entry uuid, p_reason text) returns dues_entries
  language plpgsql security definer set search_path = public as $$
declare
  v_vendor uuid := current_vendor_id();
  v_row    dues_entries%rowtype;
begin
  if v_vendor is null or current_user_role() not in ('admin', 'biller') then
    raise exception 'only an admin or biller may reverse an entry' using errcode = '42501';
  end if;
  if length(btrim(coalesce(p_reason, ''))) = 0 then
    raise exception 'a reason is required' using errcode = '22023';
  end if;

  -- The vendor first, as in record_repayment: a reversal of today's cash repayment must
  -- not slip past a close that is counting it.
  perform 1 from vendors where id = v_vendor for share;
  select * into v_row from dues_entries where id = p_entry and vendor_id = v_vendor for update;
  if not found then
    raise exception 'entry is not in your shop' using errcode = '42501';
  end if;
  if v_row.kind = 'opening' and current_user_role() <> 'admin' then
    raise exception 'only an admin may reverse an opening balance' using errcode = '42501';
  end if;
  if v_row.reversed_at is not null then
    raise exception 'already reversed' using errcode = 'P0001';
  end if;
  -- A closed day's cash never changes afterwards.
  if v_row.kind = 'repayment' and exists (
       select 1 from day_closes
        where vendor_id = v_vendor and business_date = v_row.business_date and reopened_at is null) then
    raise exception 'day is closed' using errcode = 'P0001';
  end if;

  update dues_entries
     set reversed_at = now(), reversed_by = auth.uid(), reverse_reason = btrim(p_reason)
   where id = p_entry
  returning * into v_row;
  return v_row;
end $$;

revoke all on function reverse_dues_entry(uuid, text) from public, anon;
grant execute on function reverse_dues_entry(uuid, text) to authenticated;
