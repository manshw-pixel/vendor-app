# Pending reprice, item search, delete pending token — design

Date: 2026-09-27. Migration: `0025_pending_reprice_and_delete.sql`.

## Decisions (owner-confirmed)

- Token revert: roll the counter back only when the deleted bill held the latest token; older deletions leave a gap.
- Delete permission: admin and biller (same as void).
- Reprice: overwrite every pending line of the item, including hand-edited prices.

## 1. Price updates reach pending bills

- Trigger `items_reprice_pending` — `AFTER UPDATE OF price ON items`, fires when `new.price is distinct from old.price`.
- Updates `bill_items` of that item whose bill has status `recording` or `billed`: `unit_price = new.price`, `line_total = round(qty_kg * new.price, 2)`.
- Recomputes `bills.total = sum(line_total)` for affected bills with status `billed` (recording bills get their total at `issue_token`).
- `done`, `voided` bills and offline-queued client drafts are untouched.
- Cost: no change. `complete_bill` already stamps `items.last_cost` onto lines at completion (0016), so pending bills get the latest cost.
- Trigger function is `security definer` so it can write rows regardless of the editor's RLS; it only touches rows of `new.vendor_id`.

## 2. Item search while billing

- Search input above `ItemGrid`, used by `Bill.tsx` and `AmendBill.tsx`.
- Case-insensitive substring match against the item's en/hi/mr names; empty query shows all items.
- Pure filter function in its own module, unit-tested. New i18n keys in en/hi/mr (`bill.search`, `bill.noMatch`).

## 3. Delete a pending token

- `delete_pending_bill(p_bill_id uuid) returns void`, `security definer`.
- Refuses unless `current_vendor_id()` is non-null and role is `admin` or `biller` (errcode 42501); bill must belong to caller's shop (42501); status must be `recording` or `billed` (errcode 22023 otherwise).
- Locks `vendor_counters` row for the shop (`for update`) before touching the bill, the same lock `issue_token` takes, so a concurrent token issue cannot interleave.
- Deletes `outbound_messages` rows with `template_key = 'token_issued'`, same vendor, `payload->>'token_no'` = this token, status `pending` only, then deletes the bill (bill_items cascade).
- If `token_no = last_token`, sets `last_token = coalesce(max(token_no) of remaining bills in shop, 0)`.
- No stock or points effects: neither moves before completion.
- UI: Delete button per row on `Pending.tsx`, with a confirm; refreshes the list after.
- Grant execute to `authenticated`; revoke from public, anon.

## Testing

- DB: reprice updates recording + billed lines and billed totals; done/voided untouched; other vendor untouched; unchanged price is a no-op.
- DB: delete roles (recorder refused), cross-shop refused, done bill refused, latest-token rollback, older-token gap, two consecutive deletes roll back correctly, pending notification removed.
- Web: search filter unit tests; Pending delete confirm test.

## Rollout

Apply 0025 by hand (CLI 401s), insert tracking row, then push; CI + Pages.
