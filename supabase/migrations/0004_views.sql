-- Dashboards. Every view is security_invoker so it runs with the CALLER's rights and
-- inherits the RLS policies from 0002. Without that flag a view runs as its owner
-- (postgres) and hands every vendor everyone else's numbers.

-- #6: payments collected, three grains over the same base.
create view v_payments_daily with (security_invoker = true) as
  select vendor_id, date_trunc('day', completed_at) as bucket,
         sum(total) as total_collected, count(*) as bill_count
    from bills where status = 'done'
   group by vendor_id, date_trunc('day', completed_at);

create view v_payments_weekly with (security_invoker = true) as
  select vendor_id, date_trunc('week', completed_at) as bucket,
         sum(total) as total_collected, count(*) as bill_count
    from bills where status = 'done'
   group by vendor_id, date_trunc('week', completed_at);

create view v_payments_monthly with (security_invoker = true) as
  select vendor_id, date_trunc('month', completed_at) as bucket,
         sum(total) as total_collected, count(*) as bill_count
    from bills where status = 'done'
   group by vendor_id, date_trunc('month', completed_at);

-- #7: most items sold, by weight.
create view v_top_items with (security_invoker = true) as
  select bi.vendor_id, bi.item_id, i.name_en,
         sum(bi.qty_kg) as total_qty_kg, sum(bi.line_total) as total_revenue
    from bill_items bi
    join bills b on b.id = bi.bill_id and b.status = 'done'
    join items i on i.id = bi.item_id
   group by bi.vendor_id, bi.item_id, i.name_en;

-- #8: bought-together pairs. item_a < item_b keeps each unordered pair once; the
-- threshold of 3 completed bills is fixed by the product spec.
create view v_bought_together with (security_invoker = true) as
  select a.vendor_id, a.item_id as item_a, b.item_id as item_b,
         count(distinct a.bill_id) as bill_count
    from bill_items a
    join bill_items b on b.bill_id = a.bill_id and a.item_id < b.item_id
    join bills bl on bl.id = a.bill_id and bl.status = 'done'
   group by a.vendor_id, a.item_id, b.item_id
  having count(distinct a.bill_id) >= 3;

-- #9: the low-stock bell. Threshold fixed at 10 kg.
create view v_low_stock with (security_invoker = true) as
  select id, vendor_id, name_en, name_hi, name_mr, stock_kg
    from items where is_active and stock_kg < 10;

-- #18: in stock qualifies above 0 kg.
create view v_in_stock with (security_invoker = true) as
  select id, vendor_id, name_en, name_hi, name_mr, stock_kg
    from items where is_active and stock_kg > 0;

-- #10: how often customers asked for something we do not stock.
create view v_stock_request_counts with (security_invoker = true) as
  select vendor_id, lower(item_name) as item_name, count(*) as request_count,
         max(created_at) as last_requested_at
    from stock_requests
   group by vendor_id, lower(item_name);
