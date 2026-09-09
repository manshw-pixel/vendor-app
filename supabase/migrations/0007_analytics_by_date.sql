-- Dashboards that can answer a date range.
--
-- v_top_items and v_bought_together (0004) group over all history and carry no date
-- column at all, so "top items this week" is not a question they can answer. A dashboard
-- built on them would show a date filter that governs the payment figures and is silently
-- ignored by these two -- worse than no filter, because nothing on the screen says which
-- half it reached.
--
-- Functions rather than views, because a view cannot take a parameter. Added ALONGSIDE
-- the originals, which console.html still reads.
--
-- NEITHER IS `security definer`. A plain function runs with the caller's rights and
-- inherits the policies from 0002, which is the same property `security_invoker = true`
-- buys the views. Making either one definer would hand every vendor everyone else's
-- numbers.
--
-- Bounds are [p_from, p_to): half-open, so a caller passing midnight-to-midnight gets
-- whole days without double-counting the instant on the boundary.

create function top_items_between(p_from timestamptz, p_to timestamptz)
  returns table (
    item_id       uuid,
    name_en       text,
    name_hi       text,
    name_mr       text,
    total_qty_kg  numeric,
    total_revenue numeric
  )
  language sql stable as $$
  select bi.item_id, i.name_en, i.name_hi, i.name_mr,
         sum(bi.qty_kg)     as total_qty_kg,
         sum(bi.line_total) as total_revenue
    from bill_items bi
    join bills b on b.id = bi.bill_id
                and b.status = 'done'
                and b.completed_at >= p_from
                and b.completed_at <  p_to
    join items i on i.id = bi.item_id
   group by bi.item_id, i.name_en, i.name_hi, i.name_mr
   order by sum(bi.qty_kg) desc;
$$;

-- The 3-bill threshold is the product spec's (#8) and is applied WITHIN the window: a
-- pair that qualified last year but was bought once this week is not this week's pair.
create function bought_together_between(p_from timestamptz, p_to timestamptz)
  returns table (
    item_a     uuid,
    item_b     uuid,
    name_a     text,
    name_b     text,
    bill_count bigint
  )
  language sql stable as $$
  select a.item_id as item_a, b.item_id as item_b,
         ia.name_en as name_a, ib.name_en as name_b,
         count(distinct a.bill_id) as bill_count
    from bill_items a
    join bill_items b on b.bill_id = a.bill_id and a.item_id < b.item_id
    join bills bl on bl.id = a.bill_id
                 and bl.status = 'done'
                 and bl.completed_at >= p_from
                 and bl.completed_at <  p_to
    join items ia on ia.id = a.item_id
    join items ib on ib.id = b.item_id
   group by a.item_id, b.item_id, ia.name_en, ib.name_en
  having count(distinct a.bill_id) >= 3
   order by count(distinct a.bill_id) desc;
$$;

revoke all on function top_items_between(timestamptz, timestamptz) from public, anon;
revoke all on function bought_together_between(timestamptz, timestamptz) from public, anon;
grant execute on function top_items_between(timestamptz, timestamptz) to authenticated, service_role;
grant execute on function bought_together_between(timestamptz, timestamptz) to authenticated, service_role;
