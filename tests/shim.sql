-- Supabase-shaped scaffolding for a plain PostgreSQL server.
--
-- On Supabase these objects are provided by the platform. Here the suite runs against the
-- machine's native PostgreSQL -- no Docker, no PostgREST, no GoTrue -- so the parts the
-- migrations and policies DEPEND ON have to exist before they are applied:
--
--   * the roles anon / authenticated / service_role, which every policy names;
--   * auth.uid(), which current_vendor_id() and current_user_role() are built on;
--   * auth.users, which app_users.id points at.
--
-- This file is scaffolding, NOT a second implementation of the security model. It is
-- applied before the migrations and never deployed anywhere. The migrations in
-- supabase/migrations/ stay byte-identical to what `supabase db push` sends to Cloud.
--
-- What it deliberately does NOT reproduce: PostgREST's grant surface and error codes, and
-- GoTrue's real signup/session/JWT handling. See README.md ("What the local suite does
-- not cover").

-- Roles. nologin: nothing connects AS them. Sessions connect as the owner and then
-- `set role`, which is what tests/client.mjs does -- and that is what makes RLS apply,
-- since a superuser session bypasses it entirely.
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    -- bypassrls mirrors Supabase: service_role is the trusted server-side key, and the
    -- billing functions are SECURITY DEFINER precisely because clients are not this.
    create role service_role nologin noinherit bypassrls;
  end if;
  -- The connecting user must be able to assume them.
  execute format('grant anon, authenticated, service_role to %I', current_user);
end $$;

create schema if not exists auth;
grant usage on schema auth to anon, authenticated, service_role;

-- Stands in for GoTrue's user store. Only the columns this project actually reads:
-- app_users.id references nothing here (Supabase's auth.users is in another schema and
-- the migrations do not FK to it), but seed.mjs needs somewhere real to create users.
create table if not exists auth.users (
  id         uuid primary key default gen_random_uuid(),
  email      text unique not null,
  created_at timestamptz not null default now()
);

-- auth.uid() reads the request's JWT claims. On Supabase, PostgREST sets
-- `request.jwt.claims` per request from the verified token; here tests/client.mjs sets the
-- same GUC on its connection. Same contract, same function body Supabase ships.
--
-- The `true` second argument to current_setting() returns null rather than raising when
-- the GUC is unset -- which is the anonymous case, and must read as "no user", not as an
-- error.
create or replace function auth.uid() returns uuid
  language sql stable as $$
  select nullif(
    coalesce(
      current_setting('request.jwt.claim.sub', true),
      (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
    ),
    ''
  )::uuid
$$;

create or replace function auth.role() returns text
  language sql stable as $$
  select coalesce(
    current_setting('request.jwt.claim.role', true),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role'),
    'anon'
  )
$$;

grant execute on function auth.uid(), auth.role() to anon, authenticated, service_role;
grant select on auth.users to authenticated, service_role;

-- pg_cron is not available on a native Windows PostgreSQL build, so `create extension
-- pg_cron` cannot succeed here. Rather than skip 0005_cron.sql wholesale -- which would
-- leave expire_points() and the schedule call untested -- the extension is stood in for:
-- fixtures.mjs strips the `create extension` statement, and this supplies what the rest
-- of the migration actually calls.
--
-- What that costs: nothing here proves pg_cron will RUN the job. It proves the migration
-- applies and registers the schedule it intends to. The job firing at 01:00 is verified
-- on Cloud, where pg_cron is real -- see README.md.
create schema if not exists cron;

create table if not exists cron.job (
  jobid    bigserial primary key,
  jobname  text unique,
  schedule text not null,
  command  text not null
);

create or replace function cron.schedule(job_name text, schedule text, command text)
  returns bigint language sql as $$
  insert into cron.job (jobname, schedule, command) values (job_name, schedule, command)
    on conflict (jobname) do update set schedule = excluded.schedule, command = excluded.command
  returning jobid
$$;

grant usage on schema cron to service_role;
grant select on cron.job to authenticated, service_role;
