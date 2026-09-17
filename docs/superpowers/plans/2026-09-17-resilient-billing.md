# Resilient Billing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a bill's line-write safe to repeat after a lost reply, and stop the completion screen reporting failure for a sale that actually succeeded.

**Architecture:** A new `replace_bill_lines(p_bill_id, p_lines)` RPC sets a recording bill's lines to exactly the basket given, deleting and inserting in one transaction — idempotent by construction, so a retry converges instead of appending. The client's check-then-insert mitigation (`billHasLines`) is deleted rather than kept beside it, and `Bill.tsx`'s resume state loses the axis that tracked how far the write got. Separately, `Pending.tsx` reads a bill back after a failed `complete_bill`, the way `Bill.tsx` already does after a failed `issue_token`.

**Tech Stack:** PostgreSQL (native, `node tests/run.mjs`), Supabase/PostgREST, React 19 + TypeScript 7, Vitest 5 + @testing-library/react.

**Spec:** `docs/superpowers/specs/2026-09-17-resilient-billing-design.md`

## Global Constraints

- **The operation is "the lines for this bill are exactly these", not "add these lines".** Every retry problem in this slice comes from having modelled it as an append. The RPC must be safe to call once or five times with the same basket and leave identical rows.
- **`line_total` is computed server-side** as `round(qty_kg * unit_price, 2)`. A client-supplied `line_total` must be ignored entirely — it is not in the RPC's input at all.
- **`unit_price` is still taken from the request**, NOT read from `items`. The price at the moment of recording is the correct price; reading the live price would let an admin's mid-bill edit change a basket already on screen.
- **The status guard is load-bearing.** `replace_bill_lines` must refuse any bill not in `recording`. A `billed` bill has had its token and total told to the customer, and the WhatsApp message quoting that total is already queued.
- **An empty `p_lines` array is refused**, never treated as "clear the bill". `Bill.tsx` disables Done at zero lines, so an empty basket can only be a bug.
- **Guard order and style follow `supabase/migrations/0003_functions.sql`:** bill exists (locked `for update`) → tenant → role → status. A null `current_vendor_id()` means a service-role/superuser caller and passes through; a non-null one must match. This is deliberate and is how `issue_token` and `complete_bill` both behave.
- **`SECURITY DEFINER`, `set search_path = public`**, `revoke all ... from public, anon`, `grant execute ... to authenticated`.
- **Data modules never filter by `vendor_id` on reads.** RLS is the boundary; a client filter is a weaker second copy of the policy.
- **Route guards are UX, not security** — never add an authorization decision to `web/src/routes.ts`.
- **Every user-visible string is an i18n key** added to all three of `web/src/i18n/{en,hi,mr}.json`. The hi/mr values are AI-written and never native-reviewed; match the existing tone, and leave no key missing from any file.
- DB tests: `npm test` at the repo root (145 passing today). Web tests: `cd web && npm test` (371 passing today). Build: `cd web && npm run build` (runs `tsc --noEmit` then vite).
- A clean local `tsc` is NOT proof CI is clean — TypeScript 7 here is a per-platform native binary and CI's Linux build has rejected code Windows accepted.
- Commit messages end with `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`.

---

### Task 1: The `replace_bill_lines` RPC

**Files:**
- Create: `supabase/migrations/0015_replace_bill_lines.sql`
- Create: `tests/replace_bill_lines.test.mjs`
- Modify: `tests/run.mjs` (register the new test file)

**Interfaces:**
- Consumes: `current_vendor_id()`, `current_user_role()` from `0002_rls.sql`; the `bills` and `bill_items` tables from `0001_schema.sql`.
- Produces: `replace_bill_lines(p_bill_id uuid, p_lines jsonb) returns void`, executable by `authenticated`. `p_lines` is a JSON array of objects `{ item_id uuid, qty_kg numeric, unit_price numeric }` — no `line_total`.

- [ ] **Step 1: Write the failing tests**

Create `tests/replace_bill_lines.test.mjs`:

```javascript
import { test, assert, assertEqual, assertDenied, once } from "./framework.mjs";
import { sql } from "./fixtures.mjs";
import { seedTwoVendors } from "./seed.mjs";

const getWorld = once(seedTwoVendors);

/** A fresh vendor with its own item, customer and one recording bill. Isolated per test
 *  so a replace in one cannot be seen by another. */
async function freshBill() {
  const { rows: [v] } = await sql(`insert into vendors (name) values ('Replace Co') returning id`);
  const { rows: [i1] } = await sql(
    `insert into items (vendor_id, name_en, price, stock_kg) values ($1,'Tomato',40,100) returning id`,
    [v.id]);
  const { rows: [i2] } = await sql(
    `insert into items (vendor_id, name_en, price, stock_kg) values ($1,'Onion',32,100) returning id`,
    [v.id]);
  const { rows: [c] } = await sql(
    `insert into customers (vendor_id, name, flat_no, mobile)
     values ($1,'Rep','D-1','+919777800001') returning id`, [v.id]);
  const { rows: [b] } = await sql(
    `insert into bills (vendor_id, customer_id, total, status)
     values ($1,$2,0,'recording') returning id`, [v.id, c.id]);
  return { vendorId: v.id, itemA: i1.id, itemB: i2.id, customerId: c.id, billId: b.id };
}

const basket = (w) => JSON.stringify([
  { item_id: w.itemA, qty_kg: 2.5, unit_price: 40 },
  { item_id: w.itemB, qty_kg: 1, unit_price: 32 },
]);

const linesOf = async (billId) =>
  (await sql(`select item_id, qty_kg, unit_price, line_total from bill_items
               where bill_id = $1 order by line_total desc`, [billId])).rows;

test("replace_bill_lines called twice with the same basket leaves one copy", async () => {
  // THE test this slice exists for. A lost reply after a committed write makes the client
  // send the same basket again; an append would leave four rows and a doubled total, and
  // nothing downstream could tell -- the doubled total IS the total.
  const w = await freshBill();
  await sql(`select replace_bill_lines($1, $2::jsonb)`, [w.billId, basket(w)]);
  await sql(`select replace_bill_lines($1, $2::jsonb)`, [w.billId, basket(w)]);
  const rows = await linesOf(w.billId);
  assertEqual(rows.length, 2, "a repeated call must not append a second copy");
  assertEqual(Number(rows[0].line_total), 100, "tomato line");
  assertEqual(Number(rows[1].line_total), 32, "onion line");
});

test("replace_bill_lines replaces rather than accumulates when the basket changes", async () => {
  // A recorder who removes an item and presses Done again must not leave the removed
  // item on the bill.
  const w = await freshBill();
  await sql(`select replace_bill_lines($1, $2::jsonb)`, [w.billId, basket(w)]);
  await sql(`select replace_bill_lines($1, $2::jsonb)`,
    [w.billId, JSON.stringify([{ item_id: w.itemA, qty_kg: 1, unit_price: 40 }])]);
  const rows = await linesOf(w.billId);
  assertEqual(rows.length, 1, "the old lines should be gone");
  assertEqual(rows[0].item_id, w.itemA, "wrong line survived");
  assertEqual(Number(rows[0].line_total), 40, "line_total not recomputed for the new basket");
});

test("replace_bill_lines computes line_total and ignores any the caller sends", async () => {
  // The forged-total hole: issue_token sums stored line_totals, so a crafted request
  // could otherwise set a bill's total to anything.
  const w = await freshBill();
  await sql(`select replace_bill_lines($1, $2::jsonb)`, [w.billId, JSON.stringify([
    { item_id: w.itemA, qty_kg: 5, unit_price: 40, line_total: 1 },
  ])]);
  const rows = await linesOf(w.billId);
  assertEqual(Number(rows[0].line_total), 200, "line_total must be qty x price, not the sent 1");
});

test("replace_bill_lines rounds the way billing.ts does", async () => {
  // runningTotal() is what the recorder reads off the screen; issue_token sums the stored
  // rows. If these two round differently the token screen and the printed receipt differ
  // from the basket by a paisa. Expected values are what Math.round(p*q*100)/100 gives.
  const w = await freshBill();
  await sql(`select replace_bill_lines($1, $2::jsonb)`, [w.billId, JSON.stringify([
    { item_id: w.itemA, qty_kg: 0.05, unit_price: 2.5 },   // 0.125  -> 0.13
    { item_id: w.itemB, qty_kg: 3,    unit_price: 33.33 }, // 99.99  -> 99.99
  ])]);
  const { rows } = await sql(
    `select line_total from bill_items where bill_id = $1 order by line_total`, [w.billId]);
  assertEqual(Number(rows[0].line_total), 0.13, "half-way value rounded differently from JS");
  assertEqual(Number(rows[1].line_total), 99.99, "exact value drifted");
});

test("replace_bill_lines refuses a bill that is no longer recording", async () => {
  // A billed bill has had its token and total told to the customer, and the WhatsApp
  // message quoting that total is queued. Rewriting its lines would make both a lie.
  const w = await freshBill();
  await sql(`select replace_bill_lines($1, $2::jsonb)`, [w.billId, basket(w)]);
  await sql(`select issue_token($1)`, [w.billId]);
  let raised = null;
  try {
    await sql(`select replace_bill_lines($1, $2::jsonb)`, [w.billId, basket(w)]);
  } catch (e) { raised = e; }
  assert(raised !== null, "expected the replace to be refused on a billed bill");
  assert(/expected recording/.test(raised.message), `wrong error: ${raised.message}`);
  assertEqual((await linesOf(w.billId)).length, 2, "the billed bill's lines must be untouched");
});

test("replace_bill_lines refuses an empty basket", async () => {
  // Accepting it would let a retry turn a real bill into a zero-rupee one.
  const w = await freshBill();
  await sql(`select replace_bill_lines($1, $2::jsonb)`, [w.billId, basket(w)]);
  let raised = null;
  try {
    await sql(`select replace_bill_lines($1, '[]'::jsonb)`, [w.billId]);
  } catch (e) { raised = e; }
  assert(raised !== null, "expected an empty basket to be refused");
  assertEqual((await linesOf(w.billId)).length, 2, "the existing lines must survive a refusal");
});

test("a recorder cannot replace another vendor's bill lines", async () => {
  // Through a signed-in client, so current_vendor_id() is non-null and the tenant guard
  // actually fires. Called as superuser it would pass through by design.
  const w = await getWorld();
  const { rows: [b] } = await sql(
    `insert into bills (vendor_id, customer_id, total, status)
     values ($1,$2,0,'recording') returning id`, [w.b.vendorId, w.b.customerId]);
  const { error } = await w.a.clients.recorder.rpc("replace_bill_lines", {
    p_bill_id: b.id,
    p_lines: [{ item_id: w.b.itemId, qty_kg: 1, unit_price: 10 }],
  });
  assertDenied(error, "a recorder reached across the tenant boundary");
});

test("a biller may not replace bill lines", async () => {
  const w = await getWorld();
  const { rows: [b] } = await sql(
    `insert into bills (vendor_id, customer_id, total, status)
     values ($1,$2,0,'recording') returning id`, [w.a.vendorId, w.a.customerId]);
  const { error } = await w.a.clients.biller.rpc("replace_bill_lines", {
    p_bill_id: b.id,
    p_lines: [{ item_id: w.a.itemId, qty_kg: 1, unit_price: 10 }],
  });
  assertDenied(error, "a biller was allowed to rewrite a basket");
});
```

- [ ] **Step 2: Register the test file**

In `tests/run.mjs`, add after the existing `import "./stock_requests.test.mjs";` line:

```javascript
import "./replace_bill_lines.test.mjs";
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npm test`
Expected: FAIL — `function replace_bill_lines(uuid, jsonb) does not exist`.

- [ ] **Step 4: Write the migration**

Create `supabase/migrations/0015_replace_bill_lines.sql`:

```sql
-- Slice B: make the line-write safe to repeat.
--
-- The client used to say "add these lines". That cannot be repeated safely: a reply lost
-- after a committed insert leads the retry to insert the same basket again, issue_token
-- recomputes a doubled total, and the customer is asked to pay twice for one basket.
-- Nothing downstream can detect it -- the doubled total IS the total, on every screen and
-- on the printed receipt.
--
-- data.ts carried a check-then-insert mitigation (billHasLines) and its own comment said
-- what this is: "a mitigation, not a fix". The check is not atomic with the insert, so a
-- request still genuinely in flight defeats it.
--
-- This function says "the lines for this bill are exactly these" instead. Delete and
-- insert in one transaction is idempotent by construction: called once or five times with
-- the same basket, the rows are identical. The retry needs no cleverness at all, which is
-- why the client loses code rather than gaining a layer.
create function replace_bill_lines(p_bill_id uuid, p_lines jsonb)
  returns void
  language plpgsql security definer set search_path = public as $$
declare
  v_bill bills%rowtype;
begin
  select * into v_bill from bills where id = p_bill_id for update;
  if not found then
    raise exception 'bill % not found', p_bill_id;
  end if;

  -- Same trust decision as issue_token() and complete_bill(): a null current_vendor_id()
  -- means the caller has no end-user session (service role, or the superuser connection
  -- the test suite uses), which is allowed; a non-null one must own this bill. A biller
  -- has no business rewriting a basket, so only admin and recorder pass -- the same pair
  -- issue_token() accepts.
  if current_vendor_id() is not null and current_vendor_id() <> v_bill.vendor_id then
    raise exception 'bill % does not belong to your vendor', p_bill_id;
  end if;
  if current_vendor_id() is not null and current_user_role() not in ('admin', 'recorder') then
    raise exception 'role % may not record bill lines', current_user_role();
  end if;

  -- The bill's own lifecycle is what makes a DESTRUCTIVE replace safe. Past 'recording'
  -- the customer has been handed a token and told a total, and the outbound_messages row
  -- quoting that total is already queued (0003_functions.sql:54-56). Rewriting the lines
  -- then would make both of those a lie, and issue_token's guard cannot catch it because
  -- issue_token has already run.
  if v_bill.status <> 'recording' then
    raise exception 'bill % is %, expected recording', p_bill_id, v_bill.status;
  end if;

  -- Refused, never treated as "clear the bill". Bill.tsx disables Done at zero lines, so
  -- an empty basket can only be a bug -- and accepting one would let a retry turn a real
  -- bill into a zero-rupee one.
  if jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) = 0 then
    raise exception 'refusing to leave bill % with no lines', p_bill_id;
  end if;

  delete from bill_items where bill_id = p_bill_id;

  -- line_total is COMPUTED here, and is deliberately absent from the input. issue_token
  -- sums the stored line_totals, so a client-supplied one let a crafted request set a
  -- bill's total to anything -- RLS stops another vendor's data being touched, but not a
  -- recorder's own client sending line_total 1 for 5kg of tomatoes.
  --
  -- unit_price is still the caller's, NOT items.price. The price at the moment of
  -- recording is the correct price; reading the live one would let an admin editing a
  -- price mid-bill change a basket already on the recorder's screen.
  --
  -- round(x, 2) matches billing.ts's Math.round(x * 100) / 100 for every value the app can
  -- produce (validateWeight caps qty at two decimals). The two must agree: runningTotal()
  -- is what the recorder reads off the screen, and issue_token sums these rows.
  insert into bill_items (bill_id, vendor_id, item_id, qty_kg, unit_price, line_total)
  select p_bill_id, v_bill.vendor_id, l.item_id, l.qty_kg, l.unit_price,
         round(l.qty_kg * l.unit_price, 2)
    from jsonb_to_recordset(p_lines)
      as l(item_id uuid, qty_kg numeric, unit_price numeric);
end $$;

revoke all on function replace_bill_lines(uuid, jsonb) from public, anon;
grant execute on function replace_bill_lines(uuid, jsonb) to authenticated;
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm test`
Expected: PASS — 153 cases (145 + 8).

- [ ] **Step 6: Commit**

```bash
git add supabase/migrations/0015_replace_bill_lines.sql tests/replace_bill_lines.test.mjs tests/run.mjs
git commit -m "feat(db): replace a recording bill's lines in one transaction

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 2: `replaceBillLines` in the data layer

**Files:**
- Modify: `web/src/data.ts` (replace `addLines`, delete `billHasLines`)
- Test: `web/src/__tests__/data.test.ts`

**Interfaces:**
- Consumes: `replace_bill_lines(p_bill_id uuid, p_lines jsonb)` from Task 1.
- Produces: `export async function replaceBillLines(billId: string, lines: readonly Draft[])`, returning the PostgREST `.rpc()` result. `addLines` and `billHasLines` no longer exist.

- [ ] **Step 1: Write the failing test**

In `web/src/__tests__/data.test.ts`, delete the existing `addLines` and `billHasLines` describe blocks and add:

```typescript
describe("replaceBillLines", () => {
  it("sends the basket without any line_total", async () => {
    // line_total is computed in the function. Sending one would be ignored, and having it
    // in the payload would suggest the client's figure still matters.
    await replaceBillLines("b1", [
      { itemId: "i1", name: "Tomato", unitPrice: 40, qtyKg: 2.5 },
    ]);
    expect(rpc).toHaveBeenCalledWith("replace_bill_lines", {
      p_bill_id: "b1",
      p_lines: [{ item_id: "i1", qty_kg: 2.5, unit_price: 40 }],
    });
  });

  it("does not send a vendor id", async () => {
    // The function reads vendor_id off the bill. Sending one would be a weaker second
    // copy of a value the server already holds authoritatively.
    await replaceBillLines("b1", [
      { itemId: "i1", name: "Tomato", unitPrice: 40, qtyKg: 1 },
    ]);
    const args = rpc.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(Object.keys(args)).toEqual(["p_bill_id", "p_lines"]);
  });

  it("carries every line of a multi-item basket in order", async () => {
    await replaceBillLines("b1", [
      { itemId: "i1", name: "Tomato", unitPrice: 40, qtyKg: 2.5 },
      { itemId: "i2", name: "Onion", unitPrice: 32, qtyKg: 1 },
    ]);
    const args = rpc.mock.calls[0]?.[1] as { p_lines: unknown[] };
    expect(args.p_lines).toEqual([
      { item_id: "i1", qty_kg: 2.5, unit_price: 40 },
      { item_id: "i2", qty_kg: 1, unit_price: 32 },
    ]);
  });
});
```

Add `replaceBillLines` to the file's existing `await import("../data")` destructure, and remove `addLines`/`billHasLines` from it. If the file's supabase mock has no `rpc` spy, add one in the same shape `history.test.ts` uses: `const rpc = vi.fn(async () => ({ data: null, error: null }));` exposed on the mocked `supabase` object.

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd web && npm test -- data.test`
Expected: FAIL — `replaceBillLines is not a function`.

- [ ] **Step 3: Implement**

In `web/src/data.ts`, delete `billHasLines` entirely and replace `addLines` with:

```typescript
/**
 * Sets a recording bill's lines to exactly these.
 *
 * Safe to call again after a lost response: replace_bill_lines (0015) deletes and inserts
 * in one transaction, so a retry converges on the same rows instead of appending a second
 * copy. This is what replaced addLines + billHasLines -- the old pair could only narrow
 * the double-insert window, never close it, because the check was not atomic with the
 * insert.
 *
 * No vendor_id: the function reads it off the bill. No line_total: the function computes
 * it, so a client-supplied one cannot forge a bill's total.
 */
export async function replaceBillLines(billId: string, lines: readonly Draft[]) {
  return supabase.rpc("replace_bill_lines", {
    p_bill_id: billId,
    p_lines: lines.map((l) => ({
      item_id: l.itemId,
      qty_kg: l.qtyKg,
      unit_price: l.unitPrice,
    })),
  });
}
```

If `lineTotal` is now unused in `data.ts`, remove it from the `./billing` import — `tsc` will flag it. Do not delete `lineTotal` from `billing.ts`; `runningTotal` uses it and it remains the on-screen figure.

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd web && npm test -- data.test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add web/src/data.ts web/src/__tests__/data.test.ts
git commit -m "feat: replace a bill's lines in one call instead of appending

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 3: Simplify `Bill.tsx`'s retry

**Files:**
- Modify: `web/src/screens/Bill.tsx`
- Test: `web/src/__tests__/Bill.test.tsx`

**Interfaces:**
- Consumes: `replaceBillLines(billId, lines)` from Task 2.
- Produces: nothing other tasks depend on.

- [ ] **Step 1: Update the test file's mock and rewrite the retry tests**

In `web/src/__tests__/Bill.test.tsx`, change the `vi.mock("../data", ...)` factory: remove the `addLines` and `billHasLines` entries, add

```typescript
  replaceBillLines: vi.fn(async () => ({ data: null, error: null })),
```

Update the existing assertion at roughly line 102 (`expect(data.addLines).toHaveBeenCalledWith("v1", "b1", [...])`) to the new shape:

```typescript
    expect(data.replaceBillLines).toHaveBeenCalledWith("b1", [
      { itemId: "i1", name: expect.any(String), unitPrice: 40, qtyKg: 2 },
    ]);
```

Replace the test named `"does not insert lines twice on retry when the first addLines actually committed"` (roughly lines 266-297) entirely with:

```typescript
  it("re-sends the whole basket on retry, and the replace makes that safe", async () => {
    // The old flow asked "did my lines already land?" before re-sending, a check that was
    // never atomic with the insert. replace_bill_lines is idempotent, so the retry simply
    // sends the basket again -- and the bill must still be the SAME bill, because
    // createBill is the one step that must not repeat.
    (data.replaceBillLines as unknown as Mock).mockResolvedValueOnce({
      data: null, error: { message: "Failed to fetch" },
    });

    render(<Bill />);
    fireEvent.click(await screen.findByText("Asha"));
    fireEvent.change(await screen.findByTestId("item-select"), { target: { value: "i1" } });
    fireEvent.change(await screen.findByTestId("weight-input"), { target: { value: "2" } });
    fireEvent.click(screen.getByTestId("add-line"));
    fireEvent.click(screen.getByTestId("bill-done"));
    fireEvent.click(await screen.findByTestId("bill-confirm"));
    await screen.findByTestId("bill-failure");

    // Retry.
    fireEvent.click(screen.getByTestId("bill-done"));
    fireEvent.click(await screen.findByTestId("bill-confirm"));
    await screen.findByTestId("bill-token");

    expect(data.replaceBillLines).toHaveBeenCalledTimes(2);
    expect(data.createBill).toHaveBeenCalledTimes(1);
    // Both calls carried the same bill id and the same basket.
    expect((data.replaceBillLines as unknown as Mock).mock.calls[0]?.[0]).toBe("b1");
    expect((data.replaceBillLines as unknown as Mock).mock.calls[1]?.[0]).toBe("b1");
  });
```

Also update the test at roughly line 179 (`"surfaces a failed token, and the retry resumes rather than creating a second bill"`): its `expect(data.addLines).toHaveBeenCalledTimes(1)` becomes

```typescript
    expect(data.replaceBillLines).toHaveBeenCalledTimes(2);
```

because the replace is now unconditional on every attempt — that is the point of the change, not a regression. Add a comment in the test saying exactly that.

If any testid named above (`bill-done`, `bill-confirm`, `bill-failure`, `bill-token`, `add-line`, `item-select`, `weight-input`) does not match what `Bill.tsx` and the existing tests actually use, use the real ones — read the file rather than trusting these names.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd web && npm test -- Bill.test`
Expected: FAIL — `replaceBillLines is not a function` / the old assertions no longer match.

- [ ] **Step 3: Simplify `confirm()`**

In `web/src/screens/Bill.tsx`:

Change the import from `addLines, billHasLines` to `replaceBillLines`.

Narrow the state declaration:

```typescript
  // What of the write has already landed. A retry RESUMES from here: re-running
  // createBill would orphan the first bill in `recording` with its lines attached, and
  // issue_token's own guard cannot catch that -- it is a different bill.
  //
  // Only the bill id is tracked. How far the LINE write got no longer matters:
  // replaceBillLines is idempotent, so the retry just sends the basket again.
  const [written, setWritten] = useState<{ billId: string } | null>(null);
```

Replace the whole `const resuming = ...` line and the `if (!written?.linesAdded) { ... }` block with:

```typescript
    // Unconditional, first attempt or fifth. replace_bill_lines (0015) deletes and inserts
    // in one transaction, so re-sending converges on the same rows rather than appending a
    // second copy -- which is what the old check-then-insert could only narrow, never
    // close.
    const { error: linesError } = await replaceBillLines(billId, lines);
    if (linesError) {
      return fail(describeError(linesError));
    }
```

Update the two `setWritten({ billId, linesAdded: ... })` calls to `setWritten({ billId })`. The `createBill` branch, the `issueToken` call and the whole token read-back below it are unchanged.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd web && npm test -- Bill.test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add web/src/screens/Bill.tsx web/src/__tests__/Bill.test.tsx
git commit -m "feat: re-send the basket on retry instead of checking whether it landed

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 4: The completion read-back in `Pending.tsx`

**Files:**
- Modify: `web/src/screens/Pending.tsx`
- Modify: `web/src/i18n/en.json`, `hi.json`, `mr.json`
- Test: `web/src/__tests__/Pending.test.tsx`

**Interfaces:**
- Consumes: `billToken(billId)` from `web/src/data.ts`, which already returns `{ token_no, status }` — reused rather than adding a second near-identical read.
- Produces: nothing other tasks depend on.

- [ ] **Step 1: Add the locale keys**

To the `pending` block of `web/src/i18n/en.json`:

```json
"completionUnknown": "This bill may or may not have completed. Check the completed list before completing it again."
```

`hi.json`:

```json
"completionUnknown": "यह बिल पूरा हुआ या नहीं, पक्का नहीं है. दोबारा पूरा करने से पहले पूरी हुई सूची देखें."
```

`mr.json`:

```json
"completionUnknown": "हे बिल पूर्ण झाले की नाही हे नक्की नाही. पुन्हा पूर्ण करण्यापूर्वी पूर्ण झालेल्यांची यादी पाहा."
```

- [ ] **Step 2: Write the failing tests**

Append to `web/src/__tests__/Pending.test.tsx`, following how its existing tests render the screen and drive a completion. Add `billToken: vi.fn(async () => ({ data: null, error: null }))` to its `vi.mock("../data", ...)` factory if absent.

```typescript
  it("treats a lost reply on an already-completed bill as success", async () => {
    // complete_bill may have committed and had its reply lost. Bill.tsx already reads back
    // after a lost issue_token reply; this is the same trick in the place it was missing.
    // Reporting failure here is what makes a biller re-record the sale by hand, moving
    // stock twice and awarding points twice.
    (data.completeBill as Mock).mockResolvedValueOnce({
      error: { message: "Failed to fetch" },
    });
    (data.billToken as Mock).mockResolvedValueOnce({
      data: { token_no: 7, status: "done" }, error: null,
    });

    renderPending();
    fireEvent.click(await screen.findByTestId("pending-complete-b1"));
    fireEvent.click(await screen.findByTestId("pending-confirm-b1"));

    await screen.findByTestId("pending-completed");
    expect(screen.queryByTestId("pending-failure")).toBeNull();
  });

  it("reports a genuine failure when the bill is still billed", async () => {
    (data.completeBill as Mock).mockResolvedValueOnce({
      error: { message: "Failed to fetch" },
    });
    (data.billToken as Mock).mockResolvedValueOnce({
      data: { token_no: 7, status: "billed" }, error: null,
    });

    renderPending();
    fireEvent.click(await screen.findByTestId("pending-complete-b1"));
    fireEvent.click(await screen.findByTestId("pending-confirm-b1"));

    await screen.findByTestId("pending-failure");
    expect(screen.queryByTestId("pending-completed")).toBeNull();
  });

  it("says plainly that it does not know when the read-back itself fails", async () => {
    // The honest answer is the useful one: a biller told "we are not sure" checks the
    // completed list, where one told "failed" re-records the sale.
    (data.completeBill as Mock).mockResolvedValueOnce({
      error: { message: "Failed to fetch" },
    });
    (data.billToken as Mock).mockResolvedValueOnce({
      data: null, error: { message: "Failed to fetch" },
    });

    renderPending();
    fireEvent.click(await screen.findByTestId("pending-complete-b1"));
    fireEvent.click(await screen.findByTestId("pending-confirm-b1"));

    await screen.findByTestId("pending-completion-unknown");
    // The failure banner stands alongside it -- never in place of it.
    expect(screen.queryByTestId("pending-failure")).not.toBeNull();
  });
```

If the real testids differ from `pending-complete-b1`, `pending-confirm-b1`, `pending-completed`, `pending-failure`, use the ones the file already uses. Only `pending-completion-unknown` is new and fixed by this plan.

- [ ] **Step 3: Run the tests to verify they fail**

Run: `cd web && npm test -- Pending.test`
Expected: FAIL — the first test finds `pending-failure` instead of `pending-completed`.

- [ ] **Step 4: Implement the read-back**

In `web/src/screens/Pending.tsx`, import `billToken` from `../data` and add state beside the existing failure state:

```typescript
  // Set only when the read-back after a failed completion ITSELF failed: we genuinely do
  // not know whether the bill completed. Rendered alongside the failure banner, never in
  // place of it -- the same shape as Bill.tsx's tokenUnknown.
  const [completionUnknown, setCompletionUnknown] = useState(false);
```

Clear it at the top of `confirm()` alongside the other resets (`setCompletionUnknown(false)`), then replace the error branch:

```typescript
    const { error } = await completeBill(id, points);
    if (error) {
      // complete_bill may have committed and had its reply lost. Read back what the
      // server actually recorded rather than trusting the lost reply -- reporting a
      // failure for a sale that succeeded is what makes a biller re-record it by hand,
      // moving stock twice and awarding points twice. complete_bill is idempotent by
      // guard, so a retry is safe either way; this is about what the biller is TOLD.
      const { data: readBack, error: readError } = await billToken(id);
      if (!readError && readBack && readBack.status === "done") {
        // It worked. Fall through to the normal completion path below.
      } else {
        if (readError) {
          // The same problem one layer down. Do not claim success and do not claim
          // failure -- say so, and leave the failure banner up as well.
          setCompletionUnknown(true);
        }
        setFailure(describeError(error));
        setCompletingId(null);
        return;
      }
    }
```

Render the new message beside the existing failure banner:

```tsx
      {completionUnknown && (
        <p data-testid="pending-completion-unknown" className="text-xs text-amber-700">
          {t("pending.completionUnknown")}
        </p>
      )}
```

Place it immediately after the element carrying `pending-failure`, matching how `Bill.tsx` renders `bill.tokenUnknown` after its failure banner.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd web && npm test -- Pending.test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add web/src/screens/Pending.tsx web/src/i18n web/src/__tests__/Pending.test.tsx
git commit -m "fix: ask what happened before telling a biller the sale failed

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 5: Verify the slice together, and record what no test covers

**Files:**
- Modify: `README.md`

**Interfaces:**
- Consumes: everything above.
- Produces: nothing.

- [ ] **Step 1: Run the full verification**

```bash
cd web && npm run build
cd .. && npm test
cd web && npm test
```

Expected: `tsc --noEmit` clean, vite build succeeds, 153 DB cases pass, the web suite passes.

**This is the first time the whole slice is typechecked together** — the per-file vitest runs do not do it, and on the previous slice exactly this step caught a cross-task type error that every per-task review had missed. If `tsc` reports errors, report them and stop rather than refactoring on your own judgement.

A clean local `tsc` is NOT proof CI is clean: TypeScript 7 here is a per-platform native binary and CI's Linux build has rejected code Windows accepted.

- [ ] **Step 2: Add the note to the README's known unknowns**

Append to the "Known unknowns" section of `README.md`:

```markdown
- **No test pulls a cable.** `replace_bill_lines` is provably safe to repeat — the DB
  suite calls it twice and asserts one copy of the lines — and both screens are tested
  against a simulated lost reply. But an actual mid-flight network drop on the Tokyo link
  is verified by reasoning, not by a test. What the tests establish is that repeating the
  call cannot corrupt a bill, which is the property that makes the reasoning sound.
```

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs: record that no test exercises a real network drop

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Deployment

Migration 0015 must reach Cloud. `supabase db push` 401s from this machine, so it is applied by hand in the SQL editor — **confirm which project the editor is on first** (`select jobname from cron.job;` shows `vendor-app-*` rather than `onevio-*`), then **insert the tracking row**, which a hand-applied migration does not write for itself:

```sql
insert into supabase_migrations.schema_migrations (version) values ('0015');
```

Without that row, the next working `db push` retries 0015 and fails on a duplicate function.

**Order matters for this slice.** The client stops calling `addLines` and starts calling an RPC that does not exist in production until 0015 is applied. Apply the migration BEFORE pushing the branch, or every bill breaks at the line-write step between the two. `describeError` maps a missing function to `error.migrationMissing` ("This screen needs a database update that has not been applied yet"), so the failure is legible rather than mysterious — but it is still a shop unable to record a sale.
