# Purchase cost, stock intake, wastage and margin — design

**Date:** 2026-09-18. **Status:** approved in brainstorm, awaiting spec review.
**Slice:** D of the daily-use roadmap; first of the four complex slices
(cost/margin → void/returns → non-kg units → offline).

## Problem

The dashboard shows revenue, not profit. Purchase cost exists nowhere in the
schema, and stock is a number the admin edits by hand, so intake and wastage
leave no record. The owner runs the shop on margin and cannot see it.

## Decisions taken with the owner

| Question | Decision |
|---|---|
| Cost basis when an item was bought at two prices | **Latest purchase price**, snapshotted onto the bill line at completion. No averaging, no lots. |
| Who logs purchases and wastage | **Admin and recorder.** Biller cannot. |
| Do movements move stock | **Yes.** Purchase adds to `stock_kg`, wastage subtracts. Admin's manual stock edit stays as a correction tool. |
| Where margin appears | **Payments card** (cost and profit rows) and a **margin column on most-sold**. No new dashboard page. |

## Approach

A `stock_movements` ledger plus a cost snapshot on each sold line. Cost is
captured when the biller completes the bill and never recomputed, so
historical profit does not shift when tomorrow's mandi price changes, and a
future void reverses a stored number rather than a lookup.

Rejected: computing cost at query time (retroactive drift, lateral join in
every dashboard query) and per-lot FIFO (owner chose latest price).

## Data model — migration `0016_stock_movements.sql`

### New table `stock_movements`

| column | type | notes |
|---|---|---|
| id | uuid pk | `gen_random_uuid()` |
| vendor_id | uuid not null → vendors | denormalised for plain-column RLS, as every tenant table |
| item_id | uuid not null → items | |
| kind | text not null | check in (`purchase`, `wastage`) |
| qty_kg | numeric(10,2) not null | check `> 0` |
| unit_cost | numeric(10,2) | check: not null and `>= 0` when kind = `purchase`; null when `wastage` |
| note | text not null default '' | free text, e.g. mandi name or "rotten" |
| created_by | uuid not null → app_users | the staff member who logged it |
| created_at | timestamptz not null default now() | |

Index on `(vendor_id, created_at)` for the date-ranged list, and on
`(vendor_id, item_id)`.

**RLS.** `stock_movements_read`: select for `authenticated` where
`vendor_id = current_vendor_id()`. **No insert, update or delete policy for
any client role.** All writes go through `log_stock_movement()`, because the
row and the stock change must be one transaction. Corrections are made by
logging an opposite movement, never by editing history.

### `items.last_cost`

`numeric(10,2)` nullable, check `>= 0`. Set by `log_stock_movement()` on every
purchase. **Null means never purchased**, and the UI shows margin as unknown
for such lines. It is never treated as zero.

`items_admin_write` already lets admin update any items column; that is
acceptable for `last_cost` (an admin correcting a mistyped cost) and
consistent with the manual `stock_kg` edit.

### `bill_items.unit_cost`

`numeric(10,2)` nullable, check `>= 0`. Stamped by `complete_bill()` from
`items.last_cost` at the moment of completion. Bills completed before 0016
keep null and are reported as uncosted.

## Functions

### `log_stock_movement(p_item_id uuid, p_kind text, p_qty_kg numeric, p_unit_cost numeric, p_note text) returns stock_movements`

`security definer`, `set search_path = public`, granted to `authenticated`
and `service_role`, revoked from `public` and `anon`.

Rules, in order:
1. Caller role must be `admin` or `recorder` (via the existing role helper
   pattern used by `issue_token`); otherwise raise `42501`.
2. Item must belong to `current_vendor_id()`; otherwise raise `42501`
   (same code as a cross-tenant write anywhere else, so `assertDenied` applies).
3. Argument checks mirror the table constraints so the error is raised with a
   clear message before the insert.
4. Lock the item row (`select … for update`).
5. `wastage` larger than current `stock_kg` raises with sqlstate `P0001`,
   message `wastage exceeds stock`. Stock never goes negative here.
6. Insert the movement with `created_by = auth.uid()`.
7. `purchase`: `stock_kg += qty`, `last_cost = p_unit_cost`.
   `wastage`: `stock_kg -= qty`.
8. Return the inserted row.

No idempotency key. There is no token or payment involved, a double tap
shows as two visible rows, and the correction is a wastage row.

### `complete_bill()` — one addition

Before the existing stock decrement, stamp cost on the lines:

```sql
update bill_items bi
   set unit_cost = i.last_cost
  from items i
 where bi.bill_id = p_bill_id and i.id = bi.item_id;
```

Everything else in `complete_bill` is unchanged, including idempotency: a
retry finds the bill already `done` and returns before this update.

### Analytics — replace two functions, add one

`collected_between(p_from, p_to)` now returns
`(total, bill_count, cost, profit, uncosted_lines bigint)`.
`cost = sum(qty_kg * unit_cost)` over lines with non-null cost;
`profit = total - cost`; `uncosted_lines` counts done-bill lines in range with
null cost so the UI can say how much of the profit figure is missing cost.

`top_items_between(p_from, p_to)` adds `total_cost numeric` (null if every
line for that item is uncosted), `margin numeric` (`total_revenue -
total_cost`, null when cost is null) and `uncosted_lines bigint`.
Return type change means `drop function` then `create`, and the grants are
re-issued, following the pattern 0013 used for `bought_together_between`.

`stock_movements_between(p_from, p_to)` returns the movements in range with
the item's three names, newest first, for the `/stock` list. `stable`,
plain `language sql` so RLS applies to the caller.

## UI (web)

### New screen `/stock` — admin and recorder

Added to `BY_ROLE` for both roles with `nav.stock`. Layout follows the
requests screen: form on top, date-ranged list below using the existing
`dateRange` control.

Form fields: item (select of active items, searchable by name in the current
UI language), kind toggle (Purchase / Wastage), kg, cost per kg (shown only
for Purchase, required), note (optional). Submit calls
`log_stock_movement` via `supabase.rpc`. Validation lives in a pure
`stockRules.ts` module, tested like `adminRules.ts`:
kg > 0 with two decimals, cost >= 0 required for purchase, item chosen.
A `wastage exceeds stock` error from the server maps to a translated message
naming the current stock.

List columns: time, item, kind, kg (signed: `+` purchase, `-` wastage),
cost/kg, note, who.

### Dashboards

Payments card gains two rows under total: **Cost** and **Profit**. When
`uncosted_lines > 0` a one-line note reads "N lines have no purchase cost".
Most-sold table gains a **Margin** column; a dash when null.

### Items admin

`last_cost` shown read-only beside price, with a dash when null. Not editable
here in this slice; a purchase movement is the way to set it.

### i18n

New keys in `en`, `hi`, `mr` for nav, form labels, kind names, the error, the
uncosted note and the dashboard rows. AI-written like the existing 220 and
flagged for the same native review.

## Money and rounding

`unit_cost` and `qty_kg` are `numeric(10,2)`; the products are summed in SQL
and returned as `numeric`. The web formats them with the existing `money.ts`
helpers. The client never computes cost or profit itself, so the known paisa
mismatch in line totals does not get a second instance here.

## Testing

DB suite (`tests/`):
- RLS: vendor A sees none of vendor B's movements; no role can insert, update
  or delete directly; anon sees nothing.
- `log_stock_movement`: biller refused (42501); cross-vendor item refused
  (42501); purchase adds stock and sets `last_cost`; second purchase
  overwrites `last_cost`; wastage subtracts; wastage over stock refused and
  leaves stock and the table untouched; `created_by` is the caller.
- `complete_bill`: stamps `unit_cost` from `last_cost`; null when never
  purchased; a purchase logged after completion does not change the stamped
  line; retry does not restamp.
- `collected_between`: cost, profit and `uncosted_lines` correct with a mix
  of costed and uncosted lines; zero-row range returns zeros.
- `top_items_between`: margin per item, null margin for an all-uncosted item,
  existing ordering unchanged.
- `stock_movements_between`: date bounds, three names, no cross-vendor leak.

Web suite: `stockRules` validation table, signed kg formatting, margin dash
for null, routes include `/stock` for admin and recorder and exclude biller.

## Deployment

Same order as every prior slice: migration applied to Cloud by hand (the
`supabase db push` 401), then `git push`, then CI. No Edge Function change.

## Out of scope

Editing or deleting a movement; supplier records; per-lot tracking; cost
history per item beyond the ledger rows; reversing cost on void (that is the
next slice and will reverse the stored `unit_cost`).
