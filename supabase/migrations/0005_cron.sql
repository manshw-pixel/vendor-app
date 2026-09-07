-- Expiry is already correct on READ (customer_points_balance filters on expires_at).
-- This sweep makes the lapse an explicit, auditable ledger event so a customer asking
-- "where did my points go" has an answer.

-- Marks which expiry rows this job wrote, so a second run can tell what it already
-- handled. Without it the sweep would re-offset the same lapsed points every night.
alter table points_ledger add column is_expiry boolean not null default false;

create function expire_points() returns integer
  language plpgsql security definer set search_path = public as $$
declare
  v_written integer;
begin
  with lapsed as (
    select vendor_id, customer_id, sum(points) as pts
      from points_ledger
     where not is_expiry and expires_at <= now()
     group by vendor_id, customer_id
    having sum(points) > 0
  ),
  already as (
    select vendor_id, customer_id, sum(points) as offset_pts
      from points_ledger where is_expiry
     group by vendor_id, customer_id
  )
  insert into points_ledger (vendor_id, customer_id, points, expires_at, is_expiry)
  select l.vendor_id, l.customer_id, -(l.pts + coalesce(a.offset_pts, 0)), now(), true
    from lapsed l
    left join already a
      on a.vendor_id = l.vendor_id and a.customer_id = l.customer_id
   where l.pts + coalesce(a.offset_pts, 0) > 0;

  get diagnostics v_written = row_count;
  return v_written;
end $$;

revoke all on function expire_points() from public, anon, authenticated;

-- Daily at 01:00. pgcrypto and pg_net live in the extensions schema on Supabase, but
-- pg_cron is not relocatable — its control file pins schema `cron` — so naming a
-- different schema here raises an error and aborts the migration.
create extension if not exists pg_cron;

select cron.schedule('vendor-app-points-expiry', '0 1 * * *', $$select expire_points()$$);
