# Bill Editing and Item Cost Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let staff correct a bill after the recorder has finished with it — in place while it is pending, and by void-and-rebuild once it is completed — and let an item's cost be entered on the Items form as well as on the Stock screen.

**Architecture:** One migration, `0020_amend_bill_and_item_cost.sql`, adds `amend_pending_bill` (a status-`billed` sibling of `replace_bill_lines`), `create_item_with_cost`, a `bill_id` column on `outbound_messages`, and amendment stamps on `bills`. The web side adds one new screen (`AmendBill.tsx`, reusing the already-extracted `ItemGrid` and `Basket` components), an Edit action on the pending queue, and an Edit action on the completed list that calls the existing `voidBill` before opening a pre-filled new bill. Editing a completed bill writes no new SQL at all — `void_bill` (0017) already reverses stock, points and status.

**Tech Stack:** PostgreSQL (plpgsql, `security definer` RPCs), Supabase (PostgREST + RLS), React 18 + TypeScript + Vite, Tailwind, i18next (en/hi/mr), Vitest + Testing Library for web, a bespoke node runner (`tests/run.mjs`) against a real local PostgreSQL for the database.

**Spec:** `docs/superpowers/specs/2026-09-21-bill-edit-and-item-cost-design.md`

## Global Constraints

- **Migration file:** everything database-side goes in one new file, `supabase/migrations/0020_amend_bill_and_item_cost.sql`. Never edit an already-applied migration (0001–0019).
- **Do not deploy.** This plan ends at "committed and pushed with CI green". Applying 0020 to Supabase Cloud is a separate, manual step by the owner (`supabase db push` 401s from this machine; migrations have been hand-applied through the dashboard SQL editor).
- **RPC parameter names are the API.** PostgREST resolves overloads by argument name. Every `supabase.rpc(...)` call's keys must match the SQL parameter names exactly, `p_`-prefixed.
- **Every new function:** `language plpgsql security definer set search_path = public`, followed by `revoke all on function … from public, anon;` and `grant execute on function … to authenticated;`. This is the pattern in 0015/0016/0017/0018 without exception.
- **Money rounding:** `round(x, 2)` in SQL, `Math.round(x * 100) / 100` in TypeScript (`paise()` in `web/src/billing.ts`). The two must agree.
- **Never accept `line_total` from a client.** Compute it as `round(qty_kg * unit_price, 2)`.
- **i18n:** every new user-visible string needs a key in all three of `web/src/i18n/en.json`, `hi.json`, `mr.json`. hi/mr are AI-written and unreviewed; match the existing tone and keep the Marathi terminator style used by neighbouring keys.
- **Role vocabulary:** `admin`, `recorder`, `biller` (plus the platform owner, irrelevant here). Helper functions in SQL: `current_vendor_id()`, `current_user_role()`.
- **Test commands:** database — `npm test` at the repo root; web — `npm test` inside `web/` (`vitest run`). Type check — `npm run build` inside `web/` (runs `tsc --noEmit` first).
- **Local `tsc` clean is not CI clean.** TypeScript 7 is a per-platform native binary and CI's Linux build has rejected code Windows accepted. Push and check CI.
- **Commit trailer:** end every commit message with `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`.

---

## File Structure

**Created:**
- `supabase/migrations/0020_amend_bill_and_item_cost.sql` — all database changes for both features.
- `tests/amend_pending_bill.test.mjs` — the amendment RPC's behaviour and refusals.
- `tests/create_item_with_cost.test.mjs` — item creation with an opening purchase.
- `web/src/screens/AmendBill.tsx` — the pending-bill basket editor.
- `web/src/__tests__/AmendBill.test.tsx` — its tests.

**Modified:**
- `supabase/migrations/0003_functions.sql` — **read only**, never edited; `issue_token` is re-created inside 0020.
- `web/src/data.ts` — add `amendPendingBill`, `billDraftLines`.
- `web/src/admin.ts` — `createItem` moves to the RPC; `AdminItem` unchanged.
- `web/src/adminRules.ts` — `ItemInput.cost`, `ItemValue.cost`, `validateItem(input, mode)`.
- `web/src/screens/Items.tsx` — the cost field.
- `web/src/screens/Pending.tsx` — the Edit action.
- `web/src/screens/Completed.tsx` — the Edit action (void + rebuild).
- `web/src/screens/Bill.tsx` — accept pre-filled lines for the rebuild.
- `web/src/routes.ts` — `/amend` as an unlisted route.
- `web/src/App.tsx` — route wiring.
- `web/src/i18n/{en,hi,mr}.json` — new keys.
- `web/src/__tests__/{adminRules,admin,Items,Pending,Completed,data}.test.*` — extended.

Task order is dependency order: the database lands first (Tasks 1–3), then the client data layer that calls it (Task 4), then the screens (Tasks 5–7).

---

### Task 1: Migration scaffold — schema changes and `issue_token`

**Files:**
- Create: `supabase/migrations/0020_amend_bill_and_item_cost.sql`
- Test: `tests/amend_pending_bill.test.mjs` (created here, grown in Task 2)

**Interfaces:**
- Consumes: nothing.
- Produces: columns `bills.amended_at timestamptz`, `bills.amended_by uuid`, `outbound_messages.bill_id uuid`; `issue_token(p_bill_id uuid) returns integer` re-created to stamp `bill_id`.

- [ ] **Step 1: Write the failing test**

Create `tests/amend_pending_bill.test.mjs`:

```javascript
import { test, assert, assertEqual, once } from "./framework.mjs";
import { sql } from "./fixtures.mjs";
import { seedTwoVendors } from "./seed.mjs";

const getWorld = once(seedTwoVendors);

/** A `billed` bill in vendor `v`, built through the real functions so the outbound row
 *  and the token are exactly what production writes. */
async function billedBill(v, { qty = 2, price = 40, stockKg = 100 } = {}) {
  const { rows: [i] } = await sql(
    `insert into items (vendor_id, name_en, price, stock_kg) values ($1,'Amend Onion',$2,$3) returning id`,
    [v.vendorId, price, stockKg]);
  const { rows: [b] } = await sql(
    `insert into bills (vendor_id, customer_id, recorder_id, total, status)
     values ($1,$2,$3,0,'recording') returning id`, [v.vendorId, v.customerId, v.recorderId]);
  await sql(`insert into bill_items (bill_id, vendor_id, item_id, qty_kg, unit_price, line_total)
             values ($1,$2,$3,$4,$5,$6)`, [b.id, v.vendorId, i.id, qty, price, qty * price]);
  const { rows: [tok] } = await sql(`select issue_token($1) as token`, [b.id]);
  return { itemId: i.id, billId: b.id, token: tok.token };
}

test("issue_token stamps bill_id on the message it queues", async () => {
  const w = await getWorld();
  const x = await billedBill(w.a);
  const { rows } = await sql(
    `select bill_id, template_key from outbound_messages where bill_id = $1`, [x.billId]);
  assertEqual(rows.length, 1, "exactly one queued message for this bill");
  assertEqual(rows[0].template_key, "token_issued", "template");
});

test("bills carry nullable amendment stamps", async () => {
  const w = await getWorld();
  const x = await billedBill(w.a);
  const { rows } = await sql(
    `select amended_at, amended_by from bills where id = $1`, [x.billId]);
  assertEqual(rows[0].amended_at, null, "a fresh bill is not amended");
  assertEqual(rows[0].amended_by, null, "a fresh bill has no amender");
});

export { billedBill, getWorld };
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test`
Expected: FAIL — `column "bill_id" does not exist` / `column "amended_at" does not exist`.

- [ ] **Step 3: Write the migration scaffold**

Create `supabase/migrations/0020_amend_bill_and_item_cost.sql`:

```sql
-- Editing a bill after recording, and cost on the item form.
-- Spec: docs/superpowers/specs/2026-09-21-bill-edit-and-item-cost-design.md
--
-- Two features in one migration because they share nothing but the file. Part 1 lets a
-- pending bill be amended in place; part 2 lets an item be created with its cost, logging
-- the opening stock as a real purchase.

-- --------------------------------------------------------------------------
-- Part 1a: schema
-- --------------------------------------------------------------------------

-- Nullable, and deliberately NOT tied to a status by a check constraint the way
-- voided_at/voided_by are (0017): a bill may be amended and then completed, and the
-- stamps have to survive that transition.
alter table bills
  add column amended_at timestamptz,
  -- No ON DELETE, matching recorder_id/biller_id/voided_by: a staff member with history
  -- stays referenced.
  add column amended_by uuid references app_users(id);

comment on column bills.amended_at is 'When the basket was last rewritten after a token was issued (0020).';

-- outbound_messages (0001) has no way back to a bill: issue_token writes only
-- {token_no, total} into the payload. Amending a bill has to find the message quoting the
-- now-wrong total, so the link becomes a column.
--
-- Nullable: rows written before this migration have no bill, and neither does any future
-- message that is not about one.
alter table outbound_messages
  add column bill_id uuid references bills(id) on delete cascade;

-- Partial: the only query is "the still-pending messages for this bill".
create index outbound_bill_idx on outbound_messages(bill_id) where status = 'pending';

comment on column outbound_messages.bill_id is 'The bill this message is about, when it is about one (0020).';

-- --------------------------------------------------------------------------
-- Part 1b: issue_token, re-created to stamp bill_id.
-- Byte-for-byte 0003_functions.sql except for the insert at the end.
-- --------------------------------------------------------------------------
create or replace function issue_token(p_bill_id uuid)
  returns integer
  language plpgsql security definer set search_path = public as $$
declare
  v_bill   bills%rowtype;
  v_token  integer;
  v_total  numeric;
begin
  -- Lock the bill first so two calls on the SAME bill serialise; the status guard below
  -- then makes the second one fail rather than issue a second token.
  select * into v_bill from bills where id = p_bill_id for update;
  if not found then
    raise exception 'bill % not found', p_bill_id;
  end if;

  if current_vendor_id() is not null and current_vendor_id() <> v_bill.vendor_id then
    raise exception 'bill % does not belong to your vendor', p_bill_id;
  end if;
  if current_vendor_id() is not null and current_user_role() not in ('admin', 'recorder') then
    raise exception 'role % may not issue tokens', current_user_role();
  end if;

  if v_bill.status <> 'recording' then
    raise exception 'bill % is %, expected recording', p_bill_id, v_bill.status;
  end if;

  -- #3 (forgeable total): trust the line items, not the client-supplied total.
  select coalesce(sum(line_total), 0) into v_total from bill_items where bill_id = p_bill_id;

  update vendor_counters
     set last_token = last_token + 1
   where vendor_id = v_bill.vendor_id
  returning last_token into v_token;

  update bills
     set token_no = v_token, status = 'billed', total = v_total
   where id = p_bill_id;

  -- #13: the customer is told their token and what to pay. Queued, never sent inline.
  -- bill_id added in 0020 so amend_pending_bill can find and supersede this row.
  insert into outbound_messages (vendor_id, customer_id, bill_id, template_key, payload)
  values (v_bill.vendor_id, v_bill.customer_id, p_bill_id, 'token_issued',
          jsonb_build_object('token_no', v_token, 'total', v_total));

  return v_token;
end $$;
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test`
Expected: PASS — the two new tests plus all 142 existing ones. `issue_token`'s existing tests in `tests/issue_token.test.mjs` must still pass: the re-creation changed one insert and nothing else.

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/0020_amend_bill_and_item_cost.sql tests/amend_pending_bill.test.mjs
git commit -m "feat(db): amendment stamps and a bill link on outbound messages

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 2: `amend_pending_bill`

**Files:**
- Modify: `supabase/migrations/0020_amend_bill_and_item_cost.sql` (append part 1c)
- Test: `tests/amend_pending_bill.test.mjs` (append)

**Interfaces:**
- Consumes: `bills.amended_at` / `amended_by`, `outbound_messages.bill_id` (Task 1); `assert_whole_qty(uuid, numeric)` (0018).
- Produces: `amend_pending_bill(p_bill_id uuid, p_lines jsonb) returns void`. `p_lines` is a JSON array of `{item_id, qty_kg, unit_price}` — the same shape `replace_bill_lines` takes.

- [ ] **Step 1: Write the failing tests**

Append to `tests/amend_pending_bill.test.mjs`:

```javascript
const amendAs = (client, billId, lines) =>
  client.rpc("amend_pending_bill", { p_bill_id: billId, p_lines: lines });

const linesOf = async (billId) =>
  (await sql(`select item_id, qty_kg, unit_price, line_total from bill_items
               where bill_id = $1 order by line_total desc`, [billId])).rows;
const billRow = async (id) => (await sql(
  `select status, token_no, total, amended_at, amended_by from bills where id=$1`, [id])).rows[0];
const queued = async (billId) => (await sql(
  `select template_key, status, payload from outbound_messages
    where bill_id=$1 order by created_at`, [billId])).rows;

test("an admin may amend a pending bill: lines replaced, total recomputed, token kept", async () => {
  const w = await getWorld();
  const x = await billedBill(w.a, { qty: 2, price: 40 });   // total 80
  const before = await billRow(x.billId);
  const { error } = await amendAs(w.a.clients.admin, x.billId,
    [{ item_id: x.itemId, qty_kg: 5, unit_price: 40 }]);
  assert(!error, `amend refused: ${error?.message}`);
  const after = await billRow(x.billId);
  assertEqual(Number(after.total), 200, "total not recomputed from the new lines");
  assertEqual(after.token_no, before.token_no, "the token must survive an amendment");
  assertEqual(after.status, "billed", "status must stay billed");
  const rows = await linesOf(x.billId);
  assertEqual(rows.length, 1, "old lines should be gone");
  assertEqual(Number(rows[0].qty_kg), 5, "new quantity");
});

test("a recorder may amend, and the stamps record who", async () => {
  const w = await getWorld();
  const x = await billedBill(w.a);
  const { error } = await amendAs(w.a.clients.recorder, x.billId,
    [{ item_id: x.itemId, qty_kg: 1, unit_price: 40 }]);
  assert(!error, error?.message);
  const b = await billRow(x.billId);
  assert(b.amended_at !== null, "amended_at not stamped");
  assertEqual(b.amended_by, w.a.recorderId, "amended_by is the caller");
});

test("the pending message is superseded and quotes the new total", async () => {
  const w = await getWorld();
  const x = await billedBill(w.a, { qty: 2, price: 40 });
  await amendAs(w.a.clients.admin, x.billId, [{ item_id: x.itemId, qty_kg: 3, unit_price: 40 }]);
  const rows = await queued(x.billId);
  assertEqual(rows.length, 1, "the stale pending row should have been deleted");
  assertEqual(rows[0].template_key, "token_amended", "a corrected message should be queued");
  assertEqual(Number(rows[0].payload.total), 120, "the corrected message must quote the new total");
});

test("an already-sent message is history and is left in place", async () => {
  const w = await getWorld();
  const x = await billedBill(w.a, { qty: 2, price: 40 });
  await sql(`update outbound_messages set status='sent', sent_at=now() where bill_id=$1`, [x.billId]);
  await amendAs(w.a.clients.admin, x.billId, [{ item_id: x.itemId, qty_kg: 3, unit_price: 40 }]);
  const rows = await queued(x.billId);
  assertEqual(rows.length, 2, "the sent row must survive, with the correction after it");
  assertEqual(rows[0].status, "sent", "the original, still sent");
  assertEqual(rows[1].template_key, "token_amended", "the correction follows it");
});

test("a biller may not amend a bill", async () => {
  const w = await getWorld();
  const x = await billedBill(w.a);
  const { error } = await amendAs(w.a.clients.biller, x.billId,
    [{ item_id: x.itemId, qty_kg: 9, unit_price: 40 }]);
  assert(error, "a biller amended a basket");
  assertEqual((await linesOf(x.billId))[0].qty_kg !== "9", true, "lines changed on refusal");
});

test("an admin may not amend another vendor's bill", async () => {
  const w = await getWorld();
  const x = await billedBill(w.b);
  const { error } = await amendAs(w.a.clients.admin, x.billId,
    [{ item_id: x.itemId, qty_kg: 9, unit_price: 40 }]);
  assert(error, "cross-vendor amend");
});

test("a recording bill is refused: that path is replace_bill_lines", async () => {
  const w = await getWorld();
  const { rows: [b] } = await sql(
    `insert into bills (vendor_id, total, status) values ($1,0,'recording') returning id`,
    [w.a.vendorId]);
  const { error } = await amendAs(w.a.clients.admin, b.id,
    [{ item_id: w.a.itemId, qty_kg: 1, unit_price: 40 }]);
  assert(error, "a recording bill should be refused here");
});

test("a done bill is refused: that path is void and rebuild", async () => {
  const w = await getWorld();
  const x = await billedBill(w.a);
  await sql(`select complete_bill($1, null, 0)`, [x.billId]);
  const { error } = await amendAs(w.a.clients.admin, x.billId,
    [{ item_id: x.itemId, qty_kg: 9, unit_price: 40 }]);
  assert(error, "a done bill should be refused");
  assertEqual(Number((await linesOf(x.billId))[0].qty_kg), 2, "lines changed on refusal");
});

test("an empty basket is refused and the existing lines survive", async () => {
  const w = await getWorld();
  const x = await billedBill(w.a);
  const { error } = await amendAs(w.a.clients.admin, x.billId, []);
  assert(error, "an empty basket should be refused, not treated as 'clear the bill'");
  assertEqual((await linesOf(x.billId)).length, 1, "lines lost on a refused amendment");
});

test("a fractional quantity for a piece item is refused and the lines survive", async () => {
  const w = await getWorld();
  const x = await billedBill(w.a);
  const { rows: [p] } = await sql(
    `insert into items (vendor_id, name_en, price, stock_kg, unit)
     values ($1,'Amend Cabbage',30,50,'piece') returning id`, [w.a.vendorId]);
  const { error } = await amendAs(w.a.clients.admin, x.billId,
    [{ item_id: p.id, qty_kg: 1.5, unit_price: 30 }]);
  assert(error, "a fractional piece quantity should be refused");
  assertEqual((await linesOf(x.billId))[0].item_id, x.itemId, "the original line must survive");
});

test("line_total is computed, never taken from the caller", async () => {
  const w = await getWorld();
  const x = await billedBill(w.a);
  await amendAs(w.a.clients.admin, x.billId,
    [{ item_id: x.itemId, qty_kg: 5, unit_price: 40, line_total: 1 }]);
  assertEqual(Number((await linesOf(x.billId))[0].line_total), 200, "the sent line_total was trusted");
});

test("amending twice with the same basket leaves one copy", async () => {
  const w = await getWorld();
  const x = await billedBill(w.a);
  const basket = [{ item_id: x.itemId, qty_kg: 3, unit_price: 40 }];
  await amendAs(w.a.clients.admin, x.billId, basket);
  await amendAs(w.a.clients.admin, x.billId, basket);
  assertEqual((await linesOf(x.billId)).length, 1, "a repeated call appended a second copy");
  assertEqual(Number((await billRow(x.billId)).total), 120, "total doubled on a retry");
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test`
Expected: FAIL — `function amend_pending_bill(...) does not exist`.

- [ ] **Step 3: Implement the function**

Append to `supabase/migrations/0020_amend_bill_and_item_cost.sql`:

```sql
-- --------------------------------------------------------------------------
-- Part 1c: amending a pending bill.
--
-- replace_bill_lines (0015, re-created in 0018) refuses anything past 'recording', and
-- the refusal is right for what that function does: past 'recording' the customer holds a
-- token, has been told a total, and a message quoting that total is queued. Rewriting the
-- lines there makes both of those a lie, and replace_bill_lines has no way to fix either.
--
-- This function is the same rewrite with those two consequences handled: the total is
-- recomputed the way issue_token computes it, and the queued message is superseded. The
-- token is deliberately KEPT -- the slip in the customer's hand stays valid, and the
-- counter is not advanced for a correction.
--
-- A done bill is not accepted here. Its effects have already landed (stock, points,
-- receipt, the day's figures) and void_bill (0017) already reverses all of them; "editing"
-- a completed bill is void-then-rebuild, which needs no function of its own.
-- --------------------------------------------------------------------------
create function amend_pending_bill(p_bill_id uuid, p_lines jsonb)
  returns void
  language plpgsql security definer set search_path = public as $$
declare
  v_bill  bills%rowtype;
  v_total numeric;
begin
  select * into v_bill from bills where id = p_bill_id for update;
  if not found then
    raise exception 'bill % not found', p_bill_id;
  end if;

  -- The same trust decision and the same role pair as replace_bill_lines: a null
  -- current_vendor_id() is a caller with no end-user session (service role, or the
  -- superuser connection the suite uses); a non-null one must own this bill. A biller
  -- does not rewrite baskets.
  if current_vendor_id() is not null and current_vendor_id() <> v_bill.vendor_id then
    raise exception 'bill % does not belong to your vendor', p_bill_id
      using errcode = '42501';
  end if;
  if current_vendor_id() is not null and current_user_role() not in ('admin', 'recorder') then
    raise exception 'role % may not amend a bill', current_user_role()
      using errcode = '42501';
  end if;

  if v_bill.status <> 'billed' then
    raise exception 'bill % is %, expected billed', p_bill_id, v_bill.status
      using errcode = 'P0001';
  end if;

  -- Refused, never treated as "clear the bill" -- same reasoning as replace_bill_lines.
  if jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) = 0 then
    raise exception 'refusing to leave bill % with no lines', p_bill_id
      using errcode = '22023';
  end if;

  -- Checked BEFORE the delete, so a refused basket leaves the existing lines untouched.
  perform assert_whole_qty(l.item_id, l.qty_kg)
    from jsonb_to_recordset(p_lines) as l(item_id uuid, qty_kg numeric);

  delete from bill_items where bill_id = p_bill_id;

  -- line_total computed, unit_price the caller's: identical to replace_bill_lines, and
  -- for the identical reasons (a client-supplied line_total would forge the total; a
  -- live items.price read would change a basket already on screen).
  insert into bill_items (bill_id, vendor_id, item_id, qty_kg, unit_price, line_total)
  select p_bill_id, v_bill.vendor_id, l.item_id, l.qty_kg, l.unit_price,
         round(l.qty_kg * l.unit_price, 2)
    from jsonb_to_recordset(p_lines)
      as l(item_id uuid, qty_kg numeric, unit_price numeric);

  -- The total issue_token would have computed, from the rows just written.
  select coalesce(sum(line_total), 0) into v_total from bill_items where bill_id = p_bill_id;

  update bills
     set total = v_total, amended_at = now(), amended_by = auth.uid()
   where id = p_bill_id;

  -- Supersede, by DELETING the still-pending rows rather than adding a 'cancelled'
  -- status: the row was never sent, so there is no history in it to keep, and a delete
  -- needs no change to the status check constraint or to the sender's pending scan.
  -- A row already 'sent' or 'failed' is history and is left exactly where it is.
  delete from outbound_messages
   where bill_id = p_bill_id and status = 'pending';

  insert into outbound_messages (vendor_id, customer_id, bill_id, template_key, payload)
  values (v_bill.vendor_id, v_bill.customer_id, p_bill_id, 'token_amended',
          jsonb_build_object('token_no', v_bill.token_no, 'total', v_total));
end $$;

revoke all on function amend_pending_bill(uuid, jsonb) from public, anon;
grant execute on function amend_pending_bill(uuid, jsonb) to authenticated;
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test`
Expected: PASS — all of them, old and new.

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/0020_amend_bill_and_item_cost.sql tests/amend_pending_bill.test.mjs
git commit -m "feat(db): amend_pending_bill rewrites a billed basket in place

Total recomputed, token kept, the stale queued message superseded.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 3: `create_item_with_cost`

**Files:**
- Modify: `supabase/migrations/0020_amend_bill_and_item_cost.sql` (append part 2)
- Test: `tests/create_item_with_cost.test.mjs`

**Interfaces:**
- Consumes: `log_stock_movement(uuid, text, numeric, numeric, text)` (0016, re-created in 0018), `assert_whole_qty` (0018), the `items_unit_rules` trigger (0018).
- Produces: `create_item_with_cost(p_names jsonb, p_price numeric, p_stock numeric, p_unit text, p_low_stock_at numeric, p_cost numeric) returns items`.

- [ ] **Step 1: Write the failing tests**

Create `tests/create_item_with_cost.test.mjs`:

```javascript
import { test, assert, assertEqual, once } from "./framework.mjs";
import { sql } from "./fixtures.mjs";
import { seedTwoVendors } from "./seed.mjs";

const getWorld = once(seedTwoVendors);

const NAMES = { name_en: "Beet", name_hi: "चुकंदर", name_mr: "बीट" };

const createAs = (client, opts = {}) =>
  client.rpc("create_item_with_cost", {
    p_names: opts.names ?? NAMES,
    p_price: opts.price ?? 40,
    p_stock: opts.stock ?? 10,
    p_unit: opts.unit ?? "kg",
    p_low_stock_at: opts.lowAt ?? 5,
    p_cost: opts.cost === undefined ? 25 : opts.cost,
  });

const itemRow = async (id) => (await sql(
  `select name_en, price, stock_kg, unit, low_stock_at, last_cost, is_active
     from items where id=$1`, [id])).rows[0];
const movements = async (itemId) => (await sql(
  `select kind, qty_kg, unit_cost from stock_movements where item_id=$1`, [itemId])).rows;

test("an admin creates an item with opening stock: one purchase movement, no double count", async () => {
  const w = await getWorld();
  const { data, error } = await createAs(w.a.clients.admin, { stock: 10, cost: 25 });
  assert(!error, `create refused: ${error?.message}`);
  const it = await itemRow(data.id);
  assertEqual(Number(it.stock_kg), 10, "stock must equal the opening stock, not double it");
  assertEqual(Number(it.last_cost), 25, "last_cost not set");
  assertEqual(Number(it.price), 40, "price not set");
  const m = await movements(data.id);
  assertEqual(m.length, 1, "exactly one movement should be logged");
  assertEqual(m[0].kind, "purchase", "kind");
  assertEqual(Number(m[0].qty_kg), 10, "movement quantity");
  assertEqual(Number(m[0].unit_cost), 25, "movement cost");
});

test("zero opening stock logs no movement but still records the cost", async () => {
  const w = await getWorld();
  const { data, error } = await createAs(w.a.clients.admin, { stock: 0, cost: 18 });
  assert(!error, error?.message);
  assertEqual((await movements(data.id)).length, 0, "there is no purchase to record");
  const it = await itemRow(data.id);
  assertEqual(Number(it.stock_kg), 0, "stock");
  assertEqual(Number(it.last_cost), 18, "the cost is still on file");
});

test("a null cost is refused", async () => {
  const w = await getWorld();
  const { error } = await createAs(w.a.clients.admin, { cost: null });
  assert(error, "a null cost should be refused");
});

test("a negative cost is refused", async () => {
  const w = await getWorld();
  const { error } = await createAs(w.a.clients.admin, { cost: -1 });
  assert(error, "a negative cost should be refused");
});

test("a fractional opening stock for a piece item is refused, leaving no item behind", async () => {
  const w = await getWorld();
  const before = (await sql(`select count(*)::int c from items where vendor_id=$1`, [w.a.vendorId])).rows[0].c;
  const { error } = await createAs(w.a.clients.admin,
    { unit: "piece", stock: 1.5, names: { ...NAMES, name_en: "Half Cabbage" } });
  assert(error, "a fractional piece stock should be refused");
  const after = (await sql(`select count(*)::int c from items where vendor_id=$1`, [w.a.vendorId])).rows[0].c;
  assertEqual(after, before, "the item row must roll back with the movement");
});

test("a recorder may not create an item", async () => {
  const w = await getWorld();
  const { error } = await createAs(w.a.clients.recorder);
  assert(error, "a recorder created an item");
});

test("a biller may not create an item", async () => {
  const w = await getWorld();
  const { error } = await createAs(w.a.clients.biller);
  assert(error, "a biller created an item");
});

test("the item lands in the caller's own shop", async () => {
  const w = await getWorld();
  const { data } = await createAs(w.a.clients.admin);
  const { rows } = await sql(`select vendor_id from items where id=$1`, [data.id]);
  assertEqual(rows[0].vendor_id, w.a.vendorId, "vendor_id is taken from the session, never the caller");
});

test("changing an existing item's cost writes no movement row", async () => {
  const w = await getWorld();
  const { data } = await createAs(w.a.clients.admin, { stock: 0 });
  const { error } = await w.a.clients.admin
    .from("items").update({ last_cost: 31 }).eq("id", data.id);
  assert(!error, error?.message);
  assertEqual((await movements(data.id)).length, 0, "an edit must not invent a delivery");
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test`
Expected: FAIL — `function create_item_with_cost(...) does not exist`.

- [ ] **Step 3: Implement the function**

Append to `supabase/migrations/0020_amend_bill_and_item_cost.sql`:

```sql
-- --------------------------------------------------------------------------
-- Part 2: creating an item with its cost.
--
-- items.last_cost has had exactly one writer: log_stock_movement with kind='purchase',
-- reached from the Stock screen. So an item created on the Items form started life
-- uncosted, and every sale of it until the first purchase entry landed in
-- top_items_between's uncosted_lines with no margin at all.
--
-- The insert and the movement are one transaction because an item created without its
-- costing movement is a silent gap in the analytics -- the kind of gap nobody notices
-- until a margin figure is already wrong.
--
-- The item is inserted at stock 0 and log_stock_movement raises it. Inserting the opening
-- stock AND logging a purchase for it would count the same produce twice.
-- --------------------------------------------------------------------------
create function create_item_with_cost(
  p_names        jsonb,
  p_price        numeric,
  p_stock        numeric,
  p_unit         text,
  p_low_stock_at numeric,
  p_cost         numeric
) returns items
  language plpgsql security definer set search_path = public as $$
declare
  v_item  items%rowtype;
  v_stock numeric := round(p_stock, 2);
  v_cost  numeric := round(p_cost, 2);
begin
  -- Item creation is admin-only, as items_admin_write in 0002_rls.sql already says. A
  -- null vendor is refused here rather than allowed through: unlike issue_token, nothing
  -- creates items on a service-role connection.
  if current_vendor_id() is null or current_user_role() <> 'admin' then
    raise exception 'only an admin may create an item' using errcode = '42501';
  end if;

  if v_cost is null or v_cost < 0 then
    raise exception 'an item needs a cost' using errcode = '22023';
  end if;
  if v_stock is null or v_stock < 0 then
    raise exception 'opening stock cannot be negative' using errcode = '22023';
  end if;
  if p_unit is null or p_unit not in ('kg', 'piece', 'bunch', 'dozen') then
    raise exception 'unknown unit %', p_unit using errcode = '22023';
  end if;

  -- stock_kg 0 on purpose; the movement below raises it. last_cost is set here as well
  -- as by the movement, so a zero-stock item still carries its cost.
  insert into items (vendor_id, name_en, name_hi, name_mr,
                     price, stock_kg, unit, low_stock_at, last_cost)
  values (current_vendor_id(),
          coalesce(p_names->>'name_en', ''),
          coalesce(p_names->>'name_hi', ''),
          coalesce(p_names->>'name_mr', ''),
          p_price, 0, p_unit, p_low_stock_at, v_cost)
  returning * into v_item;

  if v_stock > 0 then
    -- Raises stock_kg by v_stock and sets last_cost, and runs its own assert_whole_qty,
    -- so a fractional opening stock for a piece item raises here and the insert above
    -- rolls back with it.
    perform log_stock_movement(v_item.id, 'purchase', v_stock, v_cost, 'opening stock');
    select * into v_item from items where id = v_item.id;
  end if;

  return v_item;
end $$;

revoke all on function create_item_with_cost(jsonb, numeric, numeric, text, numeric, numeric)
  from public, anon;
grant execute on function create_item_with_cost(jsonb, numeric, numeric, text, numeric, numeric)
  to authenticated;
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test`
Expected: PASS.

If the fractional-piece test fails because the item row survived, the cause is that
`log_stock_movement` is a separate `security definer` function but **not** a separate
transaction — it should roll back with the caller. Do not add an explicit savepoint;
investigate with `superpowers:systematic-debugging` instead, because a partial rollback
there would mean the 0016/0018 stock path has the same hole.

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/0020_amend_bill_and_item_cost.sql tests/create_item_with_cost.test.mjs
git commit -m "feat(db): create_item_with_cost logs opening stock as a purchase

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 4: Client data layer

**Files:**
- Modify: `web/src/data.ts`, `web/src/admin.ts`, `web/src/history.ts`
- Test: `web/src/__tests__/data.test.ts`, `web/src/__tests__/admin.test.ts`

**Interfaces:**
- Consumes: `amend_pending_bill`, `create_item_with_cost` (Tasks 2–3).
- Produces:
  - `amendPendingBill(billId: string, lines: readonly Draft[])` in `data.ts`
  - `billDraftLines(billId: string): Promise<{ data: Draft[] | null; error: PostgrestErrorLike }>` in `data.ts`
  - `createItem(vendorId: string, value: ItemValue)` in `admin.ts` — **signature unchanged**, body now an RPC; `vendorId` becomes unused and is kept only so no call site changes.

- [ ] **Step 1: Write the failing tests**

Append to `web/src/__tests__/data.test.ts` (follow the file's existing stubbing idiom for `supabase` — read the top of the file first and match it exactly):

```typescript
it("amendPendingBill sends item_id/qty_kg/unit_price and never a line_total", async () => {
  const rpc = vi.fn().mockResolvedValue({ data: null, error: null });
  stubSupabase({ rpc });
  await amendPendingBill("b1", [
    { itemId: "i1", name: "Onion", unitPrice: 40, qtyKg: 2.5, unit: "kg" },
  ]);
  expect(rpc).toHaveBeenCalledWith("amend_pending_bill", {
    p_bill_id: "b1",
    p_lines: [{ item_id: "i1", qty_kg: 2.5, unit_price: 40 }],
  });
});

it("billDraftLines maps stored rows onto the Draft shape the basket edits", async () => {
  stubSupabase({
    from: () => ({ select: () => ({ eq: () => Promise.resolve({
      data: [{
        id: "l1", qty_kg: 2, unit_price: 40, line_total: 80, item_id: "i1",
        items: { name_en: "Onion", name_hi: "प्याज", name_mr: "कांदा", unit: "kg" },
      }],
      error: null,
    }) }) }),
  });
  const { data } = await billDraftLines("b1");
  expect(data).toEqual([
    { itemId: "i1", name: "Onion", unitPrice: 40, qtyKg: 2, unit: "kg" },
  ]);
});
```

Append to `web/src/__tests__/admin.test.ts`:

```typescript
it("createItem calls the RPC with the cost, not a plain insert", async () => {
  const rpc = vi.fn().mockResolvedValue({ data: { id: "i9" }, error: null });
  stubSupabase({ rpc });
  await createItem("v1", {
    name_en: "Beet", name_hi: "चुकंदर", name_mr: "बीट",
    price: 40, stock_kg: 10, unit: "kg", low_stock_at: 5, cost: 25,
  });
  expect(rpc).toHaveBeenCalledWith("create_item_with_cost", {
    p_names: { name_en: "Beet", name_hi: "चुकंदर", name_mr: "बीट" },
    p_price: 40,
    p_stock: 10,
    p_unit: "kg",
    p_low_stock_at: 5,
    p_cost: 25,
  });
});

it("updateItem omits a null cost so a blank field leaves last_cost alone", async () => {
  const update = vi.fn().mockReturnValue({ eq: () => Promise.resolve({ error: null }) });
  stubSupabase({ from: () => ({ update }) });
  await updateItem("i1", {
    name_en: "Beet", name_hi: "चुकंदर", name_mr: "बीट",
    price: 40, stock_kg: 10, unit: "kg", low_stock_at: 5, cost: null,
  });
  expect(update.mock.calls[0][0]).not.toHaveProperty("last_cost");
});

it("updateItem sends last_cost when a cost was typed", async () => {
  const update = vi.fn().mockReturnValue({ eq: () => Promise.resolve({ error: null }) });
  stubSupabase({ from: () => ({ update }) });
  await updateItem("i1", {
    name_en: "Beet", name_hi: "चुकंदर", name_mr: "बीट",
    price: 40, stock_kg: 10, unit: "kg", low_stock_at: 5, cost: 31,
  });
  expect(update.mock.calls[0][0].last_cost).toBe(31);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run (from `web/`): `npm test -- data admin`
Expected: FAIL — `amendPendingBill is not exported` and the `createItem` assertion.

- [ ] **Step 3: Implement**

In `web/src/data.ts`, after `replaceBillLines`:

```typescript
/**
 * The same rewrite replaceBillLines performs, for a bill that already has a token.
 *
 * A separate function rather than a flag, because the SERVER functions are separate:
 * replace_bill_lines refuses anything past 'recording' and cannot fix the two things
 * that makes wrong (the quoted total, the queued message), while amend_pending_bill
 * (0020) recomputes the total and supersedes the message. The bill keeps its token.
 *
 * No line_total, for the same reason as replaceBillLines: the function computes it, so a
 * client-supplied one cannot forge a bill's total.
 */
export async function amendPendingBill(billId: string, lines: readonly Draft[]) {
  return supabase.rpc("amend_pending_bill", {
    p_bill_id: billId,
    p_lines: lines.map((l) => ({
      item_id: l.itemId,
      qty_kg: l.qtyKg,
      unit_price: l.unitPrice,
    })),
  });
}

/**
 * A bill's stored lines in the shape the basket edits.
 *
 * unit_price comes from the STORED row, not from items.price: the price at the moment of
 * recording is the bill's price, and re-reading the live one would silently reprice a
 * basket during an amendment.
 */
export async function billDraftLines(billId: string) {
  const res = await supabase
    .from("bill_items")
    .select("id, item_id, qty_kg, unit_price, line_total, items(name_en, name_hi, name_mr, unit)")
    .eq("bill_id", billId);
  if (res.error || !res.data) return { data: null, error: res.error };
  type Row = {
    item_id: string; qty_kg: number; unit_price: number;
    items: { name_en: string; name_hi: string; name_mr: string; unit: Unit } | null;
  };
  const data: Draft[] = (res.data as unknown as Row[]).map((r) => ({
    itemId: r.item_id,
    name: r.items?.name_en ?? "",
    unitPrice: Number(r.unit_price),
    qtyKg: Number(r.qty_kg),
    unit: r.items?.unit ?? "kg",
  }));
  return { data, error: null };
}
```

Add `import type { Unit } from "./units";` to `data.ts` if it is not already imported.

**Note on the name:** `billDraftLines` returns `name_en` only. The screen re-labels each
line in the active language from its own `listItems()` result — `Draft.name` is display
text, and the basket is rendered beside a live item grid that already has all three names.

In `web/src/admin.ts`, replace `createItem` and `updateItem`:

```typescript
/**
 * An RPC, not an insert, since 0020: creating an item also logs its opening stock as a
 * purchase movement so that stock is costed in the margin figures. The two writes have to
 * be one transaction, which a PostgREST insert cannot give.
 *
 * vendorId is no longer sent -- create_item_with_cost reads it off the session, which is
 * strictly safer than trusting the client -- but stays in the signature so no call site
 * has to change.
 */
export async function createItem(_vendorId: string, value: ItemValue) {
  return supabase.rpc("create_item_with_cost", {
    p_names: { name_en: value.name_en, name_hi: value.name_hi, name_mr: value.name_mr },
    p_price: value.price,
    p_stock: value.stock_kg,
    p_unit: value.unit,
    p_low_stock_at: value.low_stock_at,
    p_cost: value.cost,
  });
}

/**
 * Still a plain update, and deliberately NOT a movement: changing a cost here corrects
 * what the item costs, it does not record a delivery. Logging a purchase would invent
 * stock that never arrived and inflate the purchase figures every time an admin fixed a
 * typo. Adding stock to an existing item stays the Stock screen's job.
 *
 * A null cost means the field was left blank, which means "leave last_cost alone" -- so
 * the key is omitted rather than sent as null, which would erase a known cost.
 */
export async function updateItem(id: string, value: ItemValue) {
  const { cost, ...rest } = value;
  const patch = cost === null ? rest : { ...rest, last_cost: cost };
  return supabase.from("items").update(patch).eq("id", id);
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run (from `web/`): `npm test`
Expected: PASS. `ItemValue` does not yet have `cost`, so `tsc` will complain — that is Task 5's job; if the Vitest run fails purely on the missing `cost` property, do Task 5's Step 3 type change first and come back. Otherwise leave it.

- [ ] **Step 5: Commit**

```bash
git add web/src/data.ts web/src/admin.ts web/src/__tests__/data.test.ts web/src/__tests__/admin.test.ts
git commit -m "feat(web): amendPendingBill, billDraftLines, and createItem via RPC

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 5: Cost on the Items form

**Files:**
- Modify: `web/src/adminRules.ts`, `web/src/screens/Items.tsx`, `web/src/i18n/en.json`, `web/src/i18n/hi.json`, `web/src/i18n/mr.json`
- Test: `web/src/__tests__/adminRules.test.ts`, `web/src/__tests__/Items.test.tsx`

**Interfaces:**
- Consumes: `createItem` / `updateItem` (Task 4), `perUnit(unit, t)` from `web/src/units.ts`.
- Produces: `ItemInput.cost: string`; `ItemValue.cost: number | null`;
  `validateItem(input: ItemInput, mode: "create" | "edit")`.

- [ ] **Step 1: Write the failing tests**

Append to `web/src/__tests__/adminRules.test.ts`:

```typescript
const base = {
  name_en: "Beet", name_hi: "चुकंदर", name_mr: "बीट",
  price: "40", stock_kg: "10", unit: "kg" as const, low_stock_at: "5",
};

it("cost is required when creating an item", () => {
  const r = validateItem({ ...base, cost: "" }, "create");
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.errors.cost).toBe("items.costRequired");
});

it("cost may be blank when editing, and means 'leave it alone'", () => {
  const r = validateItem({ ...base, cost: "" }, "edit");
  expect(r.ok).toBe(true);
  if (r.ok) expect(r.value.cost).toBeNull();
});

it("a negative cost is rejected in both modes", () => {
  for (const mode of ["create", "edit"] as const) {
    const r = validateItem({ ...base, cost: "-1" }, mode);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.cost).toBe("items.badCost");
  }
});

it("zero is a valid cost", () => {
  const r = validateItem({ ...base, cost: "0" }, "create");
  expect(r.ok).toBe(true);
  if (r.ok) expect(r.value.cost).toBe(0);
});

it("a typed cost is carried through on edit", () => {
  const r = validateItem({ ...base, cost: "31.5" }, "edit");
  expect(r.ok).toBe(true);
  if (r.ok) expect(r.value.cost).toBe(31.5);
});
```

Append to `web/src/__tests__/Items.test.tsx` (match the file's existing render/stub idiom):

```tsx
it("refuses to save a new item with no cost", async () => {
  renderItems();
  await userEvent.click(screen.getByText("items.add"));
  await userEvent.type(screen.getByLabelText(/items.nameEn/), "Beet");
  await userEvent.type(screen.getByLabelText(/items.nameHi/), "चुकंदर");
  await userEvent.type(screen.getByLabelText(/items.nameMr/), "बीट");
  await userEvent.type(screen.getByLabelText(/items.price/), "40");
  await userEvent.type(screen.getByLabelText(/items.stock/), "10");
  await userEvent.click(screen.getByTestId("item-save"));
  expect(screen.getByText("items.costRequired")).toBeInTheDocument();
  expect(createItemSpy).not.toHaveBeenCalled();
});

it("the cost label follows the unit selector", async () => {
  renderItems();
  await userEvent.click(screen.getByText("items.add"));
  await userEvent.selectOptions(screen.getByTestId("item-unit"), "dozen");
  // items.cost is interpolated with perUnit(), the same helper items.price uses.
  expect(screen.getByLabelText(/unit.per.dozen/)).toBeInTheDocument();
});

it("an existing item may be saved with the cost left blank", async () => {
  renderItems();
  await userEvent.click(screen.getByTestId("item-edit-i1"));
  await userEvent.clear(screen.getByTestId("item-cost"));
  await userEvent.click(screen.getByTestId("item-save"));
  expect(updateItemSpy).toHaveBeenCalled();
  expect(updateItemSpy.mock.calls[0][1].cost).toBeNull();
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run (from `web/`): `npm test -- adminRules Items`
Expected: FAIL — `validateItem` takes one argument; no cost field rendered.

- [ ] **Step 3: Implement the rules**

In `web/src/adminRules.ts`:

- Add `cost: string;` to `ItemInput` (after `price`).
- Add `cost: number | null;` to `ItemValue`.
- Change the signature and add the branch:

```typescript
export function validateItem(
  input: ItemInput,
  mode: "create" | "edit",
): { ok: true; value: ItemValue } | { ok: false; errors: Partial<Record<ItemField, string>> } {
  const errors: Partial<Record<ItemField, string>> = {};

  // ... existing name / price / stock / lowAt checks, unchanged ...

  // Required on create so an item never starts life uncosted -- every sale of an uncosted
  // item lands in top_items_between's uncosted_lines with no margin at all. Blank is
  // allowed on EDIT and means "leave last_cost alone", so the thousands of items created
  // before 0020 do not each have to be costed before any other field can be fixed.
  let cost: number | null = null;
  const costRaw = input.cost.trim();
  if (costRaw === "") {
    if (mode === "create") errors.cost = "items.costRequired";
  } else {
    cost = nonNegative(input.cost);
    if (cost === null) errors.cost = "items.badCost";
  }

  if (Object.keys(errors).length > 0) return { ok: false, errors };
  return {
    ok: true,
    value: {
      // ... existing fields, unchanged ...
      cost,
    },
  };
}
```

- [ ] **Step 4: Implement the form**

In `web/src/screens/Items.tsx`:

- `BLANK` gains `cost: ""`.
- `toInput` gains `cost: it.last_cost === null ? "" : String(it.last_cost)`.
- `save()` passes the mode: `validateItem(editing.input, editing.id === null ? "create" : "edit")`.
- Insert this block **between** the price block and the stock block, so the form reads
  price → cost → stock:

```tsx
<div>
  <label className="block text-sm text-slate-600 mb-1" htmlFor="item-cost">
    {t("items.cost", { per: perUnit(editing.input.unit, t) })}
  </label>
  <input
    id="item-cost"
    data-testid="item-cost"
    value={editing.input.cost}
    inputMode="decimal"
    onChange={(e) =>
      setEditing({ ...editing, input: { ...editing.input, cost: e.target.value } })
    }
    className="w-full border border-slate-300 rounded-lg px-3 py-2 min-h-[44px]"
  />
  {errors.cost && <p className="text-xs text-red-700 mt-1">{t(errors.cost)}</p>}
  <p className="text-xs text-slate-500 mt-1">
    {editing.id === null ? t("items.costNewNote") : t("items.costEditNote")}
  </p>
</div>
```

- [ ] **Step 5: Add the translations**

In `web/src/i18n/en.json`, alongside the existing `items.*` keys:

```json
"items.cost": "Cost {{per}}",
"items.badCost": "Enter a cost of zero or more",
"items.costRequired": "A new item needs its cost",
"items.costNewNote": "Opening stock is recorded as a purchase at this cost.",
"items.costEditNote": "Leave blank to keep the current cost. This does not add stock."
```

Add the same five keys to `hi.json` and `mr.json`, translated. Match the tone of the
neighbouring `items.*` entries, and follow the terminator convention the surrounding
Marathi keys use.

- [ ] **Step 6: Run the tests to verify they pass**

Run (from `web/`): `npm test && npm run build`
Expected: PASS, and a clean `tsc --noEmit`. `validateItem` now takes two arguments, so
every caller must be updated — `grep -rn "validateItem(" web/src` and fix each one.

- [ ] **Step 7: Commit**

```bash
git add web/src/adminRules.ts web/src/screens/Items.tsx web/src/i18n web/src/__tests__
git commit -m "feat(web): cost on the item form, required on create

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 6: Amending a pending bill from the queue

**Files:**
- Create: `web/src/screens/AmendBill.tsx`, `web/src/__tests__/AmendBill.test.tsx`
- Modify: `web/src/screens/Pending.tsx`, `web/src/routes.ts`, `web/src/App.tsx`, `web/src/i18n/{en,hi,mr}.json`
- Test: `web/src/__tests__/Pending.test.tsx`, `web/src/__tests__/guards.test.ts`

**Interfaces:**
- Consumes: `amendPendingBill`, `billDraftLines`, `listItems` (`data.ts`); `ItemGrid` (`screens/bill/ItemGrid.tsx`), `Basket` (`screens/bill/Basket.tsx`), `runningTotal` (`billing.ts`).
- Produces: route `/amend/:billId`; `Pending.tsx` renders `item-amend-<billId>`.

- [ ] **Step 1: Write the failing tests**

Create `web/src/__tests__/AmendBill.test.tsx` (mirror the stubbing idiom at the top of
`Bill.test.tsx` — it already stubs `data.ts` and renders a screen inside a `MemoryRouter`):

```tsx
it("loads the bill's stored lines into the basket", async () => {
  renderAmend("b1");
  expect(await screen.findByText("Onion")).toBeInTheDocument();
  expect(screen.getByTestId("amend-old-total")).toHaveTextContent("80");
});

it("shows the old total beside the new one as the basket changes", async () => {
  renderAmend("b1");
  await screen.findByText("Onion");
  await userEvent.click(screen.getByLabelText(/bill.remove Onion/));
  expect(screen.getByTestId("amend-old-total")).toHaveTextContent("80");
  expect(screen.getByTestId("amend-new-total")).toHaveTextContent("0");
});

it("refuses to save an empty basket", async () => {
  renderAmend("b1");
  await screen.findByText("Onion");
  await userEvent.click(screen.getByLabelText(/bill.remove Onion/));
  expect(screen.getByTestId("amend-save")).toBeDisabled();
  expect(amendSpy).not.toHaveBeenCalled();
});

it("saves through amendPendingBill and returns to the queue", async () => {
  renderAmend("b1");
  await screen.findByText("Onion");
  await userEvent.click(screen.getByTestId("amend-save"));
  await userEvent.click(screen.getByTestId("amend-confirm"));
  expect(amendSpy).toHaveBeenCalledWith("b1", [
    { itemId: "i1", name: "Onion", unitPrice: 40, qtyKg: 2, unit: "kg" },
  ]);
});

it("surfaces a refusal and keeps the basket on screen", async () => {
  amendSpy.mockResolvedValue({ error: { message: "bill b1 is done, expected billed" } });
  renderAmend("b1");
  await screen.findByText("Onion");
  await userEvent.click(screen.getByTestId("amend-save"));
  await userEvent.click(screen.getByTestId("amend-confirm"));
  expect(await screen.findByTestId("amend-error")).toBeInTheDocument();
  expect(screen.getByText("Onion")).toBeInTheDocument();
});
```

Append to `web/src/__tests__/Pending.test.tsx`:

```tsx
it("offers Edit on a pending bill for an admin", async () => {
  renderPending({ role: "admin" });
  expect(await screen.findByTestId("bill-amend-b1")).toBeInTheDocument();
});

it("offers Edit for a recorder", async () => {
  renderPending({ role: "recorder" });
  expect(await screen.findByTestId("bill-amend-b1")).toBeInTheDocument();
});

it("does not offer Edit to a biller", async () => {
  renderPending({ role: "biller" });
  await screen.findByText(/bill.token/);
  expect(screen.queryByTestId("bill-amend-b1")).not.toBeInTheDocument();
});
```

Append to `web/src/__tests__/guards.test.ts`:

```typescript
it("admin and recorder reach /amend/<id>; a biller does not", () => {
  expect(canAccess("admin", "/amend/b1")).toBe(true);
  expect(canAccess("recorder", "/amend/b1")).toBe(true);
  expect(canAccess("biller", "/amend/b1")).toBe(false);
});

it("/amend is not granted by prefix alone", () => {
  expect(canAccess("admin", "/amendxyz/b1")).toBe(false);
  expect(canAccess("admin", "/amend")).toBe(false);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run (from `web/`): `npm test -- AmendBill Pending guards`
Expected: FAIL — no `AmendBill` module, no `bill-amend-b1`, `canAccess` false for `/amend/b1`.

- [ ] **Step 3: Add the route**

In `web/src/routes.ts`, extend `UNLISTED` only — **not** `BY_ROLE`, because `/amend/:billId`
needs an id to mean anything and a nav entry for it would be a dead link:

```typescript
const UNLISTED: Record<Role, readonly string[]> = {
  recorder: ["/amend"],
  biller: ["/receipt"],
  admin: ["/receipt", "/amend"],
};
```

The existing `matchesUnlisted` already requires exactly one further segment, so
`/amendxyz/b1` and a bare `/amend` stay refused.

- [ ] **Step 4: Write the screen**

Create `web/src/screens/AmendBill.tsx`:

```tsx
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate, useParams } from "react-router-dom";
// i18next initialises as a side effect of this import, exactly as Bill.tsx does.
import "../i18n";
import { runningTotal, type Draft } from "../billing";
import { amendPendingBill, billDraftLines, listItems, type Item } from "../data";
import { describeError } from "../errors";
import { asLang } from "../i18n/locales";
import { rupees } from "../money";
import { ItemGrid } from "./bill/ItemGrid";
import { Basket } from "./bill/Basket";

/**
 * Correcting a bill that already has a token.
 *
 * A separate screen from Bill.tsx rather than a mode inside it. Bill.tsx is a state
 * machine over customer -> items -> token whose whole job is bringing a bill into
 * existence; this screen starts from a bill that already exists and never touches the
 * customer or the token. Sharing ItemGrid and Basket -- already extracted -- gives the
 * reuse that matters without threading a second lifecycle through the first one's phases.
 *
 * The OLD total is kept on screen beside the new one for the whole edit. The customer has
 * already been told a number; the biller has to be able to read them the corrected one
 * and see, at a glance, that it changed.
 */
export default function AmendBill() {
  const { billId = "" } = useParams();
  const navigate = useNavigate();
  const { t, i18n } = useTranslation();

  const [items, setItems] = useState<readonly Item[]>([]);
  const [lines, setLines] = useState<Draft[] | null>(null);
  const [oldTotal, setOldTotal] = useState<number | null>(null);
  const [problem, setProblem] = useState<{ key: string; detail: string } | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    void (async () => {
      const [drafts, catalogue] = await Promise.all([billDraftLines(billId), listItems()]);
      setProblem(describeError(drafts.error) ?? describeError(catalogue.error));
      const loaded = drafts.data ?? [];
      setLines(loaded);
      // Captured ONCE, from the lines as they were stored. Recomputing it later would
      // make it track the edit and the comparison would always read "no change".
      setOldTotal(runningTotal(loaded));
      setItems((catalogue.data ?? []) as unknown as Item[]);
    })();
  }, [billId]);

  async function save() {
    if (!lines || lines.length === 0) return;
    setSaving(true);
    const { error } = await amendPendingBill(billId, lines);
    setSaving(false);
    const described = describeError(error);
    setProblem(described);
    if (described) { setConfirming(false); return; }
    navigate("/pending");
  }

  if (lines === null) return null;
  const newTotal = runningTotal(lines);

  return (
    <div className="space-y-4">
      <h2 className="font-semibold text-slate-800">{t("amend.title")}</h2>

      {problem && (
        <p data-testid="amend-error"
           className="text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg p-3">
          {t(problem.key)}
        </p>
      )}

      <div className="bg-white border border-slate-200 rounded-xl p-3 flex gap-6">
        <span className="text-sm text-slate-500">
          {t("amend.oldTotal")}{" "}
          <span data-testid="amend-old-total" className="tabular-nums line-through">
            {rupees(oldTotal ?? 0)}
          </span>
        </span>
        <span className="text-sm font-medium text-slate-800">
          {t("amend.newTotal")}{" "}
          <span data-testid="amend-new-total" className="tabular-nums">{rupees(newTotal)}</span>
        </span>
      </div>

      <Basket
        lines={lines}
        onRemove={(i) => setLines(lines.filter((_, n) => n !== i))}
      />

      <ItemGrid
        items={items}
        lang={asLang(i18n.language)}
        onAdd={(line) => setLines([...lines, line])}
      />

      {confirming ? (
        <div className="bg-white border border-slate-200 rounded-xl p-3 space-y-3">
          <p className="text-sm text-slate-700">
            {t("amend.confirm", { old: rupees(oldTotal ?? 0), next: rupees(newTotal) })}
          </p>
          <div className="flex gap-2">
            <button
              data-testid="amend-confirm" onClick={() => void save()} disabled={saving}
              className="rounded-lg px-4 py-2 text-sm bg-slate-800 text-white min-h-[44px] disabled:opacity-50"
            >
              {t("amend.confirmSave")}
            </button>
            <button
              onClick={() => setConfirming(false)}
              className="border border-slate-300 rounded-lg px-4 py-2 text-sm bg-white min-h-[44px]"
            >
              {t("amend.cancel")}
            </button>
          </div>
        </div>
      ) : (
        <div className="flex gap-2">
          <button
            data-testid="amend-save"
            onClick={() => setConfirming(true)}
            disabled={lines.length === 0}
            className="rounded-lg px-4 py-2 text-sm bg-slate-800 text-white min-h-[44px] disabled:opacity-50"
          >
            {t("amend.save")}
          </button>
          <button
            onClick={() => navigate("/pending")}
            className="border border-slate-300 rounded-lg px-4 py-2 text-sm bg-white min-h-[44px]"
          >
            {t("amend.cancel")}
          </button>
        </div>
      )}
    </div>
  );
}
```

If `asLang` is not exported from `web/src/i18n/locales.ts`, use the local copy that
`Bill.tsx` defines (`const asLang = …`) rather than exporting a new symbol from locales —
duplicating four lines is cheaper than a shared export only two screens want.

- [ ] **Step 5: Wire the route and the queue action**

In `web/src/App.tsx`, add the route beside the existing `/receipt/:billId` one:

```tsx
<Route path="/amend/:billId" element={<Guard><AmendBill /></Guard>} />
```

Match however the neighbouring routes wrap themselves in `Guard` — read the file and
follow it exactly.

In `web/src/screens/Pending.tsx`, inside the per-bill row, beside the Complete button:

```tsx
{(session.role === "admin" || session.role === "recorder") && (
  <Link
    data-testid={`bill-amend-${bill.id}`}
    to={`/amend/${bill.id}`}
    className="border border-slate-300 rounded-lg px-3 py-2 text-sm bg-white min-h-[44px]"
  >
    {t("pending.edit")}
  </Link>
)}
```

`Pending.tsx` does not currently read the session — add `useSession()` the way `Items.tsx`
does, and return `null` while `session.kind !== "ready"`. Hiding the button is courtesy;
`amend_pending_bill`'s own role check is what actually holds.

- [ ] **Step 6: Add the translations**

`en.json`:

```json
"amend.title": "Correct this bill",
"amend.oldTotal": "Was",
"amend.newTotal": "Now",
"amend.save": "Save correction",
"amend.cancel": "Cancel",
"amend.confirm": "The customer was told {{old}}. They now owe {{next}} — read them the new total.",
"amend.confirmSave": "Yes, correct it",
"pending.edit": "Edit"
```

Same keys in `hi.json` and `mr.json`, translated, keeping the `{{old}}` / `{{next}}`
placeholders exactly as written.

- [ ] **Step 7: Run the tests to verify they pass**

Run (from `web/`): `npm test && npm run build`
Expected: PASS and a clean type check.

- [ ] **Step 8: Commit**

```bash
git add web/src
git commit -m "feat(web): correct a pending bill from the queue

A dedicated screen over the shared ItemGrid and Basket, showing the old
total beside the new one so the biller can re-read it to the customer.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 7: Editing a completed bill as void + rebuild

**Files:**
- Modify: `web/src/screens/Completed.tsx`, `web/src/screens/Bill.tsx`, `web/src/i18n/{en,hi,mr}.json`
- Test: `web/src/__tests__/Completed.test.tsx`, `web/src/__tests__/Bill.test.tsx`

**Interfaces:**
- Consumes: `voidBill(billId, reason)` and `billLines(billId)` (`history.ts`, both already exist); `billDraftLines` (Task 4).
- Produces: `Bill.tsx` reads `location.state.prefill?: Draft[]` and starts with those lines.

- [ ] **Step 1: Write the failing tests**

Append to `web/src/__tests__/Completed.test.tsx`:

```tsx
it("offers Edit wherever Void is offered", async () => {
  renderCompleted();
  await screen.findByTestId("bill-void-b1");
  expect(screen.getByTestId("bill-edit-b1")).toBeInTheDocument();
});

it("does not offer Edit on a bill outside the void window", async () => {
  renderCompleted({ rows: [{ ...doneRow, completed_at: "2026-09-19T05:00:00Z" }] });
  await screen.findByText(/completed.token/);
  expect(screen.queryByTestId("bill-edit-b1")).not.toBeInTheDocument();
});

it("Edit requires a reason, exactly as Void does", async () => {
  renderCompleted();
  await userEvent.click(await screen.findByTestId("bill-edit-b1"));
  expect(screen.getByTestId("edit-confirm")).toBeDisabled();
  await userEvent.type(screen.getByTestId("edit-reason"), "wrong quantity");
  expect(screen.getByTestId("edit-confirm")).toBeEnabled();
});

it("voids the original before opening the replacement", async () => {
  renderCompleted();
  await userEvent.click(await screen.findByTestId("bill-edit-b1"));
  await userEvent.type(screen.getByTestId("edit-reason"), "wrong quantity");
  await userEvent.click(screen.getByTestId("edit-confirm"));
  expect(voidSpy).toHaveBeenCalledWith("b1", "wrong quantity");
  expect(navigateSpy).toHaveBeenCalledWith("/bill", expect.objectContaining({
    state: expect.objectContaining({ prefill: expect.any(Array) }),
  }));
});

it("a failed void does not open the replacement", async () => {
  voidSpy.mockResolvedValue({ error: { message: "void window closed" } });
  renderCompleted();
  await userEvent.click(await screen.findByTestId("bill-edit-b1"));
  await userEvent.type(screen.getByTestId("edit-reason"), "wrong quantity");
  await userEvent.click(screen.getByTestId("edit-confirm"));
  expect(await screen.findByText(/error/i)).toBeInTheDocument();
  expect(navigateSpy).not.toHaveBeenCalled();
});
```

Append to `web/src/__tests__/Bill.test.tsx`:

```tsx
it("starts with the lines handed to it in router state", async () => {
  renderBill({ state: { prefill: [
    { itemId: "i1", name: "Onion", unitPrice: 40, qtyKg: 2, unit: "kg" },
  ] } });
  expect(await screen.findByText("Onion")).toBeInTheDocument();
});

it("a prefilled bill still starts at the customer step", async () => {
  renderBill({ state: { prefill: [
    { itemId: "i1", name: "Onion", unitPrice: 40, qtyKg: 2, unit: "kg" },
  ] } });
  expect(await screen.findByText("bill.customerStep")).toBeInTheDocument();
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run (from `web/`): `npm test -- Completed Bill`
Expected: FAIL — no `bill-edit-b1`, prefill ignored.

- [ ] **Step 3: Teach Bill.tsx to start from given lines**

In `web/src/screens/Bill.tsx`, where `lines` is initialised:

```tsx
// Handed over by Completed.tsx after it voids a bill being corrected: the replacement
// starts from the voided bill's basket so the recorder retypes only what was wrong.
// The CUSTOMER step still runs -- the replacement is a new bill with a new token, and
// pre-selecting a customer would hide from the recorder that this is a fresh sale.
const location = useLocation();
const prefill = (location.state as { prefill?: Draft[] } | null)?.prefill;
const [lines, setLines] = useState<Draft[]>(() => prefill ?? []);
```

Add `useLocation` to the `react-router-dom` import. Leave the initial `phase` as it is —
`"customer"` — for the reason in the comment.

- [ ] **Step 4: Add the Edit action to Completed.tsx**

`Completed.tsx` already computes whether Void is offered for a row (the same-day window)
and already holds `voidingId` / `reason` state. Add a parallel `editingId` and reuse that
computation — **do not write a second date comparison**; extract the existing one into a
named helper (`const inVoidWindow = (completedAt: string) => …`) and call it from both.

The Edit flow:

```tsx
async function editBill(bill: CompletedBill) {
  setBusy(true);
  const { error } = await voidBill(bill.id, reason.trim());
  const described = describeError(error);
  if (described) { setBusy(false); setProblem(described); return; }
  // The lines are read BEFORE navigating rather than after: bill_items survive the void
  // (0017 sets a status, it does not delete), but reading them here keeps the failure on
  // this screen, where the operator can retry, instead of on a half-opened new bill.
  const { data } = await billDraftLines(bill.id);
  setBusy(false);
  navigate("/bill", { state: { prefill: data ?? [] } });
}
```

Render the trigger beside the existing Void button, under the same window condition, with
`data-testid={`bill-edit-${bill.id}`}`; render the reason input as
`data-testid="edit-reason"` and the confirm as `data-testid="edit-confirm"`, disabled
while `reason.trim() === ""` — matching how the Void confirm already behaves.

The confirm copy must say plainly what happens, because it is not reversible and it costs
the customer their token:

```json
"completed.edit": "Edit",
"completed.editConfirm": "This bill will be voided and a corrected one started. The customer gets a new token number.",
"completed.editReason": "Why is it being corrected?"
```

Add those three keys to all three locale files.

- [ ] **Step 5: Run the tests to verify they pass**

Run (from `web/`): `npm test && npm run build`
Expected: PASS and a clean type check.

- [ ] **Step 6: Run the whole suite, both halves**

```bash
npm test                 # repo root: the database suite
cd web && npm test && npm run build
```
Expected: every database test passes (the pre-existing 142 plus the new ones from Tasks
1–3), every web test passes, `tsc --noEmit` is clean.

- [ ] **Step 7: Commit and push**

```bash
git add web/src
git commit -m "feat(web): edit a completed bill by voiding and rebuilding it

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
git push
```

Then **check CI**. Local `tsc` being clean does not mean CI is: TypeScript 7 is a
per-platform native binary and CI's Linux build has rejected code Windows accepted
before. Do not report the work finished until CI is green.

---

## Done means

- `npm test` at the repo root: all pre-existing tests plus the new `amend_pending_bill`
  and `create_item_with_cost` suites pass.
- `npm test` and `npm run build` inside `web/`: pass and type-check clean.
- Pushed to `main`, CI green on Linux.
- **Not deployed.** 0020 has not been applied to Supabase Cloud — that is the owner's
  manual step, and the memory note about `supabase db push` returning 401 from this
  machine still applies.
