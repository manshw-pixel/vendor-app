# Bill editing and cost on the item form

Date: 2026-09-21
Migration: `0020_amend_bill_and_item_cost.sql`

Two changes the shop owner asked for:

1. A bill can be corrected after the recorder has finished with it — while it waits in the
   pending queue, and after it has been completed.
2. An item's cost is entered where the item is created, so cost has two entry points
   instead of one.

---

## 1. Editing a pending bill

### The problem

`replace_bill_lines` (0015, re-created in 0018) refuses any bill whose status is not
`recording`, and the refusal is deliberate: past `recording` the customer holds a token,
has been told a total, and an `outbound_messages` row quoting that total is already
queued. Rewriting the lines silently makes both of those a lie.

But a wrong basket is a real event at the counter — a recorder taps 5 where the customer
asked for 0.5, and the mistake is found while the customer is still standing there. Today
the only recourse is to complete a bill known to be wrong and then void it.

### The decision

A pending bill (`status = 'billed'`) may be amended in place. The bill **keeps its id and
its token number**, so the slip in the customer's hand stays valid. The total is
recomputed and the stale outbound message is superseded by a corrected one.

The reasons the original refusal existed are addressed rather than ignored: the lie about
the total is fixed by recomputing it, and the lie in the queued message is fixed by
replacing that message.

### `amend_pending_bill(p_bill_id uuid, p_lines jsonb)`

`security definer`, `set search_path = public`, granted to `authenticated` only.

Guards, in order — every one of them shared with `replace_bill_lines`, and each refusal
happens **before** any row is deleted, so a refused amendment leaves the bill untouched:

| Guard | Behaviour |
|---|---|
| Bill exists | `select … for update`; not found → raise |
| Vendor | non-null `current_vendor_id()` must equal `v_bill.vendor_id` |
| Role | non-null session must be `admin` or `recorder` — the same pair `replace_bill_lines` accepts. A biller does not rewrite baskets. |
| Status | must be `billed`. `recording` is **not** accepted here; that path keeps using `replace_bill_lines` unchanged. `done` and `voided` are refused. |
| Non-empty | `jsonb_typeof = 'array'` and length > 0, refused rather than treated as "clear the bill" |
| Whole quantities | `assert_whole_qty(item_id, qty_kg)` per line, for piece/bunch/dozen items |

Then, in the same transaction:

1. `delete from bill_items where bill_id = p_bill_id`
2. Re-insert from `jsonb_to_recordset`, with `line_total` **computed** as
   `round(qty_kg * unit_price, 2)` — never taken from the caller, for the same reason
   `replace_bill_lines` computes it. `unit_price` is the caller's, so an admin editing a
   price mid-bill cannot change a basket already on screen.
3. Recompute `bills.total` from the stored `line_total`s, exactly as `issue_token` does.
4. Supersede the queued outbound message. `outbound_messages` (0001) has no link back to
   a bill — `issue_token` writes only `{token_no, total}` into the payload — so 0020 adds
   one:

   ```sql
   alter table outbound_messages
     add column bill_id uuid references bills(id) on delete cascade;
   create index outbound_bill_idx on outbound_messages(bill_id) where status = 'pending';
   ```

   Nullable: rows written before 0020, and any future message not about a bill, have no
   bill. `issue_token` is re-created to set it.

   Superseding is then a **delete of the still-`pending` rows for this bill**, not a new
   status value: the row was never sent, so there is no history in it to keep, and a
   delete needs no change to the `status` check constraint or to the sender's
   `outbound_pending_idx` scan. A row already `sent` or `failed` is left untouched — it
   is history, and the corrected message follows it.

   A corrected message is then queued with template key `token_amended` and payload
   `{token_no, total}` at the new total. The sender treats it as any other pending row;
   the template is drafted alongside the existing ones (see the WhatsApp notes — the BSP
   hop is still on hold, which does not block this work, because queuing is all that
   happens here).
5. Stamp `amended_at = now()` and `amended_by = auth.uid()`.

Idempotent by construction, like `replace_bill_lines`: delete-then-insert with the same
basket produces identical rows however many times a retry runs.

### Schema

```sql
alter table bills
  add column amended_at timestamptz,
  add column amended_by uuid references app_users(id);   -- no ON DELETE, as voided_by
```

Nullable, no check constraint tying them to a status: a bill can be amended and then
completed, and the stamps must survive that transition.

### The screen

`Pending.tsx` gains an **Edit** action per row, beside the existing Complete action. It
opens the basket editor from `Bill.tsx`, pre-filled from `billLines(billId)`, and saves
through a new `amendPendingBill(billId, lines)` in `data.ts`.

The editor shows the **old total and the new total side by side** before saving. The
customer was told a number; the biller has to be able to read them the corrected one.

Roles: the Edit action is rendered for `admin` and `recorder` only, mirroring the RPC.
The server gate is authoritative; hiding the button is courtesy.

---

## 2. Editing a completed bill

### The decision

Void and rebuild. No new SQL.

A `done` bill's effects have already landed — stock deducted, loyalty points awarded, a
receipt on record, the day's figures moved. `void_bill` (0017) already reverses every one
of those, transactionally, with a mandatory reason and an audit stamp. Rewriting a `done`
bill in place would mean re-deriving each of those deltas by hand, and would leave any
printed receipt wrong with nothing on record to say so.

So "edit a completed bill" is defined as: **void the original, create a corrected
replacement.** Two bills stay on record — the voided one and the new one — which is what
the books should show anyway.

### The flow

`Completed.tsx`'s row gains an **Edit** action next to Void:

1. Prompt for a reason. `void_bill` requires one, and the same reason describes the
   correction.
2. Call the existing `voidBill(id, reason)`. Stock is restored, points reversed, status
   set to `voided`.
3. Open a **new** bill pre-filled with the voided bill's lines and customer, for the
   recorder to correct and re-issue.

### Consequences, stated plainly

- The customer's original token is dead; the replacement bill issues a **new** token and
  the customer must be handed a new number. This is the cost of keeping the ledger honest
  and is accepted.
- The Edit action is shown under exactly the conditions Void is shown under today,
  including `void_bill`'s **same calendar day (Asia/Kolkata)** window. Outside that
  window a completed bill cannot be edited, because it cannot be voided — the owner has
  already reconciled that day against the drawer.
- If the void succeeds but the operator abandons the rebuild, the result is a voided bill
  and no replacement. That is a legitimate end state (the sale did not happen), not a
  half-finished edit, so no compensation is needed.

---

## 3. Cost on the item form

### The problem

`items.last_cost` is written in exactly one place: `log_stock_movement` with
`kind = 'purchase'` (0016, re-created in 0018), reached from the Stock screen. An item
created through the Items form therefore starts life uncosted, and every sale of it until
the first purchase entry lands in `top_items_between`'s `uncosted_lines` with no margin.

### The decision

The Items add/edit form carries a **cost** field, giving cost two entry points. Entering
a cost on **create**, with opening stock above zero, also logs a purchase movement, so
that opening stock is costed in margin analytics rather than being invisible inventory.

### `create_item_with_cost(...)`

`createItem`'s plain insert is replaced by an RPC so the insert and the movement are one
transaction — an item created without its costing movement would be a silent gap in the
analytics.

```
create_item_with_cost(
  p_names jsonb,        -- name_en / name_hi / name_mr
  p_price numeric,
  p_stock numeric,      -- opening stock, in the item's unit
  p_unit text,
  p_low_stock_at numeric,
  p_cost numeric
) returns items
```

Guards: signed-in `admin` only (item creation is already admin-gated); `p_cost` not null
and `>= 0`; `p_unit` in the 0018 set; `p_stock >= 0`.

Body:

1. Insert the item **with `stock_kg = 0`** and the given price, unit and threshold. The
   0018 `items_unit_rules` trigger applies as normal.
2. If `p_stock > 0`, call `log_stock_movement(new_item_id, 'purchase', p_stock, p_cost)`.
   That function raises `stock_kg` by `p_stock` and sets `last_cost = p_cost`, so the
   item lands at the intended opening stock with exactly **one** movement row and **no
   double count**. Its own `assert_whole_qty` enforces whole numbers for
   piece/bunch/dozen.
3. If `p_stock = 0`, no movement row is written — there is no purchase to record — and
   `last_cost` is set directly on the insert so the cost is still on file.

Returns the item row.

### Editing an existing item

`updateItem` is **unchanged in kind**: changing the cost on an existing item sets
`last_cost` and logs nothing. A movement row there would invent a delivery that never
arrived and would inflate purchase figures every time an admin fixed a typo. Adding stock
to an existing item remains the Stock screen's job, and that is the screen that records
what it cost.

### Validation and labelling

`adminRules.ts`: `ItemInput` gains `cost: string`; `ItemValue` gains `cost: number | null`.
`validateItem` takes a `mode: "create" | "edit"` argument —

- **create**: cost is required and must be a non-negative number → `items.badCost` /
  `items.costRequired`
- **edit**: blank is allowed and means "leave the cost alone"; a present value must be
  non-negative

`Items.tsx`: the cost input sits between price and stock, labelled with the existing
`perUnit(unit, t)` helper from `units.ts` — the same helper the price label already uses —
so it reads "Cost per kg", "Cost per piece", "Cost per dozen" and follows the unit
selector live. New i18n keys `items.cost`, `items.badCost`, `items.costRequired` in
`en.json`, `hi.json`, `mr.json`.

Accepted cost of this change: the fastest-used form gains a required field. Existing
uncosted items are untouched, and their cost stays optional when edited.

---

## Testing

Database tests, alongside the existing suite (`npm test` at the repo root):

**`amend_pending_bill`**
- amends a `billed` bill: lines replaced, `bills.total` recomputed, token unchanged
- `amended_at` / `amended_by` stamped
- the pending outbound message is deleted and a `token_amended` one queued at the new
  total; an already-`sent` or `failed` row is left in place
- `issue_token` now stamps `bill_id` on the row it queues
- refused on `recording`, `done` and `voided`
- refused for a biller; refused for another vendor's bill
- refused on an empty basket, and the existing lines survive the refusal
- refused on a fractional quantity for a piece item, and the existing lines survive
- `line_total` is computed, not accepted from the caller
- called twice with the same basket, the rows are identical

**`create_item_with_cost`**
- opening stock > 0 → exactly one purchase movement at that cost; `stock_kg` equals the
  opening stock (not double); `last_cost` set
- opening stock = 0 → no movement row; `last_cost` still set
- null or negative cost refused
- fractional opening stock for a piece item refused, and no item row is left behind
- a non-admin is refused

**`updateItem` path**
- changing an existing item's cost writes no movement row

Web tests:
- the Edit action appears on a pending row for admin and recorder, not for a biller
- the pending editor shows old and new totals
- the Edit action on a completed row is shown exactly where Void is, and voids before
  opening the replacement
- cost is required when adding an item and optional when editing one
- the cost label tracks the unit selector

## Out of scope

- Editing a `recording` bill — already works through `replace_bill_lines`.
- Editing a completed bill outside the void window.
- Any change to how the Stock screen records purchases.
