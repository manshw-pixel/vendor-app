-- Platform owner: the person above every shop.
-- Spec: docs/superpowers/specs/2026-09-18-platform-owner-design.md
--
-- Owners are NOT app_users rows: every policy keys on vendor_id and an owner has none.
-- The first owner row is inserted by hand once (docs/runbook-platform-owner.md), exactly
-- as the first admin used to be.

create table platform_owners (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  name       text not null,
  created_at timestamptz not null default now()
);
alter table platform_owners enable row level security;
create policy owners_read_self on platform_owners for select to authenticated
  using (user_id = auth.uid());
-- No insert/update/delete policy on purpose.

create function is_platform_owner() returns boolean
  language sql stable security definer set search_path = public as $$
  select exists (select 1 from platform_owners where user_id = auth.uid())
$$;
revoke all on function is_platform_owner() from public, anon;
grant execute on function is_platform_owner() to authenticated;

-- Suspension. The flag is authoritative; the Edge Function also bans sign-ins.
alter table vendors add column suspended_at timestamptz;

create function vendors_suspension_guard() returns trigger language plpgsql as $$
begin
  if new.suspended_at is distinct from old.suspended_at
     and auth.uid() is not null and not is_platform_owner() then
    raise exception 'only the platform owner may suspend a shop' using errcode = '42501';
  end if;
  return new;
end $$;
create trigger vendors_suspension_guard before update on vendors
  for each row execute function vendors_suspension_guard();

-- The enforcement point. Every write policy in 0002 and every billing function checks
-- the role; returning a sentinel that is none of admin/recorder/biller refuses them all at
-- once. It is a non-null string ON PURPOSE: `null not in (...)` is null, and an `if` on
-- null does not fire, so a null here would let issue_token() and friends through.
-- Read policies key on vendor_id only and keep working until the token lapses (<= 1h);
-- the spec accepts that window because the Edge Function also bans new sign-ins.
create or replace function current_user_role() returns text
  language sql stable security definer set search_path = public as $$
  select case when v.suspended_at is not null then 'suspended' else u.role end
    from app_users u join vendors v on v.id = u.vendor_id
   where u.id = auth.uid()
$$;
