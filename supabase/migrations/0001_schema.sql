-- Vendor app schema. Every table carries vendor_id (denormalised onto children) so that
-- every RLS policy in 0002 is a plain column check rather than a join.
create extension if not exists pgcrypto;

create table vendors (
  id                  uuid primary key default gen_random_uuid(),
  name                text not null,
  -- Loyalty rules are per-vendor config (#5); the functions in 0003 read them from here
  -- and never hardcode. Defaults are the spec's values (#15).
  points_threshold_1  numeric(10,2) not null default 600,
  points_reward_1     integer       not null default 50,
  points_threshold_2  numeric(10,2) not null default 1000,
  points_reward_2     integer       not null default 100,
  redeem_days         integer       not null default 30,
  created_at          timestamptz not null default now()
);

-- The atomic token source (#12). One row per vendor, incremented with UPDATE ... RETURNING.
create table vendor_counters (
  vendor_id  uuid primary key references vendors(id) on delete cascade,
  last_token integer not null default 0
);

-- Created automatically so issue_token never has to cope with a missing counter row.
create function ensure_vendor_counter() returns trigger language plpgsql as $$
begin
  insert into vendor_counters (vendor_id) values (new.id);
  return new;
end $$;

create trigger vendors_counter_ai after insert on vendors
  for each row execute function ensure_vendor_counter();

create table app_users (
  id         uuid primary key,          -- equals auth.users.id
  vendor_id  uuid not null references vendors(id) on delete cascade,
  role       text not null check (role in ('admin','recorder','biller')),
  name       text not null,
  created_at timestamptz not null default now()
);
create index app_users_vendor_idx on app_users(vendor_id);

create table items (
  id        uuid primary key default gen_random_uuid(),
  vendor_id uuid not null references vendors(id) on delete cascade,
  name_en   text not null,
  name_hi   text not null default '',
  name_mr   text not null default '',
  price     numeric(10,2) not null check (price >= 0),   -- per kg
  stock_kg  numeric(10,2) not null default 0 check (stock_kg >= 0),
  is_active boolean not null default true
);
create index items_vendor_idx on items(vendor_id);
-- Serves the low-stock bell (#9) and the in-stock list (#18).
create index items_vendor_stock_idx on items(vendor_id, stock_kg);

-- #11: all three fields mandatory. Mobile is stored E.164-normalised so the WhatsApp
-- webhook can find a customer by sender number.
create table customers (
  id         uuid primary key default gen_random_uuid(),
  vendor_id  uuid not null references vendors(id) on delete cascade,
  name       text not null,
  flat_no    text not null,
  mobile     text not null,
  created_at timestamptz not null default now(),
  unique (vendor_id, mobile)
);
create index customers_vendor_idx on customers(vendor_id);

create table bills (
  id           uuid primary key default gen_random_uuid(),
  vendor_id    uuid not null references vendors(id) on delete cascade,
  token_no     integer,                       -- null until issue_token runs
  customer_id  uuid references customers(id),
  recorder_id  uuid references app_users(id),
  biller_id    uuid references app_users(id),
  total        numeric(10,2) not null default 0 check (total >= 0),
  status       text not null default 'recording'
               check (status in ('recording','billed','done')),
  created_at   timestamptz not null default now(),
  completed_at timestamptz,
  unique (vendor_id, token_no)
);
create index bills_vendor_status_idx on bills(vendor_id, status);
create index bills_vendor_completed_idx on bills(vendor_id, completed_at);

create table bill_items (
  id         uuid primary key default gen_random_uuid(),
  bill_id    uuid not null references bills(id) on delete cascade,
  vendor_id  uuid not null references vendors(id) on delete cascade,
  item_id    uuid not null references items(id),
  qty_kg     numeric(10,2) not null check (qty_kg > 0),
  unit_price numeric(10,2) not null check (unit_price >= 0),
  line_total numeric(10,2) not null check (line_total >= 0)
);
create index bill_items_bill_idx on bill_items(bill_id);
create index bill_items_vendor_item_idx on bill_items(vendor_id, item_id);

-- Append-only (#15). Redemptions are negative rows. A balance is always a sum.
create table points_ledger (
  id          uuid primary key default gen_random_uuid(),
  vendor_id   uuid not null references vendors(id) on delete cascade,
  customer_id uuid not null references customers(id) on delete cascade,
  bill_id     uuid references bills(id),
  points      integer not null,
  earned_at   timestamptz not null default now(),
  expires_at  timestamptz not null
);
create index points_ledger_lookup_idx on points_ledger(vendor_id, customer_id, expires_at);

-- #10 and #20: customers suggesting items the vendor does not stock.
create table stock_requests (
  id          uuid primary key default gen_random_uuid(),
  vendor_id   uuid not null references vendors(id) on delete cascade,
  customer_id uuid references customers(id) on delete set null,
  item_name   text not null,
  created_at  timestamptz not null default now()
);
create index stock_requests_vendor_idx on stock_requests(vendor_id, created_at);

-- Outbound WhatsApp queue (#13, #16, #18). Rows are inserted inside the transaction that
-- causes them; delivery is a separate concern that may fail and retry without ever
-- rolling back a completed sale.
create table outbound_messages (
  id           uuid primary key default gen_random_uuid(),
  vendor_id    uuid not null references vendors(id) on delete cascade,
  customer_id  uuid references customers(id) on delete set null,
  template_key text not null,
  payload      jsonb not null default '{}'::jsonb,
  status       text not null default 'pending'
               check (status in ('pending','sent','failed')),
  attempts     integer not null default 0,
  created_at   timestamptz not null default now(),
  sent_at      timestamptz,
  last_error   text
);
create index outbound_pending_idx on outbound_messages(status, created_at);
