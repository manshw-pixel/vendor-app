-- An admin now creates staff accounts and types their first password, so the admin knows
-- it. bills.recorder_id and bills.biller_id name who did the work (0001_schema.sql:75-76),
-- so an admin who keeps that password could record bills under someone else's name and
-- the history would not show it. This flag closes that window at first login.
--
-- The flag lives here rather than in auth.users.user_metadata because metadata the user
-- can write is metadata the user can clear. app_metadata would also do, but app_users is
-- the row SessionProvider already reads and the row this project owns.
alter table app_users
  add column must_change_password boolean not null default false;

-- Clearing it needs its own function because users_admin_write is admin-only: a recorder
-- must be able to clear their OWN flag without gaining the ability to write anything else
-- on the row -- including their own role. RLS cannot restrict by column, so the narrow
-- privilege is expressed as a narrow function instead.
--
-- It takes no arguments on purpose. There is no id to pass, so there is no id to forge.
--
-- Unlike issue_token()/complete_bill(), a null auth.uid() is NOT waved through here. Those
-- act on a bill that names its own tenant, so a service-role caller is unambiguous; this
-- one keys entirely on who is calling, and a null there would match no row -- which is the
-- correct outcome, stated explicitly rather than left to the where clause by luck.
create function complete_password_change()
  returns void
  language sql security definer set search_path = public as $$
  update app_users
     set must_change_password = false
   where id = auth.uid()
$$;

revoke all on function complete_password_change() from public, anon;
grant execute on function complete_password_change() to authenticated;
