# Offline Billing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let any shop role record complete sales with no internet, queue them on the device, and sync them through one idempotent database function that flags — never loses — anything it cannot apply as recorded.

**Architecture:** Migration 0024 extracts `complete_bill`'s body into an internal `_complete_bill_core` (time and notification as parameters) and adds `record_offline_bill`, `sync_issues`, `resolve_sync_issue`, `open_sync_issues`, `offline_balances`. The web app gains a key-value store over IndexedDB, a catalogue snapshot, a per-vendor outbox with a sender, an offline checkout on the Bill screen, an outbox view, an admin Sync issues screen, a cached session for offline reloads, and a hand-written service worker.

**Tech Stack:** PostgreSQL / Supabase (plpgsql), node DB suite (`npm test` at repo root), React 19 + Vite 8 + Vitest 5 (`npm test` in `web/`), no new runtime dependencies.

**Spec:** `docs/superpowers/specs/2026-09-25-offline-billing-design.md`

## Global Constraints

- No new runtime dependency in `web/package.json` (no `idb`, no `vite-plugin-pwa`, no `fake-indexeddb`).
- `complete_bill(uuid, uuid, integer, text, numeric)` keeps its exact signature and behaviour; every existing DB test must still pass.
- Offline bills send **no** customer notification (`outbound_messages`) — neither `token_issued` nor `points_awarded`.
- `occurred_at` is clamped to `[now() - 7 days, now()]`.
- A closed day's figures are never changed: a bill whose day is closed is booked to now.
- Offline bills may be recorded by `admin`, `recorder` or `biller`.
- The outbox is scoped per vendor and survives sign-out.
- Cache stale threshold: 24 h (warning only).
- Business dates are `Asia/Kolkata`, as everywhere else.
- Every new UI string goes into `en.json`, `hi.json`, `mr.json` (hi/mr AI-written, as the rest).
- Migration is applied by hand in the SQL editor on Cloud (see memory: `supabase db push` 401s); deploy order is apply 0024 → merge → Pages.

## Review Focus

1. **The same bill sent twice** (lost reply, two tabs, retry after crash) — must produce one bill, one stock decrement, one points award; the second call returns the first result. Test in Task 2.
2. **Today is also closed** when an offline bill from a closed day syncs — must reject cleanly (bill stays in the outbox as "needs attention"), never write into a closed day. Test in Task 2.
3. **Signed out / different vendor signs in with a non-empty outbox** — the other vendor's bills are never sent and never shown; they reappear when the original vendor signs back in. Test in Task 5.
4. **Browser reload while offline** — the app must open to the Bill screen with the last session, not a login screen or an error. Test in Task 6.
5. **Redeem or collect-due larger than the cached figure allows** — the checkout must cap inputs at the cached balance and the bill total, so a shortfall is only ever caused by staleness, never by typing. Test in Task 7.

---

## File map

| File | Responsibility |
|---|---|
| `supabase/migrations/0024_offline_billing.sql` | core extraction, schema, `record_offline_bill`, issues functions, `offline_balances` |
| `tests/offline_billing.test.mjs` | DB tests for all of 0024 |
| `web/src/offline/kv.ts` | `KV` interface, `memoryKV()`, `idbKV()`, swappable `kv` |
| `web/src/offline/catalogue.ts` | snapshot save/load/refresh/stale |
| `web/src/offline/outbox.ts` | queue storage, device sequence, `flush()` |
| `web/src/offline/useOutbox.ts` | hook: triggers flush on start/online/focus/backoff; exposes counts |
| `web/src/offline/useOnline.ts` | shared online hook (moved out of `Bill.tsx`) |
| `web/src/offline/sessionCache.ts` | remember last ready session per user |
| `web/src/offline/assetList.ts` | pure: bundle file names → precache list |
| `web/src/screens/bill/OfflineCheckout.tsx` | payment/redeem/collect step for offline bills |
| `web/src/screens/bill/OfflineResult.tsx` | "Offline #n" done screen |
| `web/src/screens/Outbox.tsx` | waiting + needs-attention list, Retry now |
| `web/src/screens/SyncIssues.tsx` | admin list, Add as due / Dismiss |
| `web/src/syncIssues.ts` | RPC wrappers for issues |
| `web/public/sw.js`, `web/public/manifest.webmanifest`, `web/public/icon-192.png`, `web/public/icon-512.png` | PWA shell |
| Modify: `web/src/data.ts`, `web/src/routes.ts`, `web/src/components/Shell.tsx`, `web/src/components/Guard.tsx`, `web/src/components/SessionProvider.tsx`, `web/src/screens/Bill.tsx`, `web/src/screens/bill/CustomerStep.tsx`, `web/src/App.tsx`, `web/src/main.tsx`, `web/vite.config.ts`, `web/index.html`, `web/src/i18n/{en,hi,mr}.json`, `tests/run.mjs`, `README.md` | wiring |

---

### Task 1: Extract `_complete_bill_core` (behaviour-preserving)

**Files:**
- Create: `supabase/migrations/0024_offline_billing.sql`
- Create: `tests/offline_billing.test.mjs`
- Modify: `tests/run.mjs` (add `import "./offline_billing.test.mjs";` after `dues_collect`)

**Interfaces:**
- Produces: `_complete_bill_core(p_bill_id uuid, p_biller_id uuid, p_redeem_points integer, p_payment_mode text, p_collect_due numeric, p_at timestamptz, p_notify boolean) returns void` — no tenant/role guard; not executable by `public`, `anon`, `authenticated`.
- `complete_bill(...)` unchanged externally: guards, then `perform _complete_bill_core(..., now(), true)`.

- [ ] **Step 1: Write the failing test**

```js
// tests/offline_billing.test.mjs
import { test, assert, assertEqual } from "./framework.mjs";
import { sql } from "./fixtures.mjs";
import { seedTwoVendors } from "./seed.mjs";

test("_complete_bill_core is not callable by a signed-in user", async () => {
  const w = await seedTwoVendors();
  const { error } = await w.a.clients.admin.rpc("_complete_bill_core", {
    p_bill_id: "00000000-0000-0000-0000-000000000000", p_biller_id: null, p_redeem_points: 0,
    p_payment_mode: "cash", p_collect_due: 0, p_at: new Date().toISOString(), p_notify: false,
  });
  assert(error, "must be refused");
  assert(/permission denied|not find|does not exist/i.test(error.message), error.message);
});
```

- [ ] **Step 2: Run** `npm test` (repo root). Expected: this case FAILS (function does not exist → message is "Could not find the function" which matches… so instead assert existence first):

Add before the rpc call:
```js
  const { rows } = await sql(`select count(*)::int n from pg_proc where proname = '_complete_bill_core'`);
  assertEqual(rows[0].n, 1, "core exists");
```
Expected: FAIL "core exists: expected 1, got 0".

- [ ] **Step 3: Write the migration's first part**

Header, then copy the body of `complete_bill` from `supabase/migrations/0023_dues_collect.sql` (the `create function complete_bill(` … `end $$;` block, lines ~220–425) **verbatim** into `_complete_bill_core`, with exactly these changes:
1. Signature → `(p_bill_id uuid, p_biller_id uuid, p_redeem_points integer, p_payment_mode text, p_collect_due numeric, p_at timestamptz, p_notify boolean)`.
2. **Delete** the two tenant/role `if current_vendor_id() ...` blocks (the wrapper keeps them).
3. Day-closed check: `business_date = (p_at at time zone 'Asia/Kolkata')::date`.
4. Due repayment insert: `business_date` value → `(p_at at time zone 'Asia/Kolkata')::date`.
5. Points award `expires_at` → `p_at + (v_vendor.redeem_days || ' days')::interval`.
6. Wrap the `insert into outbound_messages ... 'points_awarded'` statement in `if p_notify then ... end if;`.
7. Final update: `completed_at = p_at`.
Leave every other `now()` (redemption balance `expires_at > now()`) alone.

```sql
-- Offline billing: bills recorded with no connection, synced later.
-- Spec: docs/superpowers/specs/2026-09-25-offline-billing-design.md

-- ---------------------------------------------------------------------------
-- Part 1: complete_bill's body becomes a guard-free core both paths call, so the
-- online and offline sale can never drift apart. complete_bill's signature and
-- behaviour are unchanged: p_at = now(), p_notify = true.
-- ---------------------------------------------------------------------------
create function _complete_bill_core(
  p_bill_id uuid, p_biller_id uuid, p_redeem_points integer, p_payment_mode text,
  p_collect_due numeric, p_at timestamptz, p_notify boolean
) returns void
  language plpgsql security definer set search_path = public as $$
  -- … 0023 complete_bill body with the seven edits above …
$$;

revoke all on function _complete_bill_core(uuid, uuid, integer, text, numeric, timestamptz, boolean)
  from public, anon, authenticated;

create or replace function complete_bill(
  p_bill_id uuid,
  p_biller_id uuid default null,
  p_redeem_points integer default 0,
  p_payment_mode text default null,
  p_collect_due numeric default 0
) returns void
  language plpgsql security definer set search_path = public as $$
declare
  v_vendor uuid;
begin
  select vendor_id into v_vendor from bills where id = p_bill_id;
  if not found then
    raise exception 'bill % not found', p_bill_id;
  end if;
  if current_vendor_id() is not null and current_vendor_id() <> v_vendor then
    raise exception 'bill % does not belong to your vendor', p_bill_id;
  end if;
  if current_vendor_id() is not null and current_user_role() not in ('admin', 'biller') then
    raise exception 'role % may not complete bills', current_user_role();
  end if;
  perform _complete_bill_core(p_bill_id, p_biller_id, p_redeem_points, p_payment_mode,
                              p_collect_due, now(), true);
end $$;
-- create or replace keeps 0023's grants.
```

- [ ] **Step 4: Run** `npm test`. Expected: all previous cases (316) + new case PASS. If any `complete_bill`, `redemption`, `dues_collect`, `payments`, `day_close` case fails, the copy diverged — diff against 0023 and fix.

- [ ] **Step 5: Commit**
```bash
git add supabase/migrations/0024_offline_billing.sql tests/offline_billing.test.mjs tests/run.mjs
git commit -m "feat(db): extract _complete_bill_core; complete_bill unchanged"
```

---

### Task 2: `record_offline_bill` and `sync_issues`

**Files:**
- Modify: `supabase/migrations/0024_offline_billing.sql` (append Part 2)
- Modify: `tests/offline_billing.test.mjs`

**Interfaces:**
- Consumes: `_complete_bill_core` (Task 1); existing `customer_due(uuid)`, `assert_whole_qty(uuid, numeric)`, `vendor_counters`.
- Produces:
  - `bills.client_id uuid unique`, `bills.occurred_at timestamptz`, `bills.device_label text`.
  - table `sync_issues(id, vendor_id, bill_id, kind, amount, detail, status, resolved_by, resolved_at, created_at)`.
  - `record_offline_bill(p_client_id uuid, p_bill jsonb) returns jsonb` → `{"bill_id": uuid, "token_no": int, "issues": [{"kind": text, "amount": numeric}]}`.
  - Payload keys: `lines` (array of `{item_id, qty_kg, unit_price}`), `customer_id`, `payment_mode`, `redeem_points`, `collect_due`, `occurred_at` (ISO string), `device_label`.
  - Errors: `42501` not a shop user / wrong role / client_id of another shop; `22023` bad input; `P0002` "an item on this bill no longer exists" / "the customer on this bill no longer exists"; `P0001` "day is closed" (from core, today closed).

- [ ] **Step 1: Write the failing tests** (append)

```js
const payload = (v, over = {}) => ({
  lines: [{ item_id: v.itemId, qty_kg: 2, unit_price: 40 }],
  customer_id: v.customerId, payment_mode: "cash", redeem_points: 0, collect_due: 0,
  occurred_at: new Date().toISOString(), device_label: "Offline #1", ...over,
});
const rec = (client, id, p) => client.rpc("record_offline_bill", { p_client_id: id, p_bill: p });
const uuid = () => crypto.randomUUID();
const issuesOf = async (billId) => (await sql(
  `select kind, amount::float amount from sync_issues where bill_id = $1 order by kind`, [billId])).rows;

test("record_offline_bill: a recorder records a done, paid, tokened bill with no message", async () => {
  const w = await seedTwoVendors();
  const id = uuid();
  const { data, error } = await rec(w.a.clients.recorder, id, payload(w.a));
  assert(!error, error?.message);
  assert(data.token_no > 0, "real token");
  assertEqual(data.issues, [], "no issues");
  const { rows: [b] } = await sql(`select status, total::float total, client_id, device_label from bills where id = $1`, [data.bill_id]);
  assertEqual([b.status, b.total, b.client_id, b.device_label], ["done", 80, id, "Offline #1"], "bill");
  const { rows: [p] } = await sql(`select mode, amount::float amount from bill_payments where bill_id = $1`, [data.bill_id]);
  assertEqual([p.mode, p.amount], ["cash", 80], "payment");
  const { rows: [s] } = await sql(`select stock_kg::float s from items where id = $1`, [w.a.itemId]);
  assertEqual(s.s, 98, "stock moved");
  const { rows: [m] } = await sql(`select count(*)::int n from outbound_messages where customer_id = $1`, [w.a.customerId]);
  assertEqual(m.n, 0, "no customer notification");
});

test("record_offline_bill: resending the same client_id returns the first bill and writes nothing", async () => {
  const w = await seedTwoVendors();
  const id = uuid();
  const first = (await rec(w.a.clients.biller, id, payload(w.a))).data;
  const second = await rec(w.a.clients.biller, id, payload(w.a, { lines: [{ item_id: w.a.itemId, qty_kg: 9, unit_price: 1 }] }));
  assert(!second.error, second.error?.message);
  assertEqual(second.data, first, "same result");
  const { rows } = await sql(`select count(*)::int n from bills where client_id = $1`, [id]);
  assertEqual(rows[0].n, 1, "one bill");
  const { rows: [s] } = await sql(`select stock_kg::float s from items where id = $1`, [w.a.itemId]);
  assertEqual(s.s, 98, "stock moved once");
});

test("record_offline_bill: another shop's client_id is refused, not returned", async () => {
  const w = await seedTwoVendors();
  const id = uuid();
  await rec(w.a.clients.admin, id, payload(w.a));
  const { error } = await rec(w.b.clients.admin, id, payload(w.b));
  assert(error, "refused");
});

test("record_offline_bill: redemption beyond the balance is capped and flagged", async () => {
  const w = await seedTwoVendors();
  await sql(`insert into points_ledger (vendor_id, customer_id, points, expires_at)
             values ($1,$2,30, now() + interval '30 days')`, [w.a.vendorId, w.a.customerId]);
  const { data, error } = await rec(w.a.clients.admin, uuid(), payload(w.a, { redeem_points: 50 }));
  assert(!error, error?.message);
  assertEqual(data.issues, [{ kind: "redeem_shortfall", amount: 20 }], "shortfall of 20");
  const { rows: [b] } = await sql(`select redeemed_points, total::float total from bills where id = $1`, [data.bill_id]);
  assertEqual([b.redeemed_points, b.total], [30, 50], "redeemed what existed");
});

test("record_offline_bill: collecting more due than owed is capped and flagged", async () => {
  const w = await seedTwoVendors();
  await w.a.clients.admin.rpc("record_opening_balance", { p_customer: w.a.customerId, p_amount: 25, p_note: "khata" });
  const { data, error } = await rec(w.a.clients.biller, uuid(), payload(w.a, { collect_due: 100 }));
  assert(!error, error?.message);
  assertEqual(data.issues, [{ kind: "due_overcollected", amount: 75 }], "75 over");
  const { rows: [d] } = await sql(`select amount::float a from dues_entries where bill_id = $1`, [data.bill_id]);
  assertEqual(d.a, 25, "collected what was owed");
});

test("record_offline_bill: an open earlier day keeps its time; a closed one is rebooked to now", async () => {
  const w = await seedTwoVendors();
  const twoDaysAgo = new Date(Date.now() - 2 * 86400e3).toISOString();
  const open = (await rec(w.a.clients.admin, uuid(), payload(w.a, { occurred_at: twoDaysAgo }))).data;
  const { rows: [o] } = await sql(`select abs(extract(epoch from completed_at - $2::timestamptz)) < 1 same from bills where id = $1`, [open.bill_id, twoDaysAgo]);
  assert(o.same, "completed_at is the offline time");
  assertEqual(open.issues, [], "no issue");

  const yesterday = (await sql(`select ((now() at time zone 'Asia/Kolkata')::date - 1)::text d`)).rows[0].d;
  await w.a.clients.admin.rpc("close_day", { p_date: yesterday, p_counted_cash: 0, p_note: "x" });
  const at = new Date(Date.now() - 86400e3).toISOString();
  const moved = (await rec(w.a.clients.admin, uuid(), payload(w.a, { occurred_at: at }))).data;
  assertEqual(moved.issues.map((i) => i.kind), ["rebooked_closed_day"], "flagged");
  const { rows: [m] } = await sql(`select (completed_at at time zone 'Asia/Kolkata')::date::text d, occurred_at is not null kept from bills where id = $1`, [moved.bill_id]);
  assert(m.d !== yesterday && m.kept, "booked to today, original time kept");
});
```
> Note for the implementer: `close_day` needs a note when counted cash ≠ expected. The two-days-ago bill is on another day, so yesterday's expected cash is 0 and `p_note` is harmless. If `close_day` rejects for any other reason, assert its `error` is null first so the test fails loudly.

```js
test("record_offline_bill: when today is closed too, the call is refused and nothing is written", async () => {
  const w = await seedTwoVendors();
  const today = (await sql(`select (now() at time zone 'Asia/Kolkata')::date::text d`)).rows[0].d;
  const { error: c } = await w.a.clients.admin.rpc("close_day", { p_date: today, p_counted_cash: 0, p_note: "x" });
  assert(!c, c?.message);
  const id = uuid();
  const { error } = await rec(w.a.clients.admin, id, payload(w.a));
  assert(error && /day is closed/.test(error.message), error?.message);
  const { rows } = await sql(`select count(*)::int n from bills where client_id = $1`, [id]);
  assertEqual(rows[0].n, 0, "nothing written");
});

test("record_offline_bill: a future or too-old time is clamped and flagged", async () => {
  const w = await seedTwoVendors();
  const future = (await rec(w.a.clients.admin, uuid(), payload(w.a, { occurred_at: new Date(Date.now() + 3600e3).toISOString() }))).data;
  assertEqual(future.issues.map((i) => i.kind), ["time_clamped"], "future clamped");
  const old = (await rec(w.a.clients.admin, uuid(), payload(w.a, { occurred_at: new Date(Date.now() - 30 * 86400e3).toISOString() }))).data;
  assertEqual(old.issues.map((i) => i.kind), ["time_clamped"], "old clamped");
  const { rows: [b] } = await sql(`select now() - completed_at < interval '7 days 1 minute' ok from bills where id = $1`, [old.bill_id]);
  assert(b.ok, "within 7 days");
});

test("record_offline_bill: a deleted item rejects the whole bill", async () => {
  const w = await seedTwoVendors();
  const { error } = await rec(w.a.clients.admin, uuid(), payload(w.a, {
    lines: [{ item_id: crypto.randomUUID(), qty_kg: 1, unit_price: 10 }] }));
  assert(error && /no longer exists/.test(error.message), error?.message);
});

test("record_offline_bill: credit is recorded as udhaar", async () => {
  const w = await seedTwoVendors();
  const { data } = await rec(w.a.clients.recorder, uuid(), payload(w.a, { payment_mode: "credit" }));
  const { rows: [d] } = await sql(`select customer_due($1)::float d`, [w.a.customerId]);
  assertEqual(d.d, 80, "owes 80");
  assert(data.token_no > 0);
});

test("sync_issues: admin reads, recorder and other shop do not", async () => {
  const w = await seedTwoVendors();
  await rec(w.a.clients.admin, uuid(), payload(w.a, { occurred_at: new Date(Date.now() + 3600e3).toISOString() }));
  const a = await w.a.clients.admin.from("sync_issues").select("kind");
  assertEqual(a.data.length, 1, "admin sees it");
  const r = await w.a.clients.recorder.from("sync_issues").select("kind");
  assertEqual(r.data, [], "recorder does not");
  const b = await w.b.clients.admin.from("sync_issues").select("kind");
  assertEqual(b.data, [], "other shop does not");
});
```

- [ ] **Step 2: Run** `npm test`. Expected: the new cases FAIL ("Could not find the function public.record_offline_bill").

- [ ] **Step 3: Append Part 2 to the migration**

```sql
-- ---------------------------------------------------------------------------
-- Part 2: the offline sale
-- ---------------------------------------------------------------------------
alter table bills
  add column client_id    uuid unique,
  add column occurred_at  timestamptz,
  add column device_label text;

create table sync_issues (
  id          uuid primary key default gen_random_uuid(),
  vendor_id   uuid not null references vendors(id) on delete cascade,
  bill_id     uuid not null references bills(id) on delete cascade,
  kind        text not null check (kind in ('redeem_shortfall','due_overcollected',
                                            'rebooked_closed_day','time_clamped')),
  amount      numeric(10,2),
  detail      jsonb not null default '{}',
  status      text not null default 'open' check (status in ('open','added_as_due','dismissed')),
  resolved_by uuid references app_users(id),
  resolved_at timestamptz,
  created_at  timestamptz not null default now()
);
create index sync_issues_open_idx on sync_issues(vendor_id) where status = 'open';

alter table sync_issues enable row level security;
-- The owner settles these; staff at the counter are not asked to.
create policy sync_issues_admin_read on sync_issues for select to authenticated
  using (vendor_id = current_vendor_id() and current_user_role() = 'admin');

create function _offline_result(p_bill_id uuid) returns jsonb
  language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'bill_id', b.id, 'token_no', b.token_no,
    'issues', coalesce((select jsonb_agg(jsonb_build_object('kind', s.kind, 'amount', s.amount)
                                          order by s.kind)
                          from sync_issues s where s.bill_id = b.id), '[]'::jsonb))
    from bills b where b.id = p_bill_id;
$$;
revoke all on function _offline_result(uuid) from public, anon, authenticated;

create function record_offline_bill(p_client_id uuid, p_bill jsonb) returns jsonb
  language plpgsql security definer set search_path = public as $$
declare
  v_vendor    uuid := current_vendor_id();
  v_existing  bills%rowtype;
  v_bill_id   uuid;
  v_token     integer;
  v_customer  uuid := nullif(p_bill->>'customer_id', '')::uuid;
  v_mode      text := p_bill->>'payment_mode';
  v_redeem    integer := coalesce((p_bill->>'redeem_points')::integer, 0);
  v_collect   numeric := coalesce((p_bill->>'collect_due')::numeric, 0);
  v_lines     jsonb := p_bill->'lines';
  v_req_at    timestamptz := (p_bill->>'occurred_at')::timestamptz;
  v_at        timestamptz;
  v_due       numeric;
  v_redeemed  integer;
begin
  if v_vendor is null or current_user_role() not in ('admin', 'recorder', 'biller') then
    raise exception 'only shop staff may record an offline bill' using errcode = '42501';
  end if;
  if p_client_id is null or v_req_at is null then
    raise exception 'client id and time are required' using errcode = '22023';
  end if;

  -- Idempotent by client_id: a lost reply's resend returns the first result. The unique
  -- constraint makes a concurrent double-send fail the second insert, and its retry lands here.
  select * into v_existing from bills where client_id = p_client_id;
  if found then
    if v_existing.vendor_id <> v_vendor then
      raise exception 'bill is not in your shop' using errcode = '42501';
    end if;
    return _offline_result(v_existing.id);
  end if;

  if jsonb_typeof(v_lines) <> 'array' or jsonb_array_length(v_lines) = 0 then
    raise exception 'refusing an offline bill with no lines' using errcode = '22023';
  end if;
  if exists (select 1 from jsonb_to_recordset(v_lines) l(item_id uuid)
              left join items i on i.id = l.item_id and i.vendor_id = v_vendor
             where i.id is null) then
    raise exception 'an item on this bill no longer exists' using errcode = 'P0002';
  end if;
  if v_customer is not null and not exists
       (select 1 from customers where id = v_customer and vendor_id = v_vendor) then
    raise exception 'the customer on this bill no longer exists' using errcode = 'P0002';
  end if;
  perform assert_whole_qty(l.item_id, l.qty_kg)
    from jsonb_to_recordset(v_lines) as l(item_id uuid, qty_kg numeric);

  insert into bills (vendor_id, customer_id, recorder_id, status, client_id, occurred_at, device_label)
  values (v_vendor, v_customer, auth.uid(), 'recording', p_client_id, v_req_at, p_bill->>'device_label')
  returning id into v_bill_id;

  v_at := least(greatest(v_req_at, now() - interval '7 days'), now());
  if v_at <> v_req_at then
    insert into sync_issues (vendor_id, bill_id, kind, detail)
    values (v_vendor, v_bill_id, 'time_clamped',
            jsonb_build_object('requested', v_req_at, 'used', v_at));
  end if;

  -- A closed day's signed-off cash is never changed: book the sale to now instead.
  if exists (select 1 from day_closes
              where vendor_id = v_vendor
                and business_date = (v_at at time zone 'Asia/Kolkata')::date
                and reopened_at is null) then
    insert into sync_issues (vendor_id, bill_id, kind, detail)
    values (v_vendor, v_bill_id, 'rebooked_closed_day',
            jsonb_build_object('from', (v_at at time zone 'Asia/Kolkata')::date,
                               'to', (now() at time zone 'Asia/Kolkata')::date));
    v_at := now();
  end if;

  -- The price the customer actually paid; totals computed here, as replace_bill_lines does.
  insert into bill_items (bill_id, vendor_id, item_id, qty_kg, unit_price, line_total)
  select v_bill_id, v_vendor, l.item_id, l.qty_kg, l.unit_price, round(l.qty_kg * l.unit_price, 2)
    from jsonb_to_recordset(v_lines) as l(item_id uuid, qty_kg numeric, unit_price numeric);

  -- A real token, as issue_token allocates it -- but no token_issued message: the customer
  -- has already left with their goods.
  update vendor_counters set last_token = last_token + 1
   where vendor_id = v_vendor returning last_token into v_token;
  update bills
     set token_no = v_token, status = 'billed',
         total = (select coalesce(sum(line_total), 0) from bill_items where bill_id = v_bill_id)
   where id = v_bill_id;

  -- Same lock order as the core: vendor, then customer.
  perform 1 from vendors where id = v_vendor for share;
  if v_customer is not null then
    perform 1 from customers where id = v_customer for update;
  end if;

  if v_collect > 0 and v_customer is not null then
    v_due := greatest(customer_due(v_customer), 0);
    if v_collect > v_due then
      insert into sync_issues (vendor_id, bill_id, kind, amount)
      values (v_vendor, v_bill_id, 'due_overcollected', v_collect - v_due);
      v_collect := v_due;
    end if;
  end if;

  perform _complete_bill_core(v_bill_id, auth.uid(), v_redeem, v_mode, v_collect, v_at, false);

  select redeemed_points into v_redeemed from bills where id = v_bill_id;
  if v_redeem > v_redeemed then
    insert into sync_issues (vendor_id, bill_id, kind, amount)
    values (v_vendor, v_bill_id, 'redeem_shortfall', v_redeem - v_redeemed);
  end if;

  return _offline_result(v_bill_id);
end $$;

revoke all on function record_offline_bill(uuid, jsonb) from public, anon;
grant execute on function record_offline_bill(uuid, jsonb) to authenticated;
```

- [ ] **Step 4: Run** `npm test`. Expected: all PASS. If "redeem_shortfall" amount prints as a string, keep the `::float` casts in the tests, not in the function.

- [ ] **Step 5: Commit**
```bash
git add supabase/migrations/0024_offline_billing.sql tests/offline_billing.test.mjs
git commit -m "feat(db): record_offline_bill with idempotency, caps and sync issues"
```

---

### Task 3: Resolving issues and the balances snapshot

**Files:**
- Modify: `supabase/migrations/0024_offline_billing.sql` (append Part 3)
- Modify: `tests/offline_billing.test.mjs`

**Interfaces:**
- Produces:
  - `open_sync_issues() returns table (id uuid, bill_id uuid, token_no integer, kind text, amount numeric, detail jsonb, created_at timestamptz, customer_name text)` — admin only (`42501` otherwise), caller's shop, `status = 'open'`, oldest first.
  - `resolve_sync_issue(p_id uuid, p_action text) returns void` — `p_action in ('add_as_due','dismiss')`; admin only; `P0001 'already resolved'`; `add_as_due` only for `redeem_shortfall` with a customer (`22023` otherwise).
  - `offline_balances() returns table (customer_id uuid, points integer, due numeric)` — any role, caller's shop.

- [ ] **Step 1: Write the failing tests** (append)

```js
async function shortfall(w) {
  const { data } = await rec(w.a.clients.admin, uuid(), payload(w.a, { redeem_points: 15 }));
  return (await sql(`select id from sync_issues where bill_id = $1`, [data.bill_id])).rows[0].id;
}

test("resolve_sync_issue: add_as_due writes an opening due and closes the issue; twice is refused", async () => {
  const w = await seedTwoVendors();
  const id = await shortfall(w);
  const { error } = await w.a.clients.admin.rpc("resolve_sync_issue", { p_id: id, p_action: "add_as_due" });
  assert(!error, error?.message);
  const { rows: [d] } = await sql(`select customer_due($1)::float d`, [w.a.customerId]);
  assertEqual(d.d, 15, "customer owes the shortfall");
  const again = await w.a.clients.admin.rpc("resolve_sync_issue", { p_id: id, p_action: "dismiss" });
  assert(again.error && /already resolved/.test(again.error.message), again.error?.message);
});

test("resolve_sync_issue: add_as_due is refused for other kinds; dismiss works; non-admin refused", async () => {
  const w = await seedTwoVendors();
  const { data } = await rec(w.a.clients.admin, uuid(), payload(w.a, { occurred_at: new Date(Date.now() + 3600e3).toISOString() }));
  const id = (await sql(`select id from sync_issues where bill_id = $1`, [data.bill_id])).rows[0].id;
  const bad = await w.a.clients.admin.rpc("resolve_sync_issue", { p_id: id, p_action: "add_as_due" });
  assert(bad.error, "time_clamped cannot become a due");
  const biller = await w.a.clients.biller.rpc("resolve_sync_issue", { p_id: id, p_action: "dismiss" });
  assert(biller.error, "biller refused");
  const ok = await w.a.clients.admin.rpc("resolve_sync_issue", { p_id: id, p_action: "dismiss" });
  assert(!ok.error, ok.error?.message);
  const { data: open } = await w.a.clients.admin.rpc("open_sync_issues");
  assertEqual(open, [], "none open");
});

test("open_sync_issues lists the shop's open issues with token and customer", async () => {
  const w = await seedTwoVendors();
  await shortfall(w);
  const { data, error } = await w.a.clients.admin.rpc("open_sync_issues");
  assert(!error, error?.message);
  assertEqual(data.length, 1);
  assertEqual([data[0].kind, Number(data[0].amount), data[0].customer_name], ["redeem_shortfall", 15, "Cust a"]);
  assert(data[0].token_no > 0);
  const r = await w.a.clients.recorder.rpc("open_sync_issues");
  assert(r.error, "recorder refused");
});

test("offline_balances: points and due per customer, own shop only", async () => {
  const w = await seedTwoVendors();
  await sql(`insert into points_ledger (vendor_id, customer_id, points, expires_at)
             values ($1,$2,12, now() + interval '5 days'), ($1,$2,99, now() - interval '1 day')`,
            [w.a.vendorId, w.a.customerId]);
  await w.a.clients.admin.rpc("record_opening_balance", { p_customer: w.a.customerId, p_amount: 30, p_note: "k" });
  const { data, error } = await w.a.clients.recorder.rpc("offline_balances");
  assert(!error, error?.message);
  assertEqual(data.map((r) => [r.customer_id, r.points, Number(r.due)]), [[w.a.customerId, 12, 30]]);
});
```
> The seed customer's name is `Cust ${tag}`; check `tests/seed.mjs` for the tag used by `seedTwoVendors` (`"a"`/`"A"`) and match it exactly.

- [ ] **Step 2: Run** `npm test`. Expected: new cases FAIL (functions missing).

- [ ] **Step 3: Append Part 3**

```sql
-- ---------------------------------------------------------------------------
-- Part 3: the owner's list, and the device cache's balances
-- ---------------------------------------------------------------------------
create function open_sync_issues()
  returns table (id uuid, bill_id uuid, token_no integer, kind text, amount numeric,
                 detail jsonb, created_at timestamptz, customer_name text)
  language plpgsql stable security definer set search_path = public as $$
begin
  if current_vendor_id() is null or current_user_role() <> 'admin' then
    raise exception 'only an admin may see sync issues' using errcode = '42501';
  end if;
  return query
    select s.id, s.bill_id, b.token_no, s.kind, s.amount, s.detail, s.created_at, c.name
      from sync_issues s
      join bills b on b.id = s.bill_id
      left join customers c on c.id = b.customer_id
     where s.vendor_id = current_vendor_id() and s.status = 'open'
     order by s.created_at;
end $$;
revoke all on function open_sync_issues() from public, anon;
grant execute on function open_sync_issues() to authenticated;

create function resolve_sync_issue(p_id uuid, p_action text) returns void
  language plpgsql security definer set search_path = public as $$
declare
  v_issue sync_issues%rowtype;
  v_bill  bills%rowtype;
begin
  if current_vendor_id() is null or current_user_role() <> 'admin' then
    raise exception 'only an admin may resolve a sync issue' using errcode = '42501';
  end if;
  if p_action not in ('add_as_due', 'dismiss') then
    raise exception 'action must be add_as_due or dismiss' using errcode = '22023';
  end if;
  select * into v_issue from sync_issues where id = p_id for update;
  if not found or v_issue.vendor_id <> current_vendor_id() then
    raise exception 'issue is not in your shop' using errcode = '42501';
  end if;
  if v_issue.status <> 'open' then
    raise exception 'already resolved' using errcode = 'P0001';
  end if;

  if p_action = 'add_as_due' then
    select * into v_bill from bills where id = v_issue.bill_id;
    -- Only a redemption shortfall is money the customer owes: they took goods against
    -- points they did not have. An over-collected due is the shop's to refund.
    if v_issue.kind <> 'redeem_shortfall' or v_bill.customer_id is null then
      raise exception 'only a points shortfall with a customer can become a due' using errcode = '22023';
    end if;
    insert into dues_entries (vendor_id, customer_id, kind, amount, note, business_date, created_by, bill_id)
    values (v_issue.vendor_id, v_bill.customer_id, 'opening', v_issue.amount,
            'Offline bill #' || v_bill.token_no || ': points not available',
            (now() at time zone 'Asia/Kolkata')::date, auth.uid(), v_bill.id);
  end if;

  update sync_issues
     set status = case p_action when 'add_as_due' then 'added_as_due' else 'dismissed' end,
         resolved_by = auth.uid(), resolved_at = now()
   where id = p_id;
end $$;
revoke all on function resolve_sync_issue(uuid, text) from public, anon;
grant execute on function resolve_sync_issue(uuid, text) to authenticated;

create function offline_balances()
  returns table (customer_id uuid, points integer, due numeric)
  language sql stable security definer set search_path = public as $$
  select c.id,
         coalesce((select sum(p.points) from points_ledger p
                    where p.customer_id = c.id and p.expires_at > now()), 0)::integer,
         customer_due(c.id)
    from customers c
   where c.vendor_id = current_vendor_id()
   order by c.id;
$$;
revoke all on function offline_balances() from public, anon;
grant execute on function offline_balances() to authenticated;
```
> Check `dues_entries` has a `bill_id` column (0023 inserts one). If `customer_due` returns null for a customer with no entries, wrap it: `coalesce(customer_due(c.id), 0)`.

- [ ] **Step 4: Run** `npm test`. Expected: all PASS.

- [ ] **Step 5: Commit**
```bash
git add supabase/migrations/0024_offline_billing.sql tests/offline_billing.test.mjs
git commit -m "feat(db): sync issue resolution and offline balances snapshot"
```

---

### Task 4: Key-value store and catalogue snapshot

**Files:**
- Create: `web/src/offline/kv.ts`, `web/src/offline/catalogue.ts`, `web/src/offline/useOnline.ts`
- Modify: `web/src/data.ts` (add `offlineBalances`)
- Test: `web/src/__tests__/catalogue.test.ts`

**Interfaces:**
- Produces:
  - `interface KV { get<T>(k: string): Promise<T | undefined>; set(k: string, v: unknown): Promise<void>; del(k: string): Promise<void>; keys(prefix: string): Promise<string[]> }`
  - `memoryKV(): KV`, `idbKV(name?: string): KV`, `getKV(): KV`, `setKV(k: KV): void`
  - `type Balance = { points: number; due: number }`
  - `type Snapshot = { vendorId: string; cachedAt: number; items: Item[]; customers: Customer[]; balances: Record<string, Balance> }`
  - `saveSnapshot(s: Snapshot)`, `loadSnapshot(vendorId: string): Promise<Snapshot | undefined>`, `isStale(s: Snapshot, now?: number): boolean` (24 h), `refreshSnapshot(vendorId: string): Promise<Snapshot | null>` (null on any read error; never overwrites a good snapshot with a failed read)
  - `useOnline(): boolean` (moved verbatim from `Bill.tsx`, with its comment)
  - `data.ts`: `offlineBalances()` → `supabase.rpc("offline_balances")`

- [ ] **Step 1: Write the failing test**

```ts
// web/src/__tests__/catalogue.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../data", () => ({
  listItems: vi.fn(async () => ({ data: [{ id: "i1", name_en: "Onion", price: 40 }], error: null })),
  listCustomers: vi.fn(async () => ({ data: [{ id: "c1", name: "Asha", flat_no: "A-1" }], error: null })),
  offlineBalances: vi.fn(async () => ({ data: [{ customer_id: "c1", points: 12, due: "30.00" }], error: null })),
}));

const { memoryKV, setKV } = await import("../offline/kv");
const cat = await import("../offline/catalogue");
const data = await import("../data");

beforeEach(() => { setKV(memoryKV()); vi.clearAllMocks(); });

describe("catalogue snapshot", () => {
  it("refresh stores items, customers and numeric balances per vendor", async () => {
    const s = await cat.refreshSnapshot("v1");
    expect(s?.balances).toEqual({ c1: { points: 12, due: 30 } });
    expect((await cat.loadSnapshot("v1"))?.items[0].id).toBe("i1");
    expect(await cat.loadSnapshot("v2")).toBeUndefined();
  });

  it("a failed read keeps the previous snapshot", async () => {
    await cat.refreshSnapshot("v1");
    (data.listItems as any).mockResolvedValueOnce({ data: null, error: { message: "Failed to fetch" } });
    expect(await cat.refreshSnapshot("v1")).toBeNull();
    expect((await cat.loadSnapshot("v1"))?.items).toHaveLength(1);
  });

  it("is stale after 24 hours", () => {
    const s = { vendorId: "v1", cachedAt: 0, items: [], customers: [], balances: {} };
    expect(cat.isStale(s, 24 * 3600e3 - 1)).toBe(false);
    expect(cat.isStale(s, 24 * 3600e3 + 1)).toBe(true);
  });

  it("memoryKV lists keys by prefix", async () => {
    const kv = memoryKV();
    await kv.set("a:1", 1); await kv.set("a:2", 2); await kv.set("b:1", 3);
    expect((await kv.keys("a:")).sort()).toEqual(["a:1", "a:2"]);
  });
});
```

- [ ] **Step 2: Run** `cd web && npx vitest run src/__tests__/catalogue.test.ts`. Expected: FAIL (module not found).

- [ ] **Step 3: Implement**

```ts
// web/src/offline/kv.ts
/** The device's own storage for offline work. IndexedDB in the browser; a Map in tests
 *  and wherever IndexedDB is missing (jsdom), so nothing here needs a polyfill. */
export interface KV {
  get<T>(key: string): Promise<T | undefined>;
  set(key: string, value: unknown): Promise<void>;
  del(key: string): Promise<void>;
  keys(prefix: string): Promise<string[]>;
}

export function memoryKV(): KV {
  const m = new Map<string, unknown>();
  return {
    async get<T>(k: string) { return structuredClone(m.get(k)) as T | undefined; },
    async set(k, v) { m.set(k, structuredClone(v)); },
    async del(k) { m.delete(k); },
    async keys(p) { return [...m.keys()].filter((k) => k.startsWith(p)); },
  };
}

const STORE = "kv";

export function idbKV(name = "vendor-app-offline"): KV {
  let db: Promise<IDBDatabase> | null = null;
  const open = () => (db ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(name, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  }));
  const run = async <T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest): Promise<T> => {
    const d = await open();
    return new Promise((resolve, reject) => {
      const req = fn(d.transaction(STORE, mode).objectStore(STORE));
      req.onsuccess = () => resolve(req.result as T);
      req.onerror = () => reject(req.error);
    });
  };
  return {
    get: <T,>(k: string) => run<T | undefined>("readonly", (s) => s.get(k)),
    set: async (k, v) => { await run("readwrite", (s) => s.put(v, k)); },
    del: async (k) => { await run("readwrite", (s) => s.delete(k)); },
    keys: async (p) =>
      (await run<IDBValidKey[]>("readonly", (s) => s.getAllKeys(IDBKeyRange.bound(p, p + "￿"))))
        .map(String),
  };
}

let current: KV = typeof indexedDB === "undefined" ? memoryKV() : idbKV();
export const getKV = (): KV => current;
/** Tests only. */
export const setKV = (k: KV): void => { current = k; };
```

```ts
// web/src/offline/catalogue.ts
import { listCustomers, listItems, offlineBalances, type Item } from "../data";
import type { Customer } from "../customers";
import { getKV } from "./kv";

export type Balance = { points: number; due: number };
export type Snapshot = {
  vendorId: string; cachedAt: number; items: Item[]; customers: Customer[];
  balances: Record<string, Balance>;
};

const key = (vendorId: string) => `snapshot:${vendorId}`;
const DAY = 24 * 3600e3;

export const saveSnapshot = (s: Snapshot) => getKV().set(key(s.vendorId), s);
export const loadSnapshot = (vendorId: string) => getKV().get<Snapshot>(key(vendorId));
export const isStale = (s: Snapshot, now = Date.now()) => now - s.cachedAt > DAY;

/** All three reads must succeed, or nothing is written: a half-fresh snapshot would show
 *  today's prices against last week's balances with no way to tell. */
export async function refreshSnapshot(vendorId: string): Promise<Snapshot | null> {
  const [i, c, b] = await Promise.all([listItems(), listCustomers(), offlineBalances()]);
  if (i.error || c.error || b.error || !i.data || !c.data || !b.data) return null;
  const balances: Record<string, Balance> = {};
  for (const r of b.data as { customer_id: string; points: number; due: number | string }[]) {
    balances[r.customer_id] = { points: Number(r.points), due: Number(r.due) };
  }
  const s: Snapshot = { vendorId, cachedAt: Date.now(), items: i.data as Item[],
                        customers: c.data as Customer[], balances };
  await saveSnapshot(s);
  return s;
}
```

`web/src/offline/useOnline.ts`: move `useOnline` from `Bill.tsx` unchanged (export it); `Bill.tsx` imports it.

`web/src/data.ts` (append):
```ts
/** Every customer's unexpired points and current due in one call, for the offline cache. */
export async function offlineBalances() {
  return supabase.rpc("offline_balances");
}
```

- [ ] **Step 4: Run** `cd web && npx vitest run`. Expected: all PASS (Bill tests still pass after the `useOnline` move).

- [ ] **Step 5: Commit**
```bash
git add web/src/offline web/src/data.ts web/src/screens/Bill.tsx web/src/__tests__/catalogue.test.ts
git commit -m "feat(web): device storage and catalogue snapshot"
```

---

### Task 5: Outbox and sender

**Files:**
- Create: `web/src/offline/outbox.ts`, `web/src/offline/useOutbox.ts`
- Modify: `web/src/data.ts` (add `recordOfflineBill`)
- Test: `web/src/__tests__/outbox.test.ts`

**Interfaces:**
- Consumes: `getKV`, `setKV`, `memoryKV` (Task 4); `Draft` from `billing.ts` (`{ itemId, qtyKg, unitPrice, … }`); `PaymentMode`.
- Produces:
  - `type OfflineBill = { clientId: string; vendorId: string; seq: number; occurredAt: string; customerId: string; customerLabel: string; lines: Draft[]; mode: PaymentMode; redeemPoints: number; collectDue: number; total: number; state: "waiting" | "attention"; error?: string }`
  - `enqueue(b: Omit<OfflineBill, "seq" | "state" | "clientId" | "occurredAt">): Promise<OfflineBill>` — assigns `clientId = crypto.randomUUID()`, `occurredAt = new Date().toISOString()`, `seq` = next per-vendor sequence, `state = "waiting"`.
  - `listOutbox(vendorId): Promise<OfflineBill[]>` (by `seq`)
  - `type FlushResult = { sent: number; attention: number; stoppedOffline: boolean }`
  - `flush(vendorId, send = sendOfflineBill): Promise<FlushResult>` — oldest first, one at a time; network failure stops the run (bill stays waiting); rejection marks `attention` with the message and continues; success removes the bill.
  - `retry(vendorId, clientId)` — sets an attention bill back to waiting.
  - `isNetworkError(e: { message?: string; code?: string } | null): boolean` — true when there is no `code` and the message matches `/fetch|network|load failed/i`.
  - `useOutbox(vendorId: string | null): { waiting: number; attention: number; flushNow: () => void }` — flushes on mount, `online`, window `focus`, and on a backoff timer (5 s doubling to 5 min, reset on success) while `waiting > 0`; refreshes the Supabase session (`supabase.auth.getSession()`) before flushing; skips when `vendorId` is null.
  - `data.ts`: `recordOfflineBill(b: OfflineBill)` → `supabase.rpc("record_offline_bill", { p_client_id, p_bill })` with payload keys from Task 2; `device_label: \`Offline #${b.seq}\``; `customer_id`; `lines` mapped as in `replaceBillLines`.

- [ ] **Step 1: Write the failing test**

```ts
// web/src/__tests__/outbox.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
vi.mock("../data", () => ({ recordOfflineBill: vi.fn() }));
const { memoryKV, setKV } = await import("../offline/kv");
const ob = await import("../offline/outbox");

const base = (vendorId = "v1") => ({
  vendorId, customerId: "c1", customerLabel: "Asha · A-1",
  lines: [{ itemId: "i1", qtyKg: 2, unitPrice: 40 }] as any, mode: "cash" as const,
  redeemPoints: 0, collectDue: 0, total: 80,
});

beforeEach(() => setKV(memoryKV()));

describe("outbox", () => {
  it("numbers bills per vendor and lists them in order", async () => {
    const a = await ob.enqueue(base()); const b = await ob.enqueue(base()); const c = await ob.enqueue(base("v2"));
    expect([a.seq, b.seq, c.seq]).toEqual([1, 2, 1]);
    expect((await ob.listOutbox("v1")).map((x) => x.clientId)).toEqual([a.clientId, b.clientId]);
  });

  it("never sends or lists another vendor's bills", async () => {
    await ob.enqueue(base("v2"));
    const send = vi.fn();
    const r = await ob.flush("v1", send);
    expect(send).not.toHaveBeenCalled();
    expect(r.sent).toBe(0);
    expect(await ob.listOutbox("v2")).toHaveLength(1);
  });

  it("stops on a network error and keeps the bill waiting", async () => {
    await ob.enqueue(base()); await ob.enqueue(base());
    const send = vi.fn(async () => ({ data: null, error: { message: "TypeError: Failed to fetch" } }));
    const r = await ob.flush("v1", send);
    expect(send).toHaveBeenCalledTimes(1);
    expect(r).toEqual({ sent: 0, attention: 0, stoppedOffline: true });
    expect((await ob.listOutbox("v1")).every((b) => b.state === "waiting")).toBe(true);
  });

  it("marks a rejection for attention and carries on", async () => {
    const a = await ob.enqueue(base()); await ob.enqueue(base());
    const send = vi.fn()
      .mockResolvedValueOnce({ data: null, error: { code: "P0002", message: "an item on this bill no longer exists" } })
      .mockResolvedValueOnce({ data: { bill_id: "b2", token_no: 9, issues: [] }, error: null });
    const r = await ob.flush("v1", send);
    expect(r).toEqual({ sent: 1, attention: 1, stoppedOffline: false });
    const left = await ob.listOutbox("v1");
    expect(left).toHaveLength(1);
    expect(left[0]).toMatchObject({ clientId: a.clientId, state: "attention", error: "an item on this bill no longer exists" });
  });

  it("skips attention bills until retried", async () => {
    const a = await ob.enqueue(base());
    await ob.flush("v1", vi.fn(async () => ({ data: null, error: { code: "P0001", message: "day is closed" } })));
    const send = vi.fn(async () => ({ data: { bill_id: "b", token_no: 1, issues: [] }, error: null }));
    await ob.flush("v1", send);
    expect(send).not.toHaveBeenCalled();
    await ob.retry("v1", a.clientId);
    await ob.flush("v1", send);
    expect(send).toHaveBeenCalledTimes(1);
    expect(await ob.listOutbox("v1")).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run** `cd web && npx vitest run src/__tests__/outbox.test.ts`. Expected: FAIL.

- [ ] **Step 3: Implement**

```ts
// web/src/offline/outbox.ts
import type { Draft } from "../billing";
import type { PaymentMode } from "../payments";
import { recordOfflineBill } from "../data";
import { getKV } from "./kv";

export type OfflineBill = {
  clientId: string; vendorId: string; seq: number; occurredAt: string;
  customerId: string; customerLabel: string; lines: Draft[]; mode: PaymentMode;
  redeemPoints: number; collectDue: number; total: number;
  state: "waiting" | "attention"; error?: string;
};
type Reply = { data: unknown; error: { message?: string; code?: string } | null };
export type FlushResult = { sent: number; attention: number; stoppedOffline: boolean };

const billKey = (v: string, id: string) => `outbox:${v}:${id}`;
const seqKey = (v: string) => `outbox-seq:${v}`;

export function isNetworkError(e: { message?: string; code?: string } | null): boolean {
  return !!e && !e.code && /fetch|network|load failed/i.test(e.message ?? "");
}

export async function enqueue(
  b: Omit<OfflineBill, "seq" | "state" | "clientId" | "occurredAt">,
): Promise<OfflineBill> {
  const kv = getKV();
  const seq = ((await kv.get<number>(seqKey(b.vendorId))) ?? 0) + 1;
  await kv.set(seqKey(b.vendorId), seq);
  const bill: OfflineBill = { ...b, seq, state: "waiting", clientId: crypto.randomUUID(),
                              occurredAt: new Date().toISOString() };
  await kv.set(billKey(b.vendorId, bill.clientId), bill);
  return bill;
}

export async function listOutbox(vendorId: string): Promise<OfflineBill[]> {
  const kv = getKV();
  const keys = await kv.keys(`outbox:${vendorId}:`);
  const bills = await Promise.all(keys.map((k) => kv.get<OfflineBill>(k)));
  return (bills.filter(Boolean) as OfflineBill[]).sort((a, b) => a.seq - b.seq);
}

export async function retry(vendorId: string, clientId: string) {
  const kv = getKV();
  const b = await kv.get<OfflineBill>(billKey(vendorId, clientId));
  if (b) await kv.set(billKey(vendorId, clientId), { ...b, state: "waiting", error: undefined });
}

/** One at a time and in order, so tokens come out in the order the sales happened. A
 *  network failure stops the run -- the next bill would fail the same way. A rejection is
 *  this bill's alone, so it is set aside and the rest still go. */
export async function flush(
  vendorId: string, send: (b: OfflineBill) => Promise<Reply> = recordOfflineBill,
): Promise<FlushResult> {
  const kv = getKV();
  const r: FlushResult = { sent: 0, attention: 0, stoppedOffline: false };
  for (const b of await listOutbox(vendorId)) {
    if (b.state !== "waiting") continue;
    let reply: Reply;
    try { reply = await send(b); }
    catch (e) { reply = { data: null, error: { message: String((e as Error)?.message ?? e) } }; }
    if (!reply.error) { await kv.del(billKey(vendorId, b.clientId)); r.sent++; continue; }
    if (isNetworkError(reply.error)) { r.stoppedOffline = true; break; }
    await kv.set(billKey(vendorId, b.clientId), { ...b, state: "attention", error: reply.error.message ?? "" });
    r.attention++;
  }
  return r;
}
```

```ts
// web/src/data.ts (append; import type OfflineBill from "./offline/outbox")
/** Idempotent on clientId (0024): a resend after a lost reply returns the first result. */
export async function recordOfflineBill(b: OfflineBill) {
  return supabase.rpc("record_offline_bill", {
    p_client_id: b.clientId,
    p_bill: {
      lines: b.lines.map((l) => ({ item_id: l.itemId, qty_kg: l.qtyKg, unit_price: l.unitPrice })),
      customer_id: b.customerId, payment_mode: b.mode,
      redeem_points: b.redeemPoints, collect_due: b.collectDue,
      occurred_at: b.occurredAt, device_label: `Offline #${b.seq}`,
    },
  });
}
```
> `import type` avoids a runtime cycle between `data.ts` and `outbox.ts`.

```ts
// web/src/offline/useOutbox.ts
import { useCallback, useEffect, useRef, useState } from "react";
import { supabase } from "../supabase";
import { flush, listOutbox } from "./outbox";

const MIN = 5_000, MAX = 300_000;

export function useOutbox(vendorId: string | null) {
  const [counts, setCounts] = useState({ waiting: 0, attention: 0 });
  const delay = useRef(MIN);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const busy = useRef(false);

  const recount = useCallback(async () => {
    if (!vendorId) return;
    const all = await listOutbox(vendorId);
    const waiting = all.filter((b) => b.state === "waiting").length;
    setCounts({ waiting, attention: all.length - waiting });
    return waiting;
  }, [vendorId]);

  const run = useCallback(async () => {
    if (!vendorId || busy.current) return;
    busy.current = true;
    try {
      if (timer.current) clearTimeout(timer.current);
      if (navigator.onLine) {
        await supabase.auth.getSession(); // refreshes an expired token before sending
        const r = await flush(vendorId);
        delay.current = r.stoppedOffline ? Math.min(delay.current * 2, MAX) : MIN;
      }
      const waiting = await recount();
      if (waiting) timer.current = setTimeout(() => void run(), delay.current);
    } finally { busy.current = false; }
  }, [vendorId, recount]);

  useEffect(() => {
    void run();
    const on = () => void run();
    window.addEventListener("online", on);
    window.addEventListener("focus", on);
    window.addEventListener("outbox-changed", on);
    return () => {
      window.removeEventListener("online", on);
      window.removeEventListener("focus", on);
      window.removeEventListener("outbox-changed", on);
      if (timer.current) clearTimeout(timer.current);
    };
  }, [run]);

  return { ...counts, flushNow: () => void run() };
}
```
> `enqueue` callers dispatch `window.dispatchEvent(new Event("outbox-changed"))` after enqueuing so the chip updates.

- [ ] **Step 4: Run** `cd web && npx vitest run`. Expected: PASS.

- [ ] **Step 5: Commit**
```bash
git add web/src/offline web/src/data.ts web/src/__tests__/outbox.test.ts
git commit -m "feat(web): per-vendor outbox and in-order sender"
```

---

### Task 6: Offline session, routes, chip

**Files:**
- Create: `web/src/offline/sessionCache.ts`
- Modify: `web/src/components/SessionProvider.tsx`, `web/src/routes.ts`, `web/src/components/Shell.tsx`, `web/src/components/Guard.tsx`
- Test: `web/src/__tests__/sessionCache.test.ts`, extend `web/src/__tests__/routes.test.ts`, extend `web/src/__tests__/SessionProvider.test.tsx`

**Interfaces:**
- Consumes: `useOnline`, `useOutbox`.
- Produces:
  - `rememberSession(userId: string, email: string, row: AppUserRow): void` / `recallSession(): { userId: string; email: string; row: AppUserRow } | null` — `localStorage` key `vendor-app:last-session` (small, sync, available before IndexedDB opens).
  - `routesForRole(role: Role, opts?: { offline?: boolean }): RouteDef[]` — offline: returns `[{ path: "/bill", labelKey: "nav.bill" }, { path: "/outbox", labelKey: "nav.outbox" }]` for every role.
  - `canAccess(role, path, opts?: { offline?: boolean })` — offline: only `/bill` and `/outbox`; online: adds `/outbox` for every role and `/sync-issues` for admin (admin `BY_ROLE` gains `{ path: "/sync-issues", labelKey: "nav.syncIssues" }` at the end).
  - `homeFor(role, opts?)` follows `routesForRole`.
  - Shell renders `OfflineChip`: when offline or `waiting + attention > 0`, "Offline · N waiting" / "N bills waiting to sync" / "N need attention", linking to `/outbox`. Replaces `OfflineBanner` (delete it and its comment, which is no longer true).

- [ ] **Step 1: Write failing tests**

```ts
// web/src/__tests__/sessionCache.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import { recallSession, rememberSession } from "../offline/sessionCache";
const row = { name: "R", role: "recorder", vendor_id: "v1", vendors: { name: "V", suspended_at: null }, must_change_password: false } as const;
beforeEach(() => localStorage.clear());
describe("session cache", () => {
  it("round-trips the last ready session", () => {
    rememberSession("u1", "r@x", row as any);
    expect(recallSession()).toEqual({ userId: "u1", email: "r@x", row });
  });
  it("returns null on garbage", () => {
    localStorage.setItem("vendor-app:last-session", "{bad");
    expect(recallSession()).toBeNull();
  });
});
```

Add to `routes.test.ts`:
```ts
it("offline, every role gets Bill and the outbox and nothing else", () => {
  for (const role of ["admin", "recorder", "biller"] as const) {
    expect(routesForRole(role, { offline: true }).map((r) => r.path)).toEqual(["/bill", "/outbox"]);
    expect(canAccess(role, "/bill", { offline: true })).toBe(true);
    expect(canAccess(role, "/dues", { offline: true })).toBe(false);
  }
});
it("online, only admin reaches sync issues; everyone reaches the outbox", () => {
  expect(canAccess("admin", "/sync-issues")).toBe(true);
  expect(canAccess("biller", "/sync-issues")).toBe(false);
  expect(canAccess("biller", "/outbox")).toBe(true);
  expect(canAccess("biller", "/bill")).toBe(false);
});
```

Add to `SessionProvider.test.tsx` (follow that file's existing mocking of `supabase`): when `getSession` resolves with `{ data: { session: null }, error: { message: "Failed to fetch" } }` **or** the `app_users` read errors with a fetch-shaped error, and `recallSession()` returns a row, the provider yields `{ kind: "ready", … }` from the cached row; when online and the read succeeds, `rememberSession` is called with the row.

- [ ] **Step 2: Run** `cd web && npx vitest run`. Expected: new cases FAIL.

- [ ] **Step 3: Implement**

```ts
// web/src/offline/sessionCache.ts
import type { AppUserRow } from "../session";
const KEY = "vendor-app:last-session";
type Cached = { userId: string; email: string; row: AppUserRow };

/** Lets a reload with no network open the counter as the last person signed in. The
 *  server re-checks everything when the queue is sent, so this grants nothing there. */
export function rememberSession(userId: string, email: string, row: AppUserRow): void {
  try { localStorage.setItem(KEY, JSON.stringify({ userId, email, row })); } catch { /* private mode */ }
}
export function recallSession(): Cached | null {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? "null");
    return v && typeof v.userId === "string" && v.row ? (v as Cached) : null;
  } catch { return null; }
}
export function forgetSession(): void {
  try { localStorage.removeItem(KEY); } catch { /* ignore */ }
}
```

`SessionProvider.tsx` changes:
- After a successful `app_users` read with a row: `rememberSession(userId, email, data)`.
- In `load`, on `error` where `isNetworkError(error)` (from `offline/outbox`): `const c = recallSession(); if (c && c.userId === userId) { setState(sessionFromRow(c.userId, c.email, c.row)); return; }` before the existing error branch.
- In the `getSession()` handler: `if (!s) { const c = !navigator.onLine || isNetworkError(error) ? recallSession() : null; if (c) setState(sessionFromRow(c.userId, c.email, c.row)); else setState({ kind: "signedOut" }); }`.
- On an explicit sign-out (`onAuthStateChange` with event `"SIGNED_OUT"`): `forgetSession()`. The outbox is not touched.

`routes.ts`:
```ts
const OFFLINE: RouteDef[] = [
  { path: "/bill", labelKey: "nav.bill" },
  { path: "/outbox", labelKey: "nav.outbox" },
];
type Opts = { offline?: boolean };

export function routesForRole(role: Role, opts: Opts = {}): RouteDef[] {
  return opts.offline ? OFFLINE : BY_ROLE[role];
}
export function canAccess(role: Role, path: string, opts: Opts = {}): boolean {
  if (opts.offline) return OFFLINE.some((r) => r.path === path);
  if (path === "/outbox") return true;
  if (BY_ROLE[role].some((r) => r.path === path)) return true;
  return UNLISTED[role].some((prefix) => matchesUnlisted(prefix, path));
}
export function homeFor(role: Role, opts: Opts = {}): string { /* first of routesForRole(role, opts) */ }
```
Add `{ path: "/sync-issues", labelKey: "nav.syncIssues" }` to the end of `BY_ROLE.admin`. Update the file's top comment: offline routes are UX too; `record_offline_bill` is what enforces roles.

`Shell.tsx` and `Guard.tsx`: call `useOnline()` and pass `{ offline: !online }` to `routesForRole` / `canAccess` / `homeFor`. Shell calls `useOutbox(session.vendorId)` and renders the chip (replace `OfflineBanner`):
```tsx
function OfflineChip({ online, waiting, attention }: { online: boolean; waiting: number; attention: number }) {
  const { t } = useTranslation();
  if (online && waiting + attention === 0) return null;
  return (
    <Link to="/outbox" className="block bg-amber-100 text-amber-900 text-sm px-4 py-2 text-center">
      {!online && t("offline.chip")}{!online && waiting + attention > 0 && " · "}
      {waiting > 0 && t("offline.waiting", { count: waiting })}
      {attention > 0 && ` · ${t("offline.attention", { count: attention })}`}
    </Link>
  );
}
```

- [ ] **Step 4: Run** `cd web && npx vitest run`. Expected: PASS. Fix existing Shell/Guard tests that asserted `offline.banner` to assert `offline.chip`.

- [ ] **Step 5: Commit**
```bash
git add web/src
git commit -m "feat(web): offline session, offline routes for every role, sync chip"
```

---

### Task 7: Offline sale on the Bill screen

**Files:**
- Create: `web/src/screens/bill/OfflineCheckout.tsx`, `web/src/screens/bill/OfflineResult.tsx`
- Modify: `web/src/screens/Bill.tsx`, `web/src/screens/bill/CustomerStep.tsx`, `web/src/i18n/{en,hi,mr}.json`
- Test: `web/src/__tests__/BillOffline.test.tsx`, `web/src/__tests__/offlineCheckout.test.ts`

**Interfaces:**
- Consumes: `loadSnapshot`, `refreshSnapshot`, `isStale` (Task 4); `enqueue` (Task 5); `useOnline`; `runningTotal` from `billing.ts`; `PAYMENT_MODES`; `rupees` from `money.ts`.
- Produces:
  - `checkoutLimits(total: number, balance: Balance | undefined, mode: PaymentMode): { maxRedeem: number; maxCollect: number }` exported from `OfflineCheckout.tsx` — `maxRedeem = min(balance.points, floor(total))`, `maxCollect = mode === "credit" ? 0 : max(balance.due, 0)`; both 0 with no balance.
  - `<OfflineCheckout total balance onConfirm(mode, redeem, collect) onCancel />`
  - `<OfflineResult seq total onStartNew />`
  - `CustomerStep` gains `allowCreate?: boolean` (default `true`); when false the "new customer" form is hidden and `t("offline.noNewCustomer")` shown.

**Behaviour in `Bill.tsx`:**
- Data: online → `listItems`/`listCustomers` as today, then `void refreshSnapshot(vendorId)`; offline → `loadSnapshot(vendorId)`; no snapshot → `t("offline.noCache")` and nothing else. Stale snapshot → `t("offline.stale")` note.
- Done button: enabled when `lines.length > 0 && !issuing` (no longer requires `online`).
- Offline (`!online`) or after the online `createBill` fails with `isNetworkError` (show a button `t("offline.saveOffline")` next to the failure; only if `written === null`, so a bill that already reached the server is never duplicated offline): Done opens `OfflineCheckout` instead of the token confirm.
- `onConfirm` → `enqueue({ vendorId, customerId, customerLabel: \`${name} · ${flat_no}\`, lines, mode, redeemPoints, collectDue, total })`, dispatch `outbox-changed`, show `OfflineResult` with its `seq`.
- The online token flow is untouched.

- [ ] **Step 1: Write failing tests**

```ts
// web/src/__tests__/offlineCheckout.test.ts
import { describe, it, expect } from "vitest";
import { checkoutLimits } from "../screens/bill/OfflineCheckout";
describe("offline checkout limits", () => {
  it("redeem is capped by points and by the whole-rupee total", () => {
    expect(checkoutLimits(99.5, { points: 500, due: 0 }, "cash").maxRedeem).toBe(99);
    expect(checkoutLimits(200, { points: 30, due: 0 }, "cash").maxRedeem).toBe(30);
  });
  it("collecting a due is capped by the cached due and impossible on credit", () => {
    expect(checkoutLimits(80, { points: 0, due: 120 }, "upi").maxCollect).toBe(120);
    expect(checkoutLimits(80, { points: 0, due: 120 }, "credit").maxCollect).toBe(0);
    expect(checkoutLimits(80, { points: 0, due: -5 }, "cash").maxCollect).toBe(0);
  });
  it("no cached balance allows neither", () => {
    expect(checkoutLimits(80, undefined, "cash")).toEqual({ maxRedeem: 0, maxCollect: 0 });
  });
});
```

```tsx
// web/src/__tests__/BillOffline.test.tsx
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

vi.mock("../data", () => ({
  listItems: vi.fn(), listCustomers: vi.fn(), createCustomer: vi.fn(), findCustomerByMobile: vi.fn(),
  createBill: vi.fn(), replaceBillLines: vi.fn(), issueToken: vi.fn(), billToken: vi.fn(),
  offlineBalances: vi.fn(), recordOfflineBill: vi.fn(),
}));
vi.mock("../components/SessionProvider", () => ({
  useSession: () => ({ kind: "ready", userId: "u1", vendorId: "v1", vendorName: "V", name: "R", role: "biller" }),
}));
vi.mock("../offline/useOnline", () => ({ useOnline: () => false }));

const { memoryKV, setKV } = await import("../offline/kv");
const { saveSnapshot } = await import("../offline/catalogue");
const { listOutbox } = await import("../offline/outbox");
const { default: Bill } = await import("../screens/Bill");
const data = await import("../data");

beforeEach(async () => {
  setKV(memoryKV());
  await saveSnapshot({ vendorId: "v1", cachedAt: Date.now(),
    items: [{ id: "i1", name_en: "Onion", name_hi: "प्याज", name_mr: "कांदा", price: 40, stock_kg: 100, is_active: true, unit: "kg", low_stock_at: 10 } as any],
    customers: [{ id: "c1", name: "Asha", flat_no: "A-1", mobile: "+9198" } as any],
    balances: { c1: { points: 10, due: 50 } } });
});

describe("offline bill", () => {
  it("records a sale into the outbox without touching the network", async () => {
    render(<MemoryRouter><Bill /></MemoryRouter>);
    fireEvent.click(await screen.findByText("Asha"));
    // add one line the same way Bill.test.tsx does (select item, type qty 2, add)
    // … mirror the helper used in Bill.test.tsx …
    fireEvent.click(screen.getByRole("button", { name: /done/i }));
    fireEvent.click(await screen.findByLabelText(/upi/i));
    fireEvent.click(screen.getByRole("button", { name: /record sale/i }));
    expect(await screen.findByText(/Offline #1/)).toBeTruthy();
    const q = await listOutbox("v1");
    expect(q).toHaveLength(1);
    expect(q[0]).toMatchObject({ customerId: "c1", mode: "upi", total: 80 });
    expect(data.createBill).not.toHaveBeenCalled();
    expect(data.listItems).not.toHaveBeenCalled();
  });

  it("refuses to open without a cache", async () => {
    setKV(memoryKV());
    render(<MemoryRouter><Bill /></MemoryRouter>);
    expect(await screen.findByText(/connect once/i)).toBeTruthy();
  });

  it("hides new-customer creation offline", async () => {
    render(<MemoryRouter><Bill /></MemoryRouter>);
    expect(await screen.findByText(/needs a connection/i)).toBeTruthy();
  });
});
```
> The implementer copies the exact line-adding interaction from `Bill.test.tsx` (it already drives `ItemGrid`); do not invent a new one.

- [ ] **Step 2: Run** `cd web && npx vitest run`. Expected: new cases FAIL.

- [ ] **Step 3: Implement**

```tsx
// web/src/screens/bill/OfflineCheckout.tsx
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { PAYMENT_MODES, type PaymentMode } from "../../payments";
import { rupees } from "../../money";
import type { Balance } from "../../offline/catalogue";

export function checkoutLimits(total: number, balance: Balance | undefined, mode: PaymentMode) {
  if (!balance) return { maxRedeem: 0, maxCollect: 0 };
  return {
    maxRedeem: Math.max(0, Math.min(balance.points, Math.floor(total))),
    maxCollect: mode === "credit" ? 0 : Math.max(balance.due, 0),
  };
}

/** The offline end of a bill: what a biller asks at the counter, against the device's
 *  last-known balances. Inputs are capped here, so a sync issue can only come from the
 *  cache being out of date -- never from a typo. */
export function OfflineCheckout({ total, balance, onConfirm, onCancel }: {
  total: number; balance: Balance | undefined;
  onConfirm: (mode: PaymentMode, redeem: number, collect: number) => void; onCancel: () => void;
}) {
  const { t } = useTranslation();
  const [mode, setMode] = useState<PaymentMode>("cash");
  const [redeem, setRedeem] = useState(0);
  const [collect, setCollect] = useState(0);
  const { maxRedeem, maxCollect } = checkoutLimits(total, balance, mode);
  const r = Math.min(redeem, maxRedeem), c = Math.min(collect, maxCollect);
  return (
    <div role="dialog" aria-modal="true" aria-label={t("offline.checkoutTitle")}
         className="fixed inset-0 bg-black/40 flex items-end sm:items-center justify-center p-4">
      <div className="bg-white rounded-xl p-4 w-full max-w-sm space-y-3">
        <p className="font-semibold">{t("offline.checkoutTitle")} · {rupees(total - r)}</p>
        <fieldset className="flex flex-wrap gap-2">
          {PAYMENT_MODES.map((m) => (
            <label key={m} className="flex items-center gap-1">
              <input type="radio" name="mode" checked={mode === m} onChange={() => setMode(m)} />
              {t(`payments.${m}`)}
            </label>
          ))}
        </fieldset>
        {maxRedeem > 0 && (
          <label className="block text-sm">{t("offline.redeem", { max: maxRedeem })}
            <input type="number" min={0} max={maxRedeem} value={r}
                   onChange={(e) => setRedeem(Math.max(0, Math.floor(Number(e.target.value) || 0)))}
                   className="w-full border rounded px-2 py-1" />
          </label>
        )}
        {maxCollect > 0 && (
          <label className="block text-sm">{t("offline.collect", { max: rupees(maxCollect) })}
            <input type="number" min={0} max={maxCollect} step="0.01" value={c}
                   onChange={(e) => setCollect(Math.max(0, Math.round((Number(e.target.value) || 0) * 100) / 100))}
                   className="w-full border rounded px-2 py-1" />
          </label>
        )}
        <p className="text-xs text-slate-500">{t("offline.provisional")}</p>
        <button onClick={() => onConfirm(mode, r, c)}
                className="w-full rounded-lg px-3 py-3 min-h-[44px] bg-emerald-600 text-white font-semibold">
          {t("offline.recordSale")}
        </button>
        <button onClick={onCancel} className="w-full rounded-lg px-3 py-2 min-h-[44px] border border-slate-300">
          {t("bill.cancel")}
        </button>
      </div>
    </div>
  );
}
```
> Use the existing payment-mode label keys from `Pending.tsx` (grep `t(\`payments.` or equivalent there) instead of `payments.${m}` if they differ.

```tsx
// web/src/screens/bill/OfflineResult.tsx
import { useTranslation } from "react-i18next";
import { rupees } from "../../money";
export function OfflineResult({ seq, total, onStartNew }: { seq: number; total: number; onStartNew: () => void }) {
  const { t } = useTranslation();
  return (
    <div className="text-center space-y-3">
      <p className="text-3xl font-bold">Offline #{seq}</p>
      <p className="text-lg">{rupees(total)}</p>
      <p className="text-sm text-slate-500">{t("offline.willSync")}</p>
      <button onClick={onStartNew} className="w-full rounded-xl px-3 py-3 min-h-[44px] bg-emerald-600 text-white font-semibold">
        {t("bill.startNew")}
      </button>
    </div>
  );
}
```
> Use the key `TokenResult.tsx` uses for "start new" if it is not `bill.startNew`.

`Bill.tsx`: add state `offlineCheckout: boolean`, `offlineDone: { seq: number; total: number } | null`, `snapshot: Snapshot | null | undefined`; implement the behaviour list above; `startNew()` also clears `offlineDone`. Update the component's doc comment: online flow unchanged; offline, Done ends in `OfflineCheckout` → `enqueue`.

i18n keys (en; add hi/mr equivalents):
```json
"offline": {
  "chip": "Offline",
  "waiting_one": "{{count}} bill waiting to sync", "waiting_other": "{{count}} bills waiting to sync",
  "attention_one": "{{count}} needs attention", "attention_other": "{{count}} need attention",
  "checkoutTitle": "Offline sale",
  "redeem": "Redeem points (up to {{max}})",
  "collect": "Collect old due (up to {{max}})",
  "provisional": "Points and dues are from this device's last sync and will be checked when it reconnects.",
  "recordSale": "Record sale",
  "willSync": "Saved on this device. It gets its token when the internet is back.",
  "noCache": "This device has no saved price list yet. Connect once to download it.",
  "stale": "Prices and balances on this device are more than a day old.",
  "noNewCustomer": "Adding a new customer needs a connection.",
  "saveOffline": "Save as offline sale",
  "needsConnection": "This screen needs a connection."
}
```
Remove `offline.banner` from all three files once nothing references it.

- [ ] **Step 4: Run** `cd web && npx vitest run`. Expected: PASS, including the unchanged `Bill.test.tsx` and `locales.test.ts` (keys present in all three languages).

- [ ] **Step 5: Commit**
```bash
git add web/src
git commit -m "feat(web): offline sale on the Bill screen for every role"
```

---

### Task 8: Outbox and Sync issues screens

**Files:**
- Create: `web/src/screens/Outbox.tsx`, `web/src/screens/SyncIssues.tsx`, `web/src/syncIssues.ts`
- Modify: `web/src/App.tsx` (routes `/outbox`, `/sync-issues`), `web/src/i18n/{en,hi,mr}.json` (`nav.outbox`, `nav.syncIssues`, `outbox.*`, `syncIssues.*`)
- Test: `web/src/__tests__/Outbox.test.tsx`, `web/src/__tests__/SyncIssues.test.tsx`

**Interfaces:**
- Consumes: `listOutbox`, `retry`, `useOutbox` (Task 5); routes from Task 6.
- Produces:
  - `syncIssues.ts`: `type SyncIssue = { id: string; bill_id: string; token_no: number; kind: "redeem_shortfall" | "due_overcollected" | "rebooked_closed_day" | "time_clamped"; amount: number | null; detail: Record<string, unknown>; created_at: string; customer_name: string | null }`; `listSyncIssues()` → `rpc("open_sync_issues")`; `resolveSyncIssue(id, action: "add_as_due" | "dismiss")` → `rpc("resolve_sync_issue", { p_id, p_action })`.
  - Outbox screen: list of bills (`Offline #seq`, customer label, total, time, state); attention rows show `error` and a **Retry** button (`retry` then `flushNow`); a **Sync now** button (disabled offline).
  - Sync issues screen: one row per issue with token, customer, a sentence per kind (`syncIssues.kind.<kind>` with `{{amount}}`, `{{from}}`, `{{to}}`), **Add as due** only for `redeem_shortfall` with a customer, **Dismiss** for all; after an action, reload the list; errors via `describeError`.

- [ ] **Step 1: Write failing tests**

```tsx
// web/src/__tests__/SyncIssues.test.tsx
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
vi.mock("../syncIssues", () => ({
  listSyncIssues: vi.fn(async () => ({ data: [
    { id: "s1", bill_id: "b1", token_no: 12, kind: "redeem_shortfall", amount: 20, detail: {}, created_at: "2026-09-25T10:00:00Z", customer_name: "Asha" },
    { id: "s2", bill_id: "b2", token_no: 13, kind: "time_clamped", amount: null, detail: {}, created_at: "2026-09-25T10:00:00Z", customer_name: null },
  ], error: null })),
  resolveSyncIssue: vi.fn(async () => ({ data: null, error: null })),
}));
const { default: SyncIssues } = await import("../screens/SyncIssues");
const api = await import("../syncIssues");
beforeEach(() => vi.clearAllMocks());

describe("sync issues", () => {
  it("offers Add as due only for a points shortfall", async () => {
    render(<SyncIssues />);
    await screen.findByText(/#12/);
    expect(screen.getAllByRole("button", { name: /add as due/i })).toHaveLength(1);
    expect(screen.getAllByRole("button", { name: /dismiss/i })).toHaveLength(2);
  });
  it("resolves and reloads", async () => {
    render(<SyncIssues />);
    fireEvent.click(await screen.findByRole("button", { name: /add as due/i }));
    await waitFor(() => expect(api.resolveSyncIssue).toHaveBeenCalledWith("s1", "add_as_due"));
    expect(api.listSyncIssues).toHaveBeenCalledTimes(2);
  });
});
```

```tsx
// web/src/__tests__/Outbox.test.tsx
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
vi.mock("../data", () => ({ recordOfflineBill: vi.fn() }));
vi.mock("../components/SessionProvider", () => ({
  useSession: () => ({ kind: "ready", userId: "u1", vendorId: "v1", vendorName: "V", name: "R", role: "recorder" }),
}));
const { memoryKV, setKV } = await import("../offline/kv");
const ob = await import("../offline/outbox");
const { default: Outbox } = await import("../screens/Outbox");

beforeEach(async () => {
  setKV(memoryKV());
  const b = await ob.enqueue({ vendorId: "v1", customerId: "c1", customerLabel: "Asha · A-1",
    lines: [] as any, mode: "cash", redeemPoints: 0, collectDue: 0, total: 80 });
  await ob.flush("v1", async () => ({ data: null, error: { code: "P0001", message: "day is closed" } }));
  void b;
});

describe("outbox screen", () => {
  it("shows a bill that needs attention with its reason and a retry", async () => {
    render(<Outbox />);
    expect(await screen.findByText(/Offline #1/)).toBeTruthy();
    expect(screen.getByText(/day is closed/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /retry/i }));
    await waitFor(async () => expect((await ob.listOutbox("v1"))[0]?.state ?? "gone").not.toBe("attention"));
  });
});
```

- [ ] **Step 2: Run** `cd web && npx vitest run`. Expected: FAIL.

- [ ] **Step 3: Implement** the three files per the interfaces above, following the list/empty/error layout of `screens/Dues.tsx`. Add i18n:
```json
"nav": { "outbox": "Waiting to sync", "syncIssues": "Sync issues" },
"outbox": { "empty": "Nothing waiting. Every bill is synced.", "syncNow": "Sync now", "retry": "Retry", "waiting": "Waiting", "attention": "Needs attention" },
"syncIssues": {
  "empty": "No sync issues.",
  "addAsDue": "Add as due", "dismiss": "Dismiss",
  "kind": {
    "redeem_shortfall": "Redeemed points that were not there; {{amount}} was not paid.",
    "due_overcollected": "Collected {{amount}} more than the customer owed. Refund it or keep it as an advance.",
    "rebooked_closed_day": "Made on {{from}}, which was already closed, so it was added to {{to}}.",
    "time_clamped": "The device clock was wrong; the sale was given the nearest allowed time."
  }
}
```
Merge into the existing `nav` object; do not add a second one.

- [ ] **Step 4: Run** `cd web && npx vitest run`. Expected: PASS.

- [ ] **Step 5: Commit**
```bash
git add web/src
git commit -m "feat(web): outbox and sync issues screens"
```

---

### Task 9: Installable app shell (service worker)

**Files:**
- Create: `web/src/offline/assetList.ts`, `web/public/sw.js`, `web/public/manifest.webmanifest`, `web/public/icon-192.png`, `web/public/icon-512.png`
- Modify: `web/vite.config.ts`, `web/index.html`, `web/src/main.tsx`, `web/src/components/Shell.tsx` (update prompt)
- Test: `web/src/__tests__/assetList.test.ts`

**Interfaces:**
- Produces:
  - `assetList(fileNames: string[], base: string): string[]` — `[base, base + "index.html", ...fileNames.filter(f => f.startsWith("assets/")).map(f => base + f)]`, sorted after the first two, no duplicates.
  - Vite plugin (inline in `vite.config.ts`) emitting `precache.json` = `{ "version": <hash of the list>, "files": assetList(...) }`.
  - `sw.js`: on `install` fetch `precache.json`, open cache `shell-<version>`, `addAll(files)`; on `activate` delete other `shell-*` caches; on `fetch`: ignore non-GET and any URL not under the SW scope (Supabase is another origin, so it is never touched); navigations → network, falling back to cached `index.html`; `/assets/` → cache first; on message `"skip-waiting"` → `skipWaiting()`.
  - `main.tsx`: in `import.meta.env.PROD`, `navigator.serviceWorker.register(import.meta.env.BASE_URL + "sw.js")`; when a new worker is `installed` while a controller exists, dispatch `window` event `"app-update-ready"` with the registration.
  - Shell: on `"app-update-ready"` show a strip `t("app.updateReady")` with a button; click → `reg.waiting?.postMessage("skip-waiting")`, then reload on `controllerchange`. Never reloads by itself.

> Navigations are **network first** here, not cache first as the spec says: with no-cache GitHub Pages HTML, cache-first would pin old HTML whose hashed assets a new deploy deleted. Network-first with an `index.html` fallback gives the same offline result without that failure. Note this in the commit message.

- [ ] **Step 1: Write the failing test**

```ts
// web/src/__tests__/assetList.test.ts
import { describe, it, expect } from "vitest";
import { assetList } from "../offline/assetList";
describe("assetList", () => {
  it("keeps the shell and hashed assets under the base, nothing else", () => {
    expect(assetList(["assets/b-2.js", "index.html", "assets/a-1.css", "sw.js", "assets/b-2.js"], "/vendor-app/"))
      .toEqual(["/vendor-app/", "/vendor-app/index.html", "/vendor-app/assets/a-1.css", "/vendor-app/assets/b-2.js"]);
  });
});
```

- [ ] **Step 2: Run** `cd web && npx vitest run src/__tests__/assetList.test.ts`. Expected: FAIL.

- [ ] **Step 3: Implement**

```ts
// web/src/offline/assetList.ts
/** What the service worker precaches: the page and every hashed asset. Pure so the build
 *  plugin and its test agree on one definition. */
export function assetList(fileNames: string[], base: string): string[] {
  const assets = [...new Set(fileNames.filter((f) => f.startsWith("assets/")))].sort();
  return [base, `${base}index.html`, ...assets.map((f) => base + f)];
}
```

```ts
// web/vite.config.ts (add)
import { createHash } from "node:crypto";
import type { Plugin } from "vite";
import { assetList } from "./src/offline/assetList";

const BASE = "/vendor-app/";
function precache(): Plugin {
  return {
    name: "precache-manifest",
    apply: "build",
    generateBundle(_opts, bundle) {
      const files = assetList(Object.keys(bundle), BASE);
      const version = createHash("sha256").update(files.join("\n")).digest("hex").slice(0, 12);
      this.emitFile({ type: "asset", fileName: "precache.json", source: JSON.stringify({ version, files }) });
    },
  };
}
// plugins: [react(), tailwindcss(), precache()], base: BASE
```

```js
// web/public/sw.js
// The app shell only. Data never passes through here: Supabase is another origin, and the
// device's own cache of prices and balances lives in IndexedDB (src/offline).
const SCOPE = self.registration.scope;

async function currentVersion() {
  const hit = await (await caches.open("shell-meta")).match("version");
  return hit ? hit.text() : null;
}

self.addEventListener("install", (e) => {
  e.waitUntil((async () => {
    const { version, files } = await (await fetch(SCOPE + "precache.json", { cache: "no-store" })).json();
    await (await caches.open("shell-" + version)).addAll(files);
    // Recorded for activate: a worker can be stopped between the two events, so nothing
    // may be carried across them in memory.
    await (await caches.open("shell-meta")).put("version", new Response(version));
  })());
});

self.addEventListener("activate", (e) => {
  e.waitUntil((async () => {
    const mine = "shell-" + (await currentVersion());
    const old = (await caches.keys()).filter((k) => k.startsWith("shell-") && k !== "shell-meta" && k !== mine);
    await Promise.all(old.map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener("message", (e) => { if (e.data === "skip-waiting") self.skipWaiting(); });

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET" || !req.url.startsWith(SCOPE)) return;
  if (req.mode === "navigate") {
    e.respondWith(fetch(req).catch(async () => (await caches.match(SCOPE + "index.html")) ?? Response.error()));
    return;
  }
  if (new URL(req.url).pathname.includes("/assets/")) {
    e.respondWith(caches.match(req).then((hit) => hit ?? fetch(req)));
  }
});
```

```json
// web/public/manifest.webmanifest
{ "name": "Vendor App", "short_name": "Vendor", "start_url": "/vendor-app/bill", "scope": "/vendor-app/",
  "display": "standalone", "background_color": "#ffffff", "theme_color": "#059669",
  "icons": [{ "src": "icon-192.png", "sizes": "192x192", "type": "image/png" },
            { "src": "icon-512.png", "sizes": "512x512", "type": "image/png" }] }
```
`index.html`: `<link rel="manifest" href="/vendor-app/manifest.webmanifest">` and `<meta name="theme-color" content="#059669">`. Icons: plain emerald squares with a white "V" — generate once with a short node script using no dependencies (write a minimal PNG), or ask the owner for a logo; either is acceptable, record which in the commit.

`main.tsx` (append):
```ts
if (import.meta.env.PROD && "serviceWorker" in navigator) {
  void navigator.serviceWorker.register(import.meta.env.BASE_URL + "sw.js").then((reg) => {
    reg.addEventListener("updatefound", () => {
      const w = reg.installing;
      w?.addEventListener("statechange", () => {
        if (w.state === "installed" && navigator.serviceWorker.controller) {
          window.dispatchEvent(new CustomEvent("app-update-ready", { detail: reg }));
        }
      });
    });
  });
}
```
Add `"app": { "updateReady": "A new version is ready.", "reload": "Reload" }` to all three locales.

- [ ] **Step 4: Run** `cd web && npx vitest run && npm run build`. Expected: tests PASS; `web/dist/precache.json` exists and lists `index.html` and every file in `dist/assets`.

- [ ] **Step 5: Commit**
```bash
git add web
git commit -m "feat(web): installable app shell that opens offline

Navigations are network-first with a cached index.html fallback rather than
cache-first: GitHub Pages serves fresh HTML, and a cached page could point at
hashed assets a newer deploy removed."
```

---

### Task 10: README, whole-branch verification

**Files:**
- Modify: `README.md`

- [ ] **Step 1:** Add an "Offline billing" section: what works offline (Bill for every role, outbox), what does not (everything else, creating customers, printing), how sync issues are settled, the 7-day clamp, closed-day rebooking, the smoke test from the spec's Testing section, and that 0024 must be applied before the web deploy.
- [ ] **Step 2: Run** repo root `npm test` and `cd web && npx vitest run && npm run build`. Expected: all pass; record counts in the commit.
- [ ] **Step 3: Commit**
```bash
git add README.md
git commit -m "docs: offline billing in the README"
```
