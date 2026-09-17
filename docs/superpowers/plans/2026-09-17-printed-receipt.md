# Printed Receipt Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the customer a 58mm printed slip for a completed bill, carrying the token, the lines, what was paid, and what the points did.

**Architecture:** One HTML render at a staff-only route `/receipt/:billId`, styled for 58mm paper by a `@media print` block, printed via `window.print()`. A new `web/src/receipt.ts` data module composes the bill, its lines, the customer, the shop header, the points earned and the balance into one finished `Receipt` object; the screen does no arithmetic. One migration adds the shop address and phone that `vendors` lacks.

**Tech Stack:** React 19 + react-router-dom 7, TypeScript 7, Vitest 5 + @testing-library/react, Tailwind 4, Supabase JS 2 (PostgREST), PostgreSQL (native, via `node tests/run.mjs`).

**Spec:** `docs/superpowers/specs/2026-09-17-receipt-design.md`

## Global Constraints

- **Paper width is 58mm, about 32 characters.** Item lines are two lines each: name, then `qty x rate  amount`.
- **`bills.total` stores the NET.** Gross is `total + redeemed_points`. Computed once, named `gross`, never inline in JSX.
- **PostgREST serialises `numeric` as a string.** `total`, `line_total`, `unit_price` and `qty_kg` arrive as text; coerce at the `receipt.ts` boundary with `Number(...)`.
- **Points are earned on the NET**, after redemption (`complete_bill`, migration 0010). Never recompute the threshold rule client-side — read `points_ledger`.
- **Data modules never filter by `vendor_id` on reads.** RLS scopes every query; a client filter is a weaker second copy of the policy. Same rule as `data.ts`, `admin.ts`, `history.ts`, `requests.ts`.
- **Route guards in `routes.ts` are UX, not security.** Never put an authorization decision there.
- **Every user-visible string is an i18n key** added to all three of `web/src/i18n/en.json`, `hi.json`, `mr.json`. The hi/mr values are AI-written and have never been native-reviewed; match the existing tone and do not leave a key missing from any file.
- **Money is formatted with `rupees()` from `web/src/money.ts`** — it fixes two decimals and Indian digit grouping.
- **Item names come from `itemName(item, lang)` in `web/src/i18n/locales.ts`**, which falls back to English when a translation is blank.
- **Tailwind classes for tap targets keep `min-h-[44px]`**, matching every existing button.
- Web tests: `cd web && npm test` (vitest). DB tests: `npm test` at the repo root (`node tests/run.mjs`, 142 cases today).
- Commit messages end with `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`.

---

### Task 1: Migration — shop address and phone on `vendors`

**Files:**
- Create: `supabase/migrations/0014_vendor_shop_details.sql`
- Modify: `tests/schema.test.mjs` (append two cases)
- Test: `tests/schema.test.mjs`

**Interfaces:**
- Consumes: nothing.
- Produces: columns `vendors.address text` (nullable) and `vendors.phone text` (nullable), readable by any authenticated member of the vendor and writable by admin under the existing `vendors_admin_update` policy.

- [ ] **Step 1: Write the failing tests**

Append to `tests/schema.test.mjs`:

```javascript
test("vendors carries a nullable address and phone for the receipt header", async () => {
  const { rows } = await sql(
    `select column_name, is_nullable, data_type from information_schema.columns
      where table_schema='public' and table_name='vendors'
        and column_name in ('address','phone')`
  );
  assertEqual(rows.length, 2, "expected address and phone on vendors");
  for (const r of rows) {
    assertEqual(r.is_nullable, "YES", `${r.column_name} must stay nullable`);
    assertEqual(r.data_type, "text", `${r.column_name} must be text`);
  }
});

test("a vendor created without shop details is still valid", async () => {
  // Nullable is the whole point: every vendor row predating 0014 has neither, and the
  // slip omits a blank line rather than refusing to render.
  const { rows } = await sql(
    `insert into vendors (name) values ('No Details Co') returning address, phone`
  );
  assertEqual(rows[0].address, null, "address defaults to null");
  assertEqual(rows[0].phone, null, "phone defaults to null");
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL — `expected address and phone on vendors: expected 2, got 0`.

- [ ] **Step 3: Write the migration**

Create `supabase/migrations/0014_vendor_shop_details.sql`:

```sql
-- The printed receipt's shop header (Slice A).
--
-- vendors has carried only the shop name and the loyalty config. A slip that says who
-- the shop is needs an address and a phone number, and neither existed anywhere.
--
-- Both NULLABLE, deliberately. Every existing vendor row has neither, and a NOT NULL
-- column would have to invent a value for them. The receipt omits a line that is blank
-- rather than printing an empty one, so null is a renderable state, not a missing one.
alter table vendors
  add column address text,
  add column phone   text;

comment on column vendors.address is
  'Shop address for the printed receipt header. Nullable: the slip omits the line when '
  'blank. Free text, not parsed -- it is printed as typed, wrapped to 58mm.';

comment on column vendors.phone is
  'Shop phone for the printed receipt header. Nullable, free text, printed as typed. '
  'Not the WhatsApp sender number, which is a Gupshup app secret and not per-vendor.';

-- No new policy. vendors_admin_read and vendors_admin_update in 0002_rls.sql already
-- cover the whole row, so these two columns inherit exactly the boundary the loyalty
-- config has had since 0001.
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: PASS — 144 cases (142 + 2).

- [ ] **Step 5: Pin the balance RPC's tenant guard**

The receipt calls `customer_points_balance`, which is `SECURITY DEFINER` and deliberately
crosses tenants when `current_vendor_id()` is null (the WhatsApp webhook calls it as
`service_role` after matching a phone number itself). From a signed-in biller that value
is non-null, so the guard must fire. That is an assertion, not a comment.

Append to `tests/points_balance.test.mjs`, following that file's existing two-vendor
fixture and its signed-in client helper:

```javascript
test("a signed-in biller cannot read another vendor's customer balance", async () => {
  // The receipt reads this RPC for its points block. If the guard ever stopped firing,
  // a biller could enumerate another shop's customers by id through the slip.
  const { error } = await billerOfVendorA.rpc("customer_points_balance", {
    p_customer_id: customerOfVendorB,
  });
  assertDenied(error, "expected the cross-tenant balance read to be refused");
});
```

Run: `npm test`
Expected: PASS — 145 cases.

- [ ] **Step 6: Commit**

```bash
git add supabase/migrations/0014_vendor_shop_details.sql tests/schema.test.mjs tests/points_balance.test.mjs
git commit -m "feat(db): give vendors a shop address and phone for the receipt header

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 2: Settings — edit the shop details

**Files:**
- Modify: `web/src/admin.ts` (add `loadShopDetails`, `updateShopDetails`)
- Modify: `web/src/screens/Settings.tsx` (a new Shop details section)
- Modify: `web/src/i18n/en.json`, `web/src/i18n/hi.json`, `web/src/i18n/mr.json`
- Test: `web/src/__tests__/admin.test.ts`, `web/src/__tests__/Settings.test.tsx`

**Interfaces:**
- Consumes: `vendors.address` / `vendors.phone` from Task 1.
- Produces:
  - `export type ShopDetails = { address: string | null; phone: string | null }`
  - `export async function loadShopDetails(vendorId: string)` → PostgREST `.maybeSingle()` result whose `data` is `ShopDetails | null`
  - `export async function updateShopDetails(vendorId: string, value: ShopDetails)` → PostgREST update result

These are **separate from** `loadVendorConfig`/`updateVendorConfig` on purpose: the loyalty form runs every field through `validateSettings`, which demands a positive number and rejects a blank. Address and phone are optional free text, so routing them through that validator would make both fields mandatory numbers. Separate state, separate save button, same screen.

- [ ] **Step 1: Write the failing data-module tests**

Append to `web/src/__tests__/admin.test.ts` (the file already mocks `../supabase` with a `from`/`chain` harness — reuse it; add `"maybeSingle"` and `"update"` to its chain key list if they are not present):

```typescript
describe("shop details", () => {
  it("reads only the two header columns", async () => {
    await loadShopDetails("v1");
    expect(from).toHaveBeenCalledWith("vendors");
    expect(chain.select).toHaveBeenCalledWith("address, phone");
    expect(chain.eq).toHaveBeenCalledWith("id", "v1");
  });

  it("writes only address and phone", async () => {
    // vendors_admin_update permits the whole row. Sending exactly two columns is what
    // stops this screen clobbering the loyalty config it does not own.
    await updateShopDetails("v1", { address: "Shop 12, Kothrud", phone: "9876543210" });
    expect(chain.update).toHaveBeenCalledWith({
      address: "Shop 12, Kothrud",
      phone: "9876543210",
    });
  });

  it("stores a blank field as null, not an empty string", async () => {
    // The receipt omits a null line. An empty string would be a present-but-blank value
    // that renders as a stray blank line on every slip.
    await updateShopDetails("v1", { address: "", phone: "  " });
    expect(chain.update).toHaveBeenCalledWith({ address: null, phone: null });
  });
});
```

Import them at the top of the file's existing `await import("../admin")` destructure: add `loadShopDetails, updateShopDetails`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd web && npm test -- admin.test`
Expected: FAIL — `loadShopDetails is not a function`.

- [ ] **Step 3: Implement in `web/src/admin.ts`**

Add below `updateVendorConfig`:

```typescript
export type ShopDetails = { address: string | null; phone: string | null };

const SHOP_COLS = "address, phone";

/** The receipt's shop header (0014). Separate from loadVendorConfig because the two
 *  are edited by different forms with different rules: loyalty values are required
 *  positive numbers, these are optional free text. */
export async function loadShopDetails(vendorId: string) {
  return supabase.from("vendors").select(SHOP_COLS).eq("id", vendorId).maybeSingle();
}

/** Blank becomes NULL, never "". The receipt omits a null line; an empty string is a
 *  present value that prints as a blank line on every slip. */
export async function updateShopDetails(vendorId: string, value: ShopDetails) {
  const blankToNull = (s: string | null) => {
    const trimmed = (s ?? "").trim();
    return trimmed === "" ? null : trimmed;
  };
  return supabase
    .from("vendors")
    .update({ address: blankToNull(value.address), phone: blankToNull(value.phone) })
    .eq("id", vendorId);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd web && npm test -- admin.test`
Expected: PASS.

- [ ] **Step 5: Add the locale keys**

In `web/src/i18n/en.json`, add a `shop` block beside `settings`:

```json
"shop": {
  "section": "Shop details",
  "help": "Printed at the top of every receipt. Leave a field blank to keep it off the slip.",
  "address": "Address",
  "phone": "Phone",
  "save": "Save",
  "saved": "Saved."
}
```

`hi.json`:

```json
"shop": {
  "section": "दुकान की जानकारी",
  "help": "हर रसीद के ऊपर छपती है। किसी हिस्से को रसीद से हटाने के लिए उसे खाली छोड़ें।",
  "address": "पता",
  "phone": "फ़ोन",
  "save": "सेव करें",
  "saved": "सेव हो गया."
}
```

`mr.json`:

```json
"shop": {
  "section": "दुकानाची माहिती",
  "help": "प्रत्येक पावतीच्या वर छापली जाते. एखादा भाग पावतीवर नको असल्यास तो रिकामा ठेवा.",
  "address": "पत्ता",
  "phone": "फोन",
  "save": "सेव्ह करा",
  "saved": "सेव्ह झाले."
}
```

- [ ] **Step 6: Write the failing screen test**

Append to `web/src/__tests__/Settings.test.tsx`, following the file's existing render/mocking setup:

```typescript
it("saves the shop details without touching the loyalty config", async () => {
  renderSettings();
  const address = await screen.findByTestId("shop-address");
  fireEvent.change(address, { target: { value: "Shop 12, Kothrud, Pune" } });
  fireEvent.change(screen.getByTestId("shop-phone"), { target: { value: "9876543210" } });
  fireEvent.click(screen.getByTestId("shop-save"));

  await screen.findByTestId("shop-saved");
  expect(updateShopDetails).toHaveBeenCalledWith("v1", {
    address: "Shop 12, Kothrud, Pune",
    phone: "9876543210",
  });
  // The two forms share a screen, not a workflow.
  expect(updateVendorConfig).not.toHaveBeenCalled();
});
```

Add `updateShopDetails` and `loadShopDetails` to the file's existing `vi.mock("../admin", ...)` factory, with `loadShopDetails` resolving `{ data: { address: null, phone: null }, error: null }`.

- [ ] **Step 7: Run it to verify it fails**

Run: `cd web && npm test -- Settings.test`
Expected: FAIL — unable to find an element by `[data-testid="shop-address"]`.

- [ ] **Step 8: Add the Shop details section to `Settings.tsx`**

Import `loadShopDetails, updateShopDetails, type ShopDetails` from `../admin`. Add state and an effect beside the existing loyalty ones:

```typescript
const [shop, setShop] = useState<ShopDetails>({ address: "", phone: "" });
const [shopSaved, setShopSaved] = useState(false);
const [shopProblem, setShopProblem] = useState<{ key: string; detail: string } | null>(null);
const [shopBusy, setShopBusy] = useState(false);

useEffect(() => {
  if (!vendorId) return;
  void (async () => {
    const { data, error } = await loadShopDetails(vendorId);
    setShopProblem(describeError(error));
    // Null columns become "" for the inputs; updateShopDetails maps them back to null.
    if (data) setShop({ address: data.address ?? "", phone: data.phone ?? "" });
  })();
}, [vendorId]);

async function saveShop() {
  setShopSaved(false);
  setShopProblem(null);
  setShopBusy(true);
  const { error } = await updateShopDetails(vendorId!, shop);
  setShopBusy(false);
  const described = describeError(error);
  setShopProblem(described);
  if (!described) setShopSaved(true);
}
```

Render it as a new `<section>` placed immediately after the loyalty section and before `<Staff />`:

```tsx
<section className="bg-white border border-slate-200 rounded-xl p-4 space-y-3 max-w-md">
  <h2 className="font-semibold text-slate-800">{t("shop.section")}</h2>
  <p className="text-sm text-slate-600">{t("shop.help")}</p>

  {shopProblem && (
    <p data-testid="shop-problem" className="text-sm text-red-700">{t(shopProblem.key)}</p>
  )}

  <form onSubmit={(e) => { e.preventDefault(); void saveShop(); }} className="space-y-3">
    <div>
      <label className="block text-sm text-slate-600 mb-1" htmlFor="shop-address">
        {t("shop.address")}
      </label>
      <input
        id="shop-address" data-testid="shop-address" value={shop.address ?? ""}
        onChange={(e) => { setShopSaved(false); setShop({ ...shop, address: e.target.value }); }}
        className="w-full border border-slate-300 rounded-lg px-3 py-2 min-h-[44px]"
      />
    </div>
    <div>
      <label className="block text-sm text-slate-600 mb-1" htmlFor="shop-phone">
        {t("shop.phone")}
      </label>
      <input
        id="shop-phone" data-testid="shop-phone" value={shop.phone ?? ""} inputMode="tel"
        onChange={(e) => { setShopSaved(false); setShop({ ...shop, phone: e.target.value }); }}
        className="w-full border border-slate-300 rounded-lg px-3 py-2 min-h-[44px]"
      />
    </div>

    {shopSaved && (
      <p data-testid="shop-saved" className="text-sm text-green-700">{t("shop.saved")}</p>
    )}

    <button
      type="submit" data-testid="shop-save" disabled={shopBusy}
      className="rounded-lg px-4 py-2 text-sm bg-slate-800 text-white min-h-[44px] disabled:opacity-50"
    >
      {t("shop.save")}
    </button>
  </form>
</section>
```

Note this section renders regardless of the loyalty form's `loaded` flag: that flag guards against saving blank *loyalty minimums* over real config, and a blank address is a legitimate value here.

- [ ] **Step 9: Run tests to verify they pass**

Run: `cd web && npm test -- Settings.test admin.test`
Expected: PASS.

- [ ] **Step 10: Commit**

```bash
git add web/src/admin.ts web/src/screens/Settings.tsx web/src/i18n web/src/__tests__/admin.test.ts web/src/__tests__/Settings.test.tsx
git commit -m "feat: let an admin set the shop address and phone

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 3: `receipt.ts` — compose the slip's data

**Files:**
- Create: `web/src/receipt.ts`
- Test: `web/src/__tests__/receipt.test.ts` (create)

**Interfaces:**
- Consumes: `supabase` from `./supabase`; `ShopDetails` shape from Task 2 (read independently here, not imported from `admin.ts`).
- Produces:

```typescript
export type ReceiptLine = {
  id: string;
  qty_kg: number;
  unit_price: number;
  line_total: number;
  items: { name_en: string; name_hi: string; name_mr: string } | null;
};

export type Receipt = {
  token_no: number;
  completed_at: string;
  /** What was actually collected. bills.total. */
  net: number;
  /** net + redeemed_points, i.e. before the loyalty discount. */
  gross: number;
  redeemed_points: number;
  lines: ReceiptLine[];
  customer: { name: string; flat_no: string } | null;
  biller_name: string | null;
  shop: { name: string; address: string | null; phone: string | null };
  points_earned: number;
  /** Live balance and days to expiry; null when there is no customer. */
  balance: { balance: number; days_left: number | null } | null;
};

export async function loadReceipt(billId: string): Promise<
  { data: Receipt; error: null } | { data: null; error: unknown }
>;
```

- [ ] **Step 1: Write the failing tests**

Create `web/src/__tests__/receipt.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";

type Row = Record<string, unknown>;
const responses = { bills: {} as Row, lines: [] as Row[], ledger: [] as Row[] };
const rpcResult = { data: [{ balance: 260, days_left: 15 }], error: null as unknown };

const captured: { tables: string[]; selects: string[] } = { tables: [], selects: [] };

const make = (table: string) => {
  const o: Record<string, unknown> = {};
  for (const k of ["select", "eq", "gt", "order", "limit"]) {
    o[k] = (...a: unknown[]) => {
      if (k === "select") captured.selects.push(a[0] as string);
      return o;
    };
  }
  o.maybeSingle = async () => ({ data: responses.bills, error: null });
  (o as { then: unknown }).then = (res: (v: unknown) => unknown) => {
    const data = table === "bill_items" ? responses.lines : responses.ledger;
    return Promise.resolve({ data, error: null }).then(res);
  };
  return o;
};

vi.mock("../supabase", () => ({
  supabase: {
    from: (t: string) => { captured.tables.push(t); return make(t); },
    rpc: async () => rpcResult,
  },
}));

const { loadReceipt } = await import("../receipt");

const BILL = {
  token_no: 147,
  completed_at: "2026-09-17T14:12:00.000Z",
  total: "166.00",
  redeemed_points: 50,
  customers: { name: "Sunita Kale", flat_no: "B-304" },
  app_users: { name: "Sunil" },
  vendors: { name: "Taji Bhaji", address: "Shop 12", phone: "9876543210" },
};

beforeEach(() => {
  captured.tables = [];
  captured.selects = [];
  responses.bills = { ...BILL };
  responses.lines = [
    { id: "l1", qty_kg: "2.5", unit_price: "40.00", line_total: "100.00",
      items: { name_en: "Tomato", name_hi: "टमाटर", name_mr: "टोमॅटो" } },
  ];
  responses.ledger = [{ points: 0 }];
  rpcResult.data = [{ balance: 260, days_left: 15 }];
  rpcResult.error = null;
});

describe("loadReceipt", () => {
  it("computes gross as the net plus the points redeemed", async () => {
    // bills.total is the NET (0010). Printing it as the subtotal shows the discount
    // twice: once in the subtotal and again on the redemption line.
    const { data } = await loadReceipt("b1");
    expect(data!.net).toBe(166);
    expect(data!.gross).toBe(216);
  });

  it("leaves gross equal to net when nothing was redeemed", async () => {
    responses.bills = { ...BILL, total: "216.00", redeemed_points: 0 };
    const { data } = await loadReceipt("b1");
    expect(data!.gross).toBe(216);
    expect(data!.net).toBe(216);
  });

  it("coerces PostgREST's numeric-as-string to numbers", async () => {
    // numeric arrives as text to avoid float rounding. Left as strings, "100.00" + 0
    // concatenates and the slip prints nonsense.
    const { data } = await loadReceipt("b1");
    const line = data!.lines[0]!;
    expect(line.qty_kg).toBe(2.5);
    expect(line.unit_price).toBe(40);
    expect(line.line_total).toBe(100);
  });

  it("reads points earned from the ledger rather than recomputing the rule", async () => {
    responses.ledger = [{ points: 50 }];
    const { data } = await loadReceipt("b1");
    expect(data!.points_earned).toBe(50);
    expect(captured.tables).toContain("points_ledger");
  });

  it("reports zero points earned when the bill awarded none", async () => {
    // A 216 bill that redeemed 50 nets 166, under the 600 threshold. Earning nothing is
    // correct: complete_bill measures thresholds against the net.
    responses.ledger = [];
    const { data } = await loadReceipt("b1");
    expect(data!.points_earned).toBe(0);
  });

  it("renders a walk-in bill with no customer", async () => {
    responses.bills = { ...BILL, customers: null };
    const { data } = await loadReceipt("b1");
    expect(data!.customer).toBeNull();
    expect(data!.balance).toBeNull();
  });

  it("survives a bill whose biller name is missing", async () => {
    responses.bills = { ...BILL, app_users: null };
    const { data } = await loadReceipt("b1");
    expect(data!.biller_name).toBeNull();
    expect(data!.token_no).toBe(147);
  });

  it("carries the shop header through", async () => {
    const { data } = await loadReceipt("b1");
    expect(data!.shop).toEqual({ name: "Taji Bhaji", address: "Shop 12", phone: "9876543210" });
  });

  it("returns the error and no data when the bill cannot be read", async () => {
    const boom = { message: "nope" };
    const { supabase } = await import("../supabase");
    vi.spyOn(supabase, "from").mockReturnValueOnce({
      select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: boom }) }) }),
    } as never);
    const { data, error } = await loadReceipt("b1");
    expect(data).toBeNull();
    expect(error).toBe(boom);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd web && npm test -- receipt.test`
Expected: FAIL — `Cannot find module '../receipt'`.

- [ ] **Step 3: Implement `web/src/receipt.ts`**

```typescript
import { supabase } from "./supabase";

/**
 * The reads behind the printed receipt.
 *
 * A fourth sibling to data.ts (billing), admin.ts (admin) and history.ts (history), for
 * the same reason all three exist: a small surface the screen stubs in tests.
 *
 * As in its siblings, nothing here filters by vendor. RLS scopes every query, and a
 * client-side filter would be a weaker second copy of the policy.
 *
 * Everything this module returns is already coerced and already derived. The screen
 * receives a finished object and does no arithmetic -- which is what keeps Receipt.tsx
 * purely about the 58mm layout.
 */

export type ReceiptLine = {
  id: string;
  qty_kg: number;
  unit_price: number;
  line_total: number;
  items: { name_en: string; name_hi: string; name_mr: string } | null;
};

export type Receipt = {
  token_no: number;
  completed_at: string;
  /** What was actually collected: bills.total. */
  net: number;
  /** Before the loyalty discount: net + redeemed_points. */
  gross: number;
  redeemed_points: number;
  lines: ReceiptLine[];
  customer: { name: string; flat_no: string } | null;
  biller_name: string | null;
  shop: { name: string; address: string | null; phone: string | null };
  points_earned: number;
  balance: { balance: number; days_left: number | null } | null;
};

/**
 * Separate from history.ts's BILL_COLS on purpose: it adds two joins (the biller's name
 * and the shop header) that the Completed list never renders, and that list is paged
 * fifty rows at a time.
 */
const RECEIPT_COLS =
  "token_no, completed_at, total, redeemed_points, customer_id, " +
  "customers(name, flat_no), app_users!bills_biller_id_fkey(name), " +
  "vendors(name, address, phone)";

/** PostgREST serialises numeric as TEXT to avoid float rounding. Everything monetary
 *  passes through here before it reaches arithmetic or rupees(). */
const num = (v: unknown): number => Number(v ?? 0);

export async function loadReceipt(billId: string) {
  const { data: bill, error } = await supabase
    .from("bills")
    .select(RECEIPT_COLS)
    .eq("id", billId)
    .maybeSingle();

  if (error || !bill) return { data: null, error: error ?? null };

  const b = bill as unknown as {
    token_no: number;
    completed_at: string;
    total: string | number;
    redeemed_points: number;
    customer_id: string | null;
    customers: { name: string; flat_no: string } | null;
    app_users: { name: string } | null;
    vendors: { name: string; address: string | null; phone: string | null } | null;
  };

  const { data: lineRows, error: lineError } = await supabase
    .from("bill_items")
    .select("id, qty_kg, unit_price, line_total, items(name_en, name_hi, name_mr)")
    .eq("bill_id", billId);

  if (lineError) return { data: null, error: lineError };

  // Points EARNED on this bill, read rather than recomputed. A client-side copy of the
  // threshold rule would drift from complete_bill the first time a vendor tunes their
  // config in Settings. Positive rows only: the negative rows on this same bill_id are
  // the redemption, which redeemed_points already reports.
  const { data: ledgerRows, error: ledgerError } = await supabase
    .from("points_ledger")
    .select("points")
    .eq("bill_id", billId)
    .gt("points", 0);

  if (ledgerError) return { data: null, error: ledgerError };

  let balance: Receipt["balance"] = null;
  if (b.customer_id) {
    // Parameter name must match 0003_functions.sql exactly; PostgREST resolves the
    // overload by argument name, and a mismatch reads as "function not found".
    const { data: rpcData } = await supabase.rpc("customer_points_balance", {
      p_customer_id: b.customer_id,
    });
    // A returns-table function arrives from PostgREST as an array of one row.
    const row = (Array.isArray(rpcData) ? rpcData[0] : rpcData) as
      | { balance: number; days_left: number | null }
      | undefined;
    // A failed balance read must not lose the receipt: the slip's job is the sale, and
    // the points block is an extra. Falls back to zero rather than propagating.
    balance = row ? { balance: num(row.balance), days_left: row.days_left } : { balance: 0, days_left: null };
  }

  const net = num(b.total);
  const redeemed = num(b.redeemed_points);

  const data: Receipt = {
    token_no: b.token_no,
    completed_at: b.completed_at,
    net,
    // bills.total is the NET (0010). The gross a customer expects to see itemised is
    // total + redeemed_points, at 1 point = 1 rupee.
    gross: net + redeemed,
    redeemed_points: redeemed,
    lines: ((lineRows ?? []) as unknown as ReceiptLine[]).map((l) => ({
      id: l.id,
      qty_kg: num(l.qty_kg),
      unit_price: num(l.unit_price),
      line_total: num(l.line_total),
      items: l.items ?? null,
    })),
    customer: b.customers ?? null,
    biller_name: b.app_users?.name ?? null,
    shop: {
      name: b.vendors?.name ?? "",
      address: b.vendors?.address ?? null,
      phone: b.vendors?.phone ?? null,
    },
    points_earned: ((ledgerRows ?? []) as { points: number }[]).reduce(
      (sum, r) => sum + num(r.points), 0,
    ),
    balance,
  };

  return { data, error: null };
}
```

Note the `app_users!bills_biller_id_fkey(name)` disambiguator: `bills` references `app_users` twice (`recorder_id` and `biller_id`), and an unqualified embed is ambiguous. Confirm the constraint's real name against `0001_schema.sql` before running, and use whatever it is actually called.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd web && npm test -- receipt.test`
Expected: PASS, 9 tests.

- [ ] **Step 5: Commit**

```bash
git add web/src/receipt.ts web/src/__tests__/receipt.test.ts
git commit -m "feat: compose the printed receipt's data in one module

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 4: `Receipt.tsx` — the 58mm render

**Files:**
- Create: `web/src/screens/Receipt.tsx`
- Modify: `web/src/index.css` (the `@page` rule and print block)
- Modify: `web/src/i18n/en.json`, `hi.json`, `mr.json`
- Test: `web/src/__tests__/Receipt.test.tsx` (create)

**Interfaces:**
- Consumes: `loadReceipt`, `type Receipt` from Task 3; `itemName` from `../i18n/locales`; `rupees` from `../money`; `describeError` from `../errors`.
- Produces: `export default function Receipt()`, a route component reading `useParams<{ billId: string }>()`.

- [ ] **Step 1: Add the locale keys**

`en.json`:

```json
"receipt": {
  "token": "Token #{{n}}",
  "items": "Items: {{n}}",
  "subtotal": "Subtotal",
  "redeemed": "Points redeemed",
  "total": "Total",
  "paid": "Paid",
  "pointsEarned": "Points earned",
  "balance": "Balance",
  "expires": "Expires {{date}} ({{days}} days)",
  "servedBy": "Served by {{name}}",
  "thanks": "Thank you!",
  "print": "Print",
  "loading": "Loading…",
  "notFound": "That bill could not be found.",
  "walkIn": "Walk-in"
}
```

`hi.json`:

```json
"receipt": {
  "token": "टोकन #{{n}}",
  "items": "वस्तुएँ: {{n}}",
  "subtotal": "उप-योग",
  "redeemed": "अंक इस्तेमाल हुए",
  "total": "कुल",
  "paid": "भुगतान",
  "pointsEarned": "अंक मिले",
  "balance": "शेष अंक",
  "expires": "{{date}} तक ({{days}} दिन)",
  "servedBy": "{{name}} द्वारा",
  "thanks": "धन्यवाद!",
  "print": "प्रिंट करें",
  "loading": "लोड हो रहा है…",
  "notFound": "वह बिल नहीं मिला.",
  "walkIn": "ग्राहक"
}
```

`mr.json`:

```json
"receipt": {
  "token": "टोकन #{{n}}",
  "items": "वस्तू: {{n}}",
  "subtotal": "उप-बेरीज",
  "redeemed": "वापरलेले गुण",
  "total": "एकूण",
  "paid": "दिलेले",
  "pointsEarned": "मिळालेले गुण",
  "balance": "शिल्लक गुण",
  "expires": "{{date}} पर्यंत ({{days}} दिवस)",
  "servedBy": "{{name}} यांनी",
  "thanks": "धन्यवाद!",
  "print": "प्रिंट करा",
  "loading": "लोड होत आहे…",
  "notFound": "ते बिल सापडले नाही.",
  "walkIn": "ग्राहक"
}
```

- [ ] **Step 2: Write the failing tests**

Create `web/src/__tests__/Receipt.test.tsx`:

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import type { Receipt as ReceiptData } from "../receipt";

const loadReceipt = vi.fn();
vi.mock("../receipt", () => ({ loadReceipt: (...a: unknown[]) => loadReceipt(...a) }));

const Receipt = (await import("../screens/Receipt")).default;

const FULL: ReceiptData = {
  token_no: 147,
  completed_at: "2026-09-17T14:12:00.000Z",
  net: 166,
  gross: 216,
  redeemed_points: 50,
  lines: [
    { id: "l1", qty_kg: 2.5, unit_price: 40, line_total: 100,
      items: { name_en: "Tomato", name_hi: "टमाटर", name_mr: "टोमॅटो" } },
  ],
  customer: { name: "Sunita Kale", flat_no: "B-304" },
  biller_name: "Sunil",
  shop: { name: "Taji Bhaji", address: "Shop 12, Kothrud", phone: "9876543210" },
  points_earned: 0,
  balance: { balance: 260, days_left: 15 },
};

const renderAt = () =>
  render(
    <MemoryRouter initialEntries={["/receipt/b1"]}>
      <Routes><Route path="/receipt/:billId" element={<Receipt />} /></Routes>
    </MemoryRouter>,
  );

beforeEach(() => {
  vi.clearAllMocks();
  loadReceipt.mockResolvedValue({ data: FULL, error: null });
});

describe("Receipt", () => {
  it("prints the token, the shop header and the customer", async () => {
    renderAt();
    expect(await screen.findByTestId("receipt-token")).toHaveTextContent("147");
    expect(screen.getByTestId("receipt-shop")).toHaveTextContent("Taji Bhaji");
    expect(screen.getByTestId("receipt-shop")).toHaveTextContent("Shop 12, Kothrud");
    expect(screen.getByTestId("receipt-customer")).toHaveTextContent("Sunita Kale");
    expect(screen.getByTestId("receipt-customer")).toHaveTextContent("B-304");
  });

  it("shows the subtotal as the gross, not the stored net", async () => {
    renderAt();
    expect(await screen.findByTestId("receipt-subtotal")).toHaveTextContent("216.00");
    expect(screen.getByTestId("receipt-total")).toHaveTextContent("166.00");
  });

  it("shows the redemption line only when points were spent", async () => {
    renderAt();
    expect(await screen.findByTestId("receipt-redeemed")).toBeTruthy();

    vi.clearAllMocks();
    loadReceipt.mockResolvedValue({ data: { ...FULL, redeemed_points: 0, gross: 166 }, error: null });
    renderAt();
    expect(await screen.findAllByTestId("receipt-total")).toBeTruthy();
    expect(screen.queryAllByTestId("receipt-redeemed")).toHaveLength(1);
  });

  it("omits the expiry line when the balance is zero", async () => {
    loadReceipt.mockResolvedValue({
      data: { ...FULL, balance: { balance: 0, days_left: null } }, error: null,
    });
    renderAt();
    await screen.findByTestId("receipt-token");
    expect(screen.queryByTestId("receipt-expires")).toBeNull();
  });

  it("renders a walk-in bill with no customer and no points block", async () => {
    // Every existing screen joins customers optionally; the slip must too.
    loadReceipt.mockResolvedValue({
      data: { ...FULL, customer: null, balance: null, points_earned: 0 }, error: null,
    });
    renderAt();
    await screen.findByTestId("receipt-token");
    expect(screen.queryByTestId("receipt-customer")).toBeNull();
    expect(screen.queryByTestId("receipt-points")).toBeNull();
  });

  it("still renders when the biller name is missing", async () => {
    loadReceipt.mockResolvedValue({ data: { ...FULL, biller_name: null }, error: null });
    renderAt();
    expect(await screen.findByTestId("receipt-token")).toHaveTextContent("147");
    expect(screen.queryByTestId("receipt-served-by")).toBeNull();
  });

  it("omits a shop line that is blank", async () => {
    loadReceipt.mockResolvedValue({
      data: { ...FULL, shop: { name: "Taji Bhaji", address: null, phone: null } }, error: null,
    });
    renderAt();
    const shop = await screen.findByTestId("receipt-shop");
    expect(shop).toHaveTextContent("Taji Bhaji");
    expect(screen.queryByTestId("receipt-shop-address")).toBeNull();
  });

  it("names the item in the active language", async () => {
    renderAt();
    // i18n initialises to mr by default in this suite, matching resolveLang's fallback.
    expect(await screen.findByTestId("receipt-line-l1")).toHaveTextContent("टोमॅटो");
  });

  it("calls window.print when Print is pressed", async () => {
    const print = vi.spyOn(window, "print").mockImplementation(() => {});
    renderAt();
    (await screen.findByTestId("receipt-print")).click();
    expect(print).toHaveBeenCalled();
  });

  it("says so when the bill cannot be loaded", async () => {
    loadReceipt.mockResolvedValue({ data: null, error: { message: "gone" } });
    renderAt();
    expect(await screen.findByTestId("receipt-problem")).toBeTruthy();
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `cd web && npm test -- Receipt.test`
Expected: FAIL — `Cannot find module '../screens/Receipt'`.

- [ ] **Step 4: Implement `web/src/screens/Receipt.tsx`**

```tsx
import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { loadReceipt, type Receipt as ReceiptData } from "../receipt";
import { itemName, type Lang } from "../i18n/locales";
import { rupees } from "../money";
import { describeError } from "../errors";
import "../i18n";

/**
 * The 58mm slip (Slice A).
 *
 * ONE render, two media. What is on screen is what goes on paper -- the only difference
 * is the @media print block in index.css, which hides the Print button and the page
 * chrome. There is deliberately no second "printable" component: that duplication is the
 * one that drifts, and a slip that disagrees with the screen is worse than no slip.
 *
 * The layout is a fixed-width monospace block because 58mm is about 32 characters and
 * the columns have to line up. Items take two lines -- name, then qty/rate/amount --
 * because a Marathi name plus three numbers does not fit on one.
 */
export default function Receipt() {
  const { billId } = useParams<{ billId: string }>();
  const { t, i18n } = useTranslation();
  const lang = i18n.language as Lang;
  const [data, setData] = useState<ReceiptData | null>(null);
  const [problem, setProblem] = useState<{ key: string; detail: string } | null>(null);

  useEffect(() => {
    if (!billId) return;
    void (async () => {
      const { data: r, error } = await loadReceipt(billId);
      if (r) setData(r);
      else setProblem(describeError(error) ?? { key: "receipt.notFound", detail: "" });
    })();
  }, [billId]);

  if (problem) {
    return <p data-testid="receipt-problem" className="p-4 text-sm text-red-700">{t(problem.key)}</p>;
  }
  if (!data) return <p className="p-4 text-slate-400">{t("receipt.loading")}</p>;

  const when = new Date(data.completed_at);
  const rule = <div aria-hidden className="border-t border-dashed border-slate-400 my-1" />;

  return (
    <div className="flex flex-col items-center">
      {/* Hidden on paper by the print block: a receipt with a button on it is a bug. */}
      <button
        data-testid="receipt-print" onClick={() => window.print()}
        className="receipt-noprint mb-3 rounded-lg px-4 py-2 text-sm bg-slate-800 text-white min-h-[44px]"
      >
        {t("receipt.print")}
      </button>

      <div className="receipt-slip font-mono text-[11px] leading-tight text-black bg-white p-2">
        <div data-testid="receipt-shop" className="text-center">
          <div className="font-bold">{data.shop.name}</div>
          {data.shop.address && <div data-testid="receipt-shop-address">{data.shop.address}</div>}
          {data.shop.phone && <div>{data.shop.phone}</div>}
        </div>
        {rule}

        <div data-testid="receipt-token" className="flex justify-between">
          <span>{t("receipt.token", { n: data.token_no })}</span>
        </div>
        <div className="flex justify-between">
          <span>{when.toLocaleDateString()}</span>
          <span>{when.toLocaleTimeString()}</span>
        </div>
        {data.customer && (
          <div data-testid="receipt-customer" className="flex justify-between gap-2">
            <span className="truncate">{data.customer.name}</span>
            <span className="whitespace-nowrap">{data.customer.flat_no}</span>
          </div>
        )}
        {rule}

        <ul>
          {data.lines.map((l) => (
            <li key={l.id} data-testid={`receipt-line-${l.id}`}>
              <div className="truncate">{l.items ? itemName(l.items, lang) : "—"}</div>
              <div className="flex justify-between pl-2">
                <span>{`${l.qty_kg} kg x ${l.unit_price.toFixed(2)}`}</span>
                <span>{l.line_total.toFixed(2)}</span>
              </div>
            </li>
          ))}
        </ul>
        {rule}

        <div data-testid="receipt-subtotal" className="flex justify-between">
          <span>{t("receipt.items", { n: data.lines.length })}</span>
          <span>{`${t("receipt.subtotal")} ${rupees(data.gross)}`}</span>
        </div>
        {data.redeemed_points > 0 && (
          <div data-testid="receipt-redeemed" className="flex justify-between">
            <span>{t("receipt.redeemed")}</span>
            <span>{`- ${rupees(data.redeemed_points)}`}</span>
          </div>
        )}
        <div data-testid="receipt-total" className="flex justify-between font-bold">
          <span>{t("receipt.total")}</span>
          <span>{rupees(data.net)}</span>
        </div>
        <div className="flex justify-between">
          <span>{t("receipt.paid")}</span>
          <span>{rupees(data.net)}</span>
        </div>

        {data.balance && (
          <>
            {rule}
            <div data-testid="receipt-points">
              <div className="flex justify-between">
                <span>{t("receipt.pointsEarned")}</span>
                <span>{data.points_earned}</span>
              </div>
              <div className="flex justify-between">
                <span>{t("receipt.balance")}</span>
                <span>{data.balance.balance}</span>
              </div>
              {/* The line this whole slice makes visible for the first time. Omitted at a
                  zero balance, where there is no deadline to miss. */}
              {data.balance.balance > 0 && data.balance.days_left !== null && (
                <div data-testid="receipt-expires">
                  {t("receipt.expires", {
                    date: new Date(
                      Date.now() + data.balance.days_left * 86_400_000,
                    ).toLocaleDateString(),
                    days: data.balance.days_left,
                  })}
                </div>
              )}
            </div>
          </>
        )}

        {rule}
        <div className="text-center">
          {data.biller_name && (
            <span data-testid="receipt-served-by">
              {t("receipt.servedBy", { name: data.biller_name })}{" · "}
            </span>
          )}
          {t("receipt.thanks")}
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 5: Add the print CSS to `web/src/index.css`**

```css
/* The 58mm slip. Height is auto because a receipt has no page length -- a fixed one
   ejects a blank second page on every print. */
@page {
  size: 58mm auto;
  margin: 0;
}

.receipt-slip {
  width: 58mm;
  /* An EXPLICIT Devanagari fallback. Most monospace stacks carry none, and the browser
     then silently substitutes a proportional face -- which breaks column alignment on
     exactly the lines holding item names, the ones this layout depends on. */
  font-family: ui-monospace, "Cascadia Mono", "Noto Sans Mono", "Noto Sans Devanagari",
    "Nirmala UI", monospace;
}

@media print {
  /* Everything that is app, not receipt. The route renders the slip alone, so this is
     belt-and-braces against a future layout wrapping it in chrome. */
  .receipt-noprint {
    display: none !important;
  }
  body {
    background: #fff;
  }
}
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `cd web && npm test -- Receipt.test`
Expected: PASS, 10 tests.

- [ ] **Step 7: Commit**

```bash
git add web/src/screens/Receipt.tsx web/src/index.css web/src/i18n web/src/__tests__/Receipt.test.tsx
git commit -m "feat: render the 58mm printed receipt

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 5: Route the receipt, staff-only

**Files:**
- Modify: `web/src/routes.ts` (`BY_ROLE`, `canAccess`)
- Modify: `web/src/App.tsx` (the route)
- Test: `web/src/__tests__/routes.test.ts`, `web/src/__tests__/guards.test.ts`

**Interfaces:**
- Consumes: the `Receipt` component from Task 4.
- Produces: `/receipt/:billId` reachable by `admin` and `biller`; `canAccess(role, "/receipt/b1")` matching the parameterised entry.

- [ ] **Step 1: Write the failing tests**

Append to `web/src/__tests__/routes.test.ts`:

```typescript
describe("the receipt route", () => {
  it("is open to the biller and the admin", () => {
    expect(canAccess("biller", "/receipt/b1")).toBe(true);
    expect(canAccess("admin", "/receipt/b1")).toBe(true);
  });

  it("is closed to the recorder", () => {
    // A recorder hands off at the token stage and never sees money; the slip carries a
    // points balance they have no reason to read. Politeness, not protection -- RLS on
    // bills, customers and points_ledger is what actually refuses the data.
    expect(canAccess("recorder", "/receipt/b1")).toBe(false);
  });

  it("does not put the receipt in the nav", () => {
    // It is reached from a bill, not from a menu: there is no useful receipt list.
    for (const role of ["admin", "recorder", "biller"] as const) {
      expect(routesForRole(role).some((r) => r.path.startsWith("/receipt"))).toBe(false);
    }
  });

  it("still matches exact paths exactly", () => {
    // The parameterised match must not turn into a prefix match: /completed must not
    // start granting /completedxyz.
    expect(canAccess("biller", "/completedxyz")).toBe(false);
    expect(canAccess("biller", "/receipt")).toBe(false);
    expect(canAccess("biller", "/receiptxyz/b1")).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd web && npm test -- routes.test`
Expected: FAIL — `expected false to be true` on the biller case.

- [ ] **Step 3: Implement in `web/src/routes.ts`**

`BY_ROLE` entries are the nav. The receipt is not in the nav, so it needs a second list:

```typescript
/**
 * Paths reachable but never listed. BY_ROLE is the nav; these are screens reached from
 * inside another screen, so putting them in BY_ROLE would print a menu entry for a page
 * that needs an id to mean anything.
 *
 * Matched by prefix + one segment, NOT by String.startsWith alone -- a bare startsWith
 * would grant /receiptxyz/b1 as well.
 */
const UNLISTED: Record<Role, readonly string[]> = {
  recorder: [],
  biller: ["/receipt"],
  admin: ["/receipt"],
};

const matchesUnlisted = (prefix: string, path: string): boolean => {
  if (!path.startsWith(`${prefix}/`)) return false;
  const rest = path.slice(prefix.length + 1);
  return rest.length > 0 && !rest.includes("/");
};

export function canAccess(role: Role, path: string): boolean {
  if (BY_ROLE[role].some((r) => r.path === path)) return true;
  return UNLISTED[role].some((prefix) => matchesUnlisted(prefix, path));
}
```

Leave `routesForRole` and `homeFor` untouched.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd web && npm test -- routes.test guards.test`
Expected: PASS.

- [ ] **Step 5: Add the route to `App.tsx`**

Import `Receipt from "./screens/Receipt"` and add inside `<Routes>`, before the catch-all:

```tsx
<Route path="/receipt/:billId" element={<Receipt />} />
```

It sits inside `<Guard>` like every other route, so a recorder who types the URL is redirected home.

- [ ] **Step 6: Run the whole web suite**

Run: `cd web && npm test`
Expected: PASS — no existing test regressed by the `canAccess` change.

- [ ] **Step 7: Commit**

```bash
git add web/src/routes.ts web/src/App.tsx web/src/__tests__/routes.test.ts
git commit -m "feat: route the receipt, for billers and admins only

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 6: Reach the receipt from a bill

**Files:**
- Modify: `web/src/screens/Completed.tsx` (a Print link on the expanded bill)
- Modify: `web/src/screens/Pending.tsx` (a Print link on the completed confirmation)
- Modify: `web/src/i18n/en.json`, `hi.json`, `mr.json` (one key)
- Test: `web/src/__tests__/Completed.test.tsx`, `web/src/__tests__/Pending.test.tsx`

**Interfaces:**
- Consumes: the `/receipt/:billId` route from Task 5.
- Produces: nothing other tasks depend on.

- [ ] **Step 1: Add the locale key**

Add `"receipt": "Receipt"` to the `completed` block of `en.json`, `"रसीद"` to `hi.json`, `"पावती"` to `mr.json`.

- [ ] **Step 2: Write the failing test for Completed**

Append to `web/src/__tests__/Completed.test.tsx` (the file already renders inside a router — keep its existing wrapper):

```typescript
it("links an expanded bill to its receipt", async () => {
  renderCompleted();
  const row = await screen.findByTestId("completed-row-b1");
  fireEvent.click(row);
  const link = await screen.findByTestId("completed-receipt-b1");
  expect(link.getAttribute("href")).toBe("/receipt/b1");
});
```

If the existing test file has no `completed-row-b1` testid, use whatever selector its other expand-a-bill test already uses.

- [ ] **Step 3: Run it to verify it fails**

Run: `cd web && npm test -- Completed.test`
Expected: FAIL — unable to find `[data-testid="completed-receipt-b1"]`.

- [ ] **Step 4: Add the link in `Completed.tsx`**

Import `Link` from `react-router-dom`. Inside the `{open === b.id && ( ... )}` block, after the redeemed paragraph:

```tsx
<Link
  data-testid={`completed-receipt-${b.id}`}
  to={`/receipt/${b.id}`}
  className="inline-block mt-2 border border-slate-300 rounded-lg px-3 py-2 text-sm bg-white min-h-[44px]"
>
  {t("completed.receipt")}
</Link>
```

- [ ] **Step 5: Run it to verify it passes**

Run: `cd web && npm test -- Completed.test`
Expected: PASS.

- [ ] **Step 6: Write the failing test for Pending**

Append to `web/src/__tests__/Pending.test.tsx`, following how its existing tests drive a bill to completion:

```typescript
it("offers the receipt once the bill is completed", async () => {
  renderPending();
  fireEvent.click(await screen.findByTestId("pending-complete-b1"));
  fireEvent.click(await screen.findByTestId("pending-confirm"));
  // The moment the slip is wanted: the customer is still standing there.
  const link = await screen.findByTestId("pending-receipt-b1");
  expect(link.getAttribute("href")).toBe("/receipt/b1");
});
```

Match the existing testids in that file rather than inventing new ones.

- [ ] **Step 7: Run it to verify it fails**

Run: `cd web && npm test -- Pending.test`
Expected: FAIL — unable to find `[data-testid="pending-receipt-b1"]`.

- [ ] **Step 8: Add the link in `Pending.tsx`**

Import `Link` from `react-router-dom` and render it beside the existing "Completed." confirmation, using the id of the bill just completed:

```tsx
<Link
  data-testid={`pending-receipt-${completedId}`}
  to={`/receipt/${completedId}`}
  className="inline-block mt-2 border border-slate-300 rounded-lg px-3 py-2 text-sm bg-white min-h-[44px]"
>
  {t("completed.receipt")}
</Link>
```

Deliberately a link, not an auto-print: a print dialog firing on its own mid-queue is worse than a button, and `complete_bill` is idempotent precisely because it gets retried.

- [ ] **Step 9: Run the whole web suite**

Run: `cd web && npm test`
Expected: PASS.

- [ ] **Step 10: Commit**

```bash
git add web/src/screens/Completed.tsx web/src/screens/Pending.tsx web/src/i18n web/src/__tests__/Completed.test.tsx web/src/__tests__/Pending.test.tsx
git commit -m "feat: reach the receipt from the pending and completed screens

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 7: Typecheck, document, and record what no test covers

**Files:**
- Modify: `README.md`
- Modify: `docs/runbook-first-admin.md`

**Interfaces:**
- Consumes: everything above.
- Produces: nothing.

- [ ] **Step 1: Run the full build and both suites**

```bash
cd web && npm run build
cd .. && npm test
cd web && npm test
```

Expected: `tsc --noEmit` clean, vite build succeeds, 145 DB cases pass, web suite passes.

**If `tsc` is clean here, that is not proof CI is clean.** TypeScript 7 is a per-platform native binary and CI's Linux build has rejected code Windows accepted. Push and check CI before calling this done.

- [ ] **Step 2: Add the printer setup to the runbook**

Append to `docs/runbook-first-admin.md`:

```markdown
## Setting up the receipt printer

The app prints through the operating system's print dialog, not through a driver of its
own. That means any printer the device can already see will work, and no printer is
required at all — the slip stays on screen for the customer to read or photograph.

For a paper slip, a **58mm Bluetooth thermal printer** is the expected hardware
(around ₹1,500–2,500).

1. Pair the printer with the Android device in the usual Bluetooth settings.
2. **Install the printer vendor's Android print service app.** Most inexpensive models do
   not appear in Chrome's print dialog without it. Check that this app exists before
   buying a particular model — it is the one part of this that a code change cannot fix.
3. In Settings → Shop details, fill in the address and phone that head every slip.
4. Complete a test bill, press **Receipt**, then **Print**, and check the slip against
   the list below.

What to check on the first physical print, none of which any automated test covers:

- The slip is not cut off at the right edge, and the amounts line up in a column.
- Marathi and Hindi item names render as text, not as boxes. If they are boxes, the
  device is missing a Devanagari font rather than the app being wrong.
- Only one slip feeds — no blank second page.
```

- [ ] **Step 3: Note the gap in the README's known unknowns**

Append to the "Known unknowns" section of `README.md`:

```markdown
- **No test asserts the receipt physically prints.** The render, the data composition and
  the routing are covered; whether a 58mm roll produces a readable slip needs paper and a
  paired printer. See "Setting up the receipt printer" in the runbook for what to check by
  hand the first time.
```

- [ ] **Step 4: Commit**

```bash
git add README.md docs/runbook-first-admin.md
git commit -m "docs: how to set up the receipt printer, and what no test covers

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Deployment

Migration 0014 must reach Cloud. Per `vendor-app-0013-deployed-by-hand`, `supabase db push`
401s from this machine, so 0014 is applied by hand in the SQL editor — **confirm which
project the editor is pointed at before running it**. Deploy order stays functions →
db push → git push; this slice deploys no function.

The receipt renders an empty shop header until an admin fills in Settings → Shop details.
That is a deliberate nullable state, not a broken deploy.
