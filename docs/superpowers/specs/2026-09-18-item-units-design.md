# Items sold by piece, bunch or dozen — design

**Date:** 2026-09-18. **Status:** approved in brainstorm, awaiting spec review.
**Slice:** third of the four complex slices (cost/margin → void → **units** → offline).

## Problem

Every quantity in the app is a weight in kg. Coconuts, lemons, coriander bunches and
bananas by the dozen are sold as fake weights ("0.1 kg"), which makes stock, receipts,
most-sold and margin wrong for those items and confuses staff.

## Decisions taken with the owner

| Question | Decision |
|---|---|
| Units | **kg, piece, bunch, dozen.** Fixed list. |
| Units per item | **One.** A product sold two ways is two items. |
| Fractions | **Whole numbers only** for piece, bunch, dozen. kg keeps two decimals. |
| Most-sold ranking | **By sales value in rupees.** Quantity still shown per row in its unit. |

Decision taken in design (owner to confirm with the spec): the low-stock threshold moves
from a fixed 10 to a **per-item `low_stock_at`, default 10**. A fixed 10 makes no sense
across units (10 dozen bananas is not low). Requirement #9's "less than 10 kg" is kept
as the default for every existing item.

## Approach

Add `items.unit` and keep every existing quantity column name. `stock_kg`, `qty_kg`
and friends now mean "quantity in the item's unit"; a column comment says so. Renaming
them would mean recreating every function from 0003 to 0017 and touching nearly every
web file for no behavioural gain. The ugliness is the historical name, and it is
documented rather than hidden.

## Data model — migration `0018_item_units.sql`

- `items.unit text not null default 'kg' check (unit in ('kg','piece','bunch','dozen'))`.
- `items.low_stock_at numeric(10,2) not null default 10 check (low_stock_at >= 0)`.
- `comment on column` for `items.stock_kg`, `bill_items.qty_kg`, `stock_movements.qty_kg`:
  "Quantity in the item's unit (items.unit). The _kg suffix is historical."
- **Trigger `items_unit_rules` before insert or update on `items`:**
  - if `unit <> 'kg'` and `stock_kg <> floor(stock_kg)` → raise `22023`
    `stock must be a whole number for this unit`;
  - on update, if `unit` changes and any `bill_items` row references the item → raise
    `P0001` `unit is locked once the item has been sold`. (Unsold items may change unit.)
- **`v_low_stock`** recreated: `stock_kg < low_stock_at` instead of `< 10`; also returns
  `unit` and `low_stock_at`. `v_in_stock` recreated to add `unit`.

## Functions

- New helper `assert_whole_qty(p_item_id uuid, p_qty numeric)` (`stable`, invoker):
  raises `22023` `quantity must be a whole number for this unit` when the item's unit is
  not kg and `p_qty <> floor(p_qty)`.
- `replace_bill_lines` (same signature as 0015, `create or replace`): before the insert,
  loop the input lines and call `assert_whole_qty`. Everything else verbatim.
- `log_stock_movement` (same signature as 0016, `create or replace`): after the item
  lock, call `assert_whole_qty(v_item.id, v_qty)`. Everything else verbatim, including
  the fix-wave changes (vendor-filtered lock, `detail` on over-stock).
- `top_items_between`: drop/create; adds `unit text`; `order by sum(line_total) desc,
  item_id`. Columns otherwise unchanged (0016's cost/margin columns stay).
- `stock_movements_between`: drop/create; adds `unit text`.
- `complete_bill`, `void_bill`, `issue_token`, `collected_between`, `bought_together_between`
  are untouched: they never interpret the unit.

## Web

### Units module `web/src/units.ts`

- `type Unit = "kg" | "piece" | "bunch" | "dozen"`, `UNITS` list.
- `isWholeUnit(unit)` → true for all but kg.
- `validateQty(raw, unit)`: kg → today's `validateWeight` rules; others → plain digits
  only, > 0, no decimals (reason `notWhole`).
- `qtyText(qty, unit, t)` → `t("unit.qty.<unit>", { n })`, e.g. "1.5 kg", "3 pcs",
  "2 bunches", "1 dozen".
- `perUnit(unit, t)` → `t("unit.per.<unit>")`, e.g. "per kg", "per piece".

### Types and selects

`Item` (data.ts), `AdminItem` (admin.ts) gain `unit: Unit` and `low_stock_at: number`;
`AdminItem` also gains `sold: boolean` from a `bill_items(count)` embed, used to lock the
unit selector. `BillLine` (history.ts), `ReceiptLine` (receipt.ts) embed `items(…, unit)`.
`Movement` (stock.ts) gains `unit` from the widened function. `TopItem` gains `unit`.
`Draft` (billing.ts) gains `unit` so the basket can label lines.

### Screens

- **Items**: unit selector (four options, label per unit) and "Low-stock warning below"
  field. Selector disabled with a note when `sold` is true. Price label reads "Price
  per kg/piece/bunch/dozen" following the selected unit; stock label "Stock (kg)" /
  "Stock (pieces)" etc. Stock validation refuses decimals for non-kg. List rows show
  quantity with `qtyText` and colour low stock by the item's own `low_stock_at`.
- **Bill / ItemGrid**: for kg the decimal weight field stays. For other units a
  whole-number field with − and + buttons, labelled "Pieces" / "Bunches" / "Dozens".
  Stock text and low colouring use `qtyText` and `low_stock_at`. Basket lines use
  `qtyText`.
- **Completed**, **Receipt**, **Stock**, **Dashboards**: every "N kg" becomes
  `qtyText(n, unit)`; "Cost per kg" becomes "Cost per <unit>"; the movements list and
  receipt line format follow the unit. Dashboards' top-items subtitle becomes "By sales
  value. Shows quantity · sales · margin."
- **Low-stock bell**: unchanged; the view now honours `low_stock_at`.

### i18n

New block `unit`: `name.{kg,piece,bunch,dozen}`, `qty.{kg,piece,bunch,dozen}` with
`{{n}}` (English uses "pcs", "bunches", "dozen"), `per.{kg,piece,bunch,dozen}`,
`lockedNote` ("Unit cannot change after the item has been sold."), `notWhole` ("Whole
numbers only for this unit."). Existing keys that hardcode kg are reworded to take the
unit text or are replaced by `unit.qty.*`. hi and mr AI-written, flagged for review.

## Testing

DB: unit check and default; non-kg fractional stock refused by the trigger, whole
accepted, kg fractional accepted; unit change refused after a sale and allowed before;
`v_low_stock` uses the per-item threshold; `replace_bill_lines` and `log_stock_movement`
refuse a fractional quantity for a piece item and accept it for kg; `top_items_between`
orders by revenue and returns `unit`; `stock_movements_between` returns `unit`; every
existing test still passes (all existing items default to kg).

Web: `validateQty` per unit; `qtyText`/`perUnit` per unit and language; Items form
switches labels with the unit, refuses decimals for pieces, locks the selector when sold;
ItemGrid shows the weight field for kg and the stepper for pieces, and refuses "1.5"
pieces; Basket, Completed, Receipt, Stock, Dashboards render unit words; low colouring
follows `low_stock_at`.

## Deployment

0018 by hand on Cloud as one script, then merge and push. All existing items become kg
with threshold 10, so nothing changes for the shop until the admin edits an item.

## Out of scope

Multiple units per item; conversions; gram; changing a sold item's unit; per-unit
top-items lists.
