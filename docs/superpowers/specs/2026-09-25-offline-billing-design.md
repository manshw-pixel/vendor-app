# Offline billing — design

Date: 2026-09-25. Status: approved in brainstorming, awaiting spec review.

## Goal

A shop with no internet must keep selling. Today the app shows an offline banner and
blocks billing, because tokens are issued server-side (`issue_token`, 0003). After this
slice the counter can record complete sales offline; they sync automatically when the
connection returns, and anything that cannot be applied as recorded is surfaced to the
owner rather than lost.

Assumed outages: minutes to a few hours. Cache is considered stale after 24 h (warning
only; billing still works).

## Decisions (from the owner)

1. Offline = **keep billing** (not read-only, not just installable).
2. Offline bills **skip the token**: recorded as already complete (sold + paid), get a
   real token on sync. No pending-token flow offline.
3. **Everything is allowed offline** — cash/UPI/card/credit, points redemption, due
   collection — validated on sync.
4. On sync conflict: **record the sale, drop/cap the failed part, flag it** in a Sync
   issues list for the owner. Money that changed hands is never lost.

## Counter experience

- Offline, the Bill screen works against the cached catalogue, customers, points
  balances and dues. A header chip shows "Offline · N bills waiting" (also shown online
  while the queue is non-empty).
- An offline bill completes immediately. The slip prints `Offline #n` (per-device
  sequence) instead of a token, and marks points and due figures as provisional.
- On reconnect the queue syncs automatically, oldest first, one bill at a time. Synced
  bills appear in History at the time they were made (`occurred_at`), with their real
  token.
- Offline, only **Bill** and the **queue view** are usable. History, Dues, Day close and
  admin screens show "needs connection".
- Queue view lists waiting bills and any marked "needs attention" (server rejected),
  with a manual "Retry now".
- Owner-only **Sync issues** list: each open issue shows what happened and the amount,
  with actions **Add as due** (where a customer exists) and **Dismiss**.

## Server — migration 0024

### Schema

- `bills.client_id uuid unique` (nullable; set only for offline bills).
- `bills.occurred_at timestamptz` (nullable; the device's time for offline bills).
- `sync_issues(id uuid pk, vendor_id, bill_id, kind text, amount numeric(12,2),
  detail jsonb, status text check in ('open','added_as_due','dismissed') default 'open',
  resolved_by, resolved_at, created_at)`.
  `kind` ∈ `redeem_shortfall`, `due_overcollected`, `rebooked_closed_day`,
  `time_clamped`. RLS: read by the tenant's admin only; writes only via functions.

### `record_offline_bill(p_client_id uuid, p_bill jsonb) returns jsonb`

`security definer`, same tenant/role guard as `complete_bill` (admin or biller).
Payload: `lines[] {item_id, qty_kg, unit_price}`, `customer_id?`, `payment_mode`,
`redeem_points?`, `collect_due?`, `occurred_at`, `device_label`.
Returns `{bill_id, token_no, issues: [...]}`.

One transaction:

1. **Idempotency.** If a bill with `client_id = p_client_id` exists in this vendor,
   return it (and its issues) unchanged. Resending is always safe.
2. **Time.** `occurred_at` is clamped to `[now() - 7 days, now()]`; clamping raises a
   `time_clamped` issue.
3. **Closed day.** If `occurred_at`'s business date is closed, the bill is booked to the
   current business date (its original time kept in `occurred_at`) and a
   `rebooked_closed_day` issue is raised. A closed day's signed-off cash is never
   changed.
4. **Bill.** Create the bill, insert lines at the payload's `unit_price` (what the
   customer actually paid; line totals computed server-side as in 0015), assign a real
   token, complete with the payment mode, move stock and award points exactly as
   `complete_bill` does. **No customer notification** — the customer has already left.
5. **Redemption.** Redeem `min(requested, available balance)`. Any shortfall raises
   `redeem_shortfall` with its rupee value.
6. **Due collection.** Collect `min(requested, current due)` using 0023's FIFO. Excess
   raises `due_overcollected` with the amount.
7. **Credit** applies as online (needs a customer; the client enforces this offline too).
8. **Missing item or customer.** A referenced row that still exists (even if inactive)
   is used. A row that no longer exists rejects the whole call with a clear error; the
   client marks the bill "needs attention".

The completion, stock and points logic currently inside `complete_bill` is extracted
into internal helper(s) that both `complete_bill` and `record_offline_bill` call, so the
two paths cannot drift. `complete_bill`'s external behaviour is unchanged.

### Sync issue functions

- `open_sync_issues()` — admin-only list for the tenant.
- `resolve_sync_issue(p_id uuid, p_action text)` — admin-only; `add_as_due` writes a
  dues entry for the bill's customer (refused when the bill has no customer) and sets
  status `added_as_due`; `dismiss` sets `dismissed`. Resolving twice is refused.

## Client

### App shell (PWA)

- Hand-written `web/public/sw.js` (no plugin, no new dependency): precaches
  `index.html` and the hashed `/vendor-app/assets/*` listed in Vite's build manifest.
  Navigations: cache-first with `index.html` fallback (BrowserRouter routes work
  offline). Hashed assets: cache-first. Supabase requests: never intercepted.
- A new deploy shows "New version — tap to reload"; never auto-reloads mid-sale.
- `manifest.webmanifest` for installability.

### Data cache

- One IndexedDB database via a small in-repo wrapper (no `idb` package): active items
  with prices and units, customers, per-customer points balance and due, shop details
  for the slip, and a `cached_at` stamp.
- Refreshed on every online load and on window focus when online. Older than 24 h →
  warning chip.
- A `catalogue` module is the Bill screen's only data source: Supabase online, cache
  offline.

### Queue

- IndexedDB store keyed by `client_id` (UUID generated on device), scoped per vendor —
  a different vendor signing in never sends another shop's bills. Survives sign-out.
- Device sequence for `Offline #n` stored alongside.
- Sender: oldest first, one at a time. Network error → exponential backoff retry.
  Server rejection → mark "needs attention", continue with the next bill. Triggered on
  `online`, on focus, on app start, and by "Retry now".
- Before sending, the Supabase session is refreshed; if it cannot be, the user signs in
  again and the queue waits.

### Offline detection

Keep the existing rule: `navigator.onLine === false` is trusted. Additionally, any
failed Supabase call during a bill moves that bill to the offline path, so patchy signal
never strands a sale.

## Out of scope

Editing, amending or voiding bills offline; the pending-token flow offline; sharing a
queue across devices; background sync while the app is closed (it syncs on next open or
focus); offline customer creation.

## Testing

- **DB suite:** idempotent resend; each issue kind (redeem shortfall, due overcollected,
  closed-day rebooking, time clamp); missing item rejects; no notification enqueued;
  `complete_bill` behaviour unchanged after the helper extraction; resolve add-as-due /
  dismiss / double-resolve / no-customer refusal; tenant and role guards.
- **Vitest:** queue ordering, backoff, needs-attention, per-vendor scoping; catalogue
  online/offline fallback; offline Bill flow end to end with a mocked RPC; slip prints
  `Offline #n`.
- **Manual after deploy:** DevTools → Offline → reload → bill (cash, credit, redeem,
  collect due) → reconnect → verify History, tokens, Sync issues.

## Deploy order

As before: apply 0024 in the SQL editor (+ `schema_migrations` row) → merge → Pages
deploy. The old client keeps working against 0024 (additive schema).
