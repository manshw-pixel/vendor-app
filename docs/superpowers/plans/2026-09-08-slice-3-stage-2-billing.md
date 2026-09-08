# Slice 3, Stage 2 — the billing flow

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the `/bill` and `/pending` placeholders with the real workflow — a
recorder builds a bill and issues a token, a biller completes it — against the live
Supabase project.

**Architecture:** No server of ours. The SPA calls PostgREST and the two `SECURITY
DEFINER` functions directly, carrying the user's JWT; RLS is the only authorization layer.
Every decision that can be a pure function is one, so it is tested without mocking
`supabase-js`. The client never recomputes what the database owns: the running total is
display feedback, `issue_token` recomputes the real total from line items.

**Tech Stack:** React 19, TypeScript 7, Tailwind 4, `@supabase/supabase-js` 2, Vitest 5 +
Testing Library. All already installed by stage 1.

**Spec:** `docs/superpowers/specs/2026-09-08-slice-3-spa-design.md` — §5 (the data flow and
its constraints) and §11a (the screen design).

## Global Constraints

- **`vendor_id` must be sent explicitly** on every insert into `bills`, `bill_items` and
  `customers`. The column is `not null` with no default. This is safe, not a trust hole:
  each policy's `WITH CHECK` requires it to equal `current_vendor_id()`, so a forged value
  is refused by the database. Omitting it was a real shipped bug once already.
- **The client's `total` is ignored by the server.** `issue_token` recomputes it from
  `bill_items` because a recorder can set `bills.total` to anything while the bill is
  `recording`. The running total is feedback; the total shown after Done comes from the
  server's response.
- **Done is a one-way door.** Once `issue_token` moves the bill to `billed`, the policies
  refuse further edits. Confirm before it; offer no undo.
- **Do not block over-selling client-side.** `complete_bill` clamps the stock decrement at
  zero deliberately. Show stock on the tile, colour it when low or zero, and let the
  database own the rule.
- **Route guards are UX, never security.** `/bill` is reachable by `admin` and `recorder`
  because `bills_recorder_insert` permits `('admin','recorder')`. Follow the policy; do
  not narrow it.
- **Roles are exactly** `'admin' | 'recorder' | 'biller'`.
- **The `service_role` key must never appear in `web/`, in any form, ever.**
- **Mobile-first.** Minimum touch target 44px. Weight inputs use `inputMode="decimal"` —
  scales produce values like 1.35, which steppers cannot express.
- **Every user-facing string goes through i18n**, with keys added to all three of
  `en.json`, `hi.json` and `mr.json`, keeping an identical key structure. Note in your
  report that new hi/mr strings need native-speaker review — the existing ones already do.
- **Item names are data:** render them with `itemName(item, lang)` from
  `web/src/i18n/locales.ts`, never `item.name_en` directly.
- **Do not touch** `supabase/migrations/`, `tests/`, or `console.html`.
- **Never pipe `npm test`** — its exit code is the gate.

---

## What stage 1 already built (import these; do not recreate)

```
web/src/config.ts        SUPABASE_URL, SUPABASE_ANON_KEY, ROLES, type Role
web/src/supabase.ts      supabase  (the single client)
web/src/session.ts       sessionFromRow, type SessionState  (kinds: loading | signedOut |
                         unmapped | error | ready; ready carries userId, vendorId,
                         vendorName, name, role)
web/src/routes.ts        routesForRole, canAccess, homeFor, type RouteDef
web/src/errors.ts        describeError(error) -> { key, detail } | null
web/src/i18n/locales.ts  LANGS, type Lang, resolveLang, itemName, LANG_STORAGE_KEY
web/src/i18n/index.ts    default i18next instance, setLang(lang)
web/src/components/      SessionProvider (exports useSession), Login, Shell, Guard
web/src/screens/         Placeholder.tsx
```

Existing i18n top-level keys: `app`, `nav`, `session`, `error`, `offline`, `soon`.

## File structure this stage adds

```
web/src/billing.ts               PURE: line math, validation, bill assembly (tested)
web/src/customers.ts             PURE: customer search filter + duplicate detection (tested)
web/src/screens/Bill.tsx         the recorder's three-phase screen
web/src/screens/bill/
  CustomerStep.tsx               search / create
  ItemGrid.tsx                   tiles + weight entry
  Basket.tsx                     lines, running total, Done
  TokenResult.tsx                the full-screen token
web/src/screens/Pending.tsx      the biller's queue
web/src/data.ts                  the only module issuing PostgREST calls for this flow
web/src/__tests__/               billing, customers, and component specs
```

`data.ts` exists so every query and RPC in this flow sits in one file. That is what lets
the screens be tested by mocking a handful of named functions rather than the whole
`supabase-js` surface, and it is where the `vendor_id` rule is enforced once instead of at
six call sites.

---

## Task 1: Pure billing math

**Files:**
- Create: `web/src/billing.ts`
- Test: `web/src/__tests__/billing.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `type Draft = { itemId: string; name: string; unitPrice: number; qtyKg: number }`
  - `lineTotal(unitPrice: number, qtyKg: number): number`
  - `runningTotal(lines: readonly Draft[]): number`
  - `validateWeight(raw: string): { ok: true; value: number } | { ok: false; reason: "empty" | "notANumber" | "notPositive" | "tooPrecise" }`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from "vitest";
import { lineTotal, runningTotal, validateWeight } from "../billing";

describe("lineTotal", () => {
  it("multiplies price by weight", () => {
    expect(lineTotal(40, 2)).toBe(80);
  });

  it("rounds to paise, because the column is numeric(10,2)", () => {
    // bill_items.line_total is numeric(10,2). Sending 53.235 would be rounded by
    // Postgres anyway; rounding here keeps the displayed total equal to the stored one.
    expect(lineTotal(40.5, 1.315)).toBe(53.26);
  });
});

describe("runningTotal", () => {
  const line = (unitPrice: number, qtyKg: number) =>
    ({ itemId: "i", name: "n", unitPrice, qtyKg });

  it("is zero for an empty basket", () => {
    expect(runningTotal([])).toBe(0);
  });

  it("sums the line totals, not the raw products", () => {
    // Summing unrounded products then rounding once gives a different answer from the
    // sum of rounded lines -- and the stored rows are the rounded ones.
    expect(runningTotal([line(40.5, 1.315), line(12.5, 0.335)])).toBe(53.26 + 4.19);
  });
});

describe("validateWeight", () => {
  it("accepts a decimal weight a scale would produce", () => {
    expect(validateWeight("1.35")).toEqual({ ok: true, value: 1.35 });
  });

  it("rejects empty input", () => {
    expect(validateWeight("")).toEqual({ ok: false, reason: "empty" });
    expect(validateWeight("   ")).toEqual({ ok: false, reason: "empty" });
  });

  it("rejects non-numbers", () => {
    expect(validateWeight("abc")).toEqual({ ok: false, reason: "notANumber" });
  });

  it("rejects zero and negatives", () => {
    // bill_items has check (qty_kg > 0). Catching it here gives a real message instead
    // of a constraint violation.
    expect(validateWeight("0")).toEqual({ ok: false, reason: "notPositive" });
    expect(validateWeight("-1")).toEqual({ ok: false, reason: "notPositive" });
  });

  it("rejects more precision than the column stores", () => {
    // qty_kg is numeric(10,2). Accepting 1.234 would silently store 1.23 and bill for
    // a weight nobody agreed to.
    expect(validateWeight("1.234")).toEqual({ ok: false, reason: "tooPrecise" });
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npm --prefix web test`
Expected: FAIL — cannot resolve `../billing`.

- [ ] **Step 3: Implement `web/src/billing.ts`**

```ts
export type Draft = {
  itemId: string;
  name: string;
  unitPrice: number;
  qtyKg: number;
};

/** numeric(10,2): two decimal places, so round here rather than let Postgres do it
 *  silently and leave the screen showing a different number from the stored row. */
const paise = (n: number): number => Math.round(n * 100) / 100;

export function lineTotal(unitPrice: number, qtyKg: number): number {
  return paise(unitPrice * qtyKg);
}

export function runningTotal(lines: readonly Draft[]): number {
  // Sum of the ROUNDED lines, matching what bill_items will hold. Summing the raw
  // products and rounding once would drift from the stored rows by a paisa or two.
  return paise(lines.reduce((sum, l) => sum + lineTotal(l.unitPrice, l.qtyKg), 0));
}

export function validateWeight(
  raw: string,
): { ok: true; value: number } | { ok: false; reason: "empty" | "notANumber" | "notPositive" | "tooPrecise" } {
  const text = raw.trim();
  if (text === "") return { ok: false, reason: "empty" };
  const value = Number(text);
  if (!Number.isFinite(value)) return { ok: false, reason: "notANumber" };
  if (value <= 0) return { ok: false, reason: "notPositive" };
  const decimals = text.split(".")[1]?.length ?? 0;
  if (decimals > 2) return { ok: false, reason: "tooPrecise" };
  return { ok: true, value };
}
```

- [ ] **Step 4: Run the test**

Run: `npm --prefix web test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add web/src/billing.ts web/src/__tests__/billing.test.ts
git commit -m "feat(web): pure billing math and weight validation"
```

---

## Task 2: Pure customer search and duplicate detection

**Files:**
- Create: `web/src/customers.ts`
- Test: `web/src/__tests__/customers.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `type Customer = { id: string; name: string; flat_no: string; mobile: string }`
  - `matchCustomers(all: readonly Customer[], query: string): Customer[]`
  - `validateCustomer(input: { name: string; flat_no: string; mobile: string }): { ok: true } | { ok: false; missing: ("name" | "flat_no" | "mobile")[] }`
  - `isDuplicateMobile(error: { code?: string; message?: string } | null): boolean`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from "vitest";
import { matchCustomers, validateCustomer, isDuplicateMobile } from "../customers";

const list = [
  { id: "1", name: "Asha Patil", flat_no: "A-101", mobile: "+919812345678" },
  { id: "2", name: "Ravi Kumar", flat_no: "B-22", mobile: "+919887654321" },
];

describe("matchCustomers", () => {
  it("matches on a name fragment, case-insensitively", () => {
    expect(matchCustomers(list, "asha").map((c) => c.id)).toEqual(["1"]);
  });

  it("matches on a partial mobile number", () => {
    // A recorder types the last few digits the customer reads out, not the +91 prefix.
    expect(matchCustomers(list, "7654").map((c) => c.id)).toEqual(["2"]);
  });

  it("matches on flat number", () => {
    expect(matchCustomers(list, "b-22").map((c) => c.id)).toEqual(["2"]);
  });

  it("returns everything for an empty query", () => {
    expect(matchCustomers(list, "  ").length).toBe(2);
  });

  it("returns nothing when nothing matches", () => {
    expect(matchCustomers(list, "zzz")).toEqual([]);
  });
});

describe("validateCustomer", () => {
  it("accepts all three fields present", () => {
    expect(validateCustomer({ name: "A", flat_no: "B-1", mobile: "+9198" })).toEqual({ ok: true });
  });

  it("names every missing field, not just the first", () => {
    // Requirement #11: all three mandatory. Reporting them one at a time makes a
    // recorder submit three times to learn three things.
    expect(validateCustomer({ name: "", flat_no: " ", mobile: "" }))
      .toEqual({ ok: false, missing: ["name", "flat_no", "mobile"] });
  });
});

describe("isDuplicateMobile", () => {
  it("recognises the unique-violation on customers", () => {
    // (vendor_id, mobile) is unique. This must become "that customer already exists",
    // never a raw constraint message.
    expect(isDuplicateMobile({
      code: "23505",
      message: 'duplicate key value violates unique constraint "customers_vendor_id_mobile_key"',
    })).toBe(true);
  });

  it("does not claim unrelated errors", () => {
    expect(isDuplicateMobile({ code: "23505", message: 'unique constraint "bills_vendor_id_token_no_key"' })).toBe(false);
    expect(isDuplicateMobile({ code: "42501", message: "row-level security" })).toBe(false);
    expect(isDuplicateMobile(null)).toBe(false);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npm --prefix web test`
Expected: FAIL — cannot resolve `../customers`.

- [ ] **Step 3: Implement `web/src/customers.ts`**

```ts
export type Customer = {
  id: string;
  name: string;
  flat_no: string;
  mobile: string;
};

/** Filters an already-fetched list. The list is per-vendor because RLS scoped the query
 *  that produced it -- there is no vendor filter to apply here, and adding one would be
 *  a weaker second copy of customers_read. */
export function matchCustomers(all: readonly Customer[], query: string): Customer[] {
  const q = query.trim().toLowerCase();
  if (q === "") return [...all];
  return all.filter((c) =>
    c.name.toLowerCase().includes(q) ||
    c.flat_no.toLowerCase().includes(q) ||
    c.mobile.includes(q),
  );
}

const REQUIRED = ["name", "flat_no", "mobile"] as const;

export function validateCustomer(
  input: { name: string; flat_no: string; mobile: string },
): { ok: true } | { ok: false; missing: ("name" | "flat_no" | "mobile")[] } {
  // #11 makes all three mandatory. Report every missing field at once: a recorder with a
  // customer waiting should not learn about them one submit at a time.
  const missing = REQUIRED.filter((f) => input[f].trim() === "");
  return missing.length ? { ok: false, missing: [...missing] } : { ok: true };
}

export function isDuplicateMobile(error: { code?: string; message?: string } | null): boolean {
  if (!error || error.code !== "23505") return false;
  return /customers_vendor_id_mobile_key|customers.*mobile/i.test(error.message ?? "");
}
```

- [ ] **Step 4: Run the test**

Run: `npm --prefix web test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add web/src/customers.ts web/src/__tests__/customers.test.ts
git commit -m "feat(web): pure customer search, validation and duplicate detection"
```

---

## Task 3: The data layer

**Files:**
- Create: `web/src/data.ts`
- Test: `web/src/__tests__/data.test.ts`

**Interfaces:**
- Consumes: `supabase` from `./supabase`; `Customer` from `./customers`; `Draft` from `./billing`.
- Produces:
  - `type Item = { id: string; name_en: string; name_hi: string; name_mr: string; price: number; stock_kg: number; is_active: boolean }`
  - `type PendingBill = { id: string; token_no: number; total: number; customers: { name: string; flat_no: string } | null }`
  - `listItems(): Promise<{ data: Item[] | null; error: PostgrestErrorLike }>`
  - `listCustomers(): Promise<{ data: Customer[] | null; error: PostgrestErrorLike }>`
  - `createCustomer(vendorId, input): Promise<{ data: Customer | null; error: PostgrestErrorLike }>`
  - `createBill(vendorId, customerId, recorderId): Promise<{ data: { id: string } | null; error: PostgrestErrorLike }>`
  - `addLines(vendorId, billId, lines: readonly Draft[]): Promise<{ error: PostgrestErrorLike }>`
  - `issueToken(billId): Promise<{ data: number | null; error: PostgrestErrorLike }>`
  - `listPending(): Promise<{ data: PendingBill[] | null; error: PostgrestErrorLike }>`
  - `completeBill(billId): Promise<{ error: PostgrestErrorLike }>`
  - `type PostgrestErrorLike = { message?: string; code?: string } | null`

- [ ] **Step 1: Write the failing test**

The point of this test is the `vendor_id` rule and the shape of what is sent — not the
network. It stubs the client at the module boundary.

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";

const insert = vi.fn(() => ({ select: () => ({ single: async () => ({ data: { id: "b1" }, error: null }) }) }));
const rpc = vi.fn(async () => ({ data: 7, error: null }));
const from = vi.fn(() => ({
  insert,
  select: () => ({ order: async () => ({ data: [], error: null }), eq: () => ({ order: async () => ({ data: [], error: null }) }) }),
}));

vi.mock("../supabase", () => ({ supabase: { from: (...a: unknown[]) => from(...a), rpc: (...a: unknown[]) => rpc(...a) } }));

const { createBill, addLines, issueToken } = await import("../data");

beforeEach(() => { insert.mockClear(); rpc.mockClear(); from.mockClear(); });

describe("createBill", () => {
  it("sends vendor_id and status=recording", async () => {
    // vendor_id is NOT NULL with no default; omitting it was a real shipped bug.
    // status must be 'recording' or bills_recorder_insert's WITH CHECK refuses the row.
    await createBill("v1", "c1", "u1");
    expect(from).toHaveBeenCalledWith("bills");
    expect(insert).toHaveBeenCalledWith(expect.objectContaining({
      vendor_id: "v1", customer_id: "c1", recorder_id: "u1", status: "recording",
    }));
  });

  it("never sends a total", async () => {
    // issue_token recomputes the total from the line items precisely because the client
    // cannot be trusted with it. Sending one invites someone to believe it matters.
    await createBill("v1", "c1", "u1");
    expect(insert.mock.calls[0]?.[0]).not.toHaveProperty("total");
  });
});

describe("addLines", () => {
  it("stamps vendor_id on every line and computes line_total", async () => {
    await addLines("v1", "b1", [
      { itemId: "i1", name: "Onion", unitPrice: 40, qtyKg: 2 },
      { itemId: "i2", name: "Beet", unitPrice: 30, qtyKg: 1.5 },
    ]);
    expect(insert).toHaveBeenCalledWith([
      { bill_id: "b1", vendor_id: "v1", item_id: "i1", qty_kg: 2, unit_price: 40, line_total: 80 },
      { bill_id: "b1", vendor_id: "v1", item_id: "i2", qty_kg: 1.5, unit_price: 30, line_total: 45 },
    ]);
  });

  it("does nothing on an empty basket", async () => {
    await addLines("v1", "b1", []);
    expect(insert).not.toHaveBeenCalled();
  });
});

describe("issueToken", () => {
  it("calls the function with the parameter name the migration declares", async () => {
    // 0003_functions.sql declares issue_token(p_bill_id uuid). A different key here is
    // a runtime error PostgREST reports as "function not found".
    const r = await issueToken("b1");
    expect(rpc).toHaveBeenCalledWith("issue_token", { p_bill_id: "b1" });
    expect(r.data).toBe(7);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npm --prefix web test`
Expected: FAIL — cannot resolve `../data`.

- [ ] **Step 3: Implement `web/src/data.ts`**

```ts
import { supabase } from "./supabase";
import { lineTotal, type Draft } from "./billing";
import type { Customer } from "./customers";

export type PostgrestErrorLike = { message?: string; code?: string } | null;

export type Item = {
  id: string;
  name_en: string;
  name_hi: string;
  name_mr: string;
  price: number;
  stock_kg: number;
  is_active: boolean;
};

export type PendingBill = {
  id: string;
  token_no: number;
  total: number;
  customers: { name: string; flat_no: string } | null;
};

/**
 * Every PostgREST call in the billing flow lives here.
 *
 * Two reasons. It puts the vendor_id rule in one place instead of six call sites -- the
 * columns are NOT NULL with no default, and forgetting one is a bug that has already
 * shipped once. And it gives the screens a small surface to stub in tests, so component
 * tests never mock supabase-js itself.
 *
 * None of these functions filters by vendor. They do not need to: RLS scopes every
 * query to the caller's tenant, and a client-side filter would be a weaker second copy
 * of the policy.
 */

export async function listItems() {
  return supabase
    .from("items")
    .select("id, name_en, name_hi, name_mr, price, stock_kg, is_active")
    .eq("is_active", true)
    .order("name_en");
}

export async function listCustomers() {
  return supabase.from("customers").select("id, name, flat_no, mobile").order("name");
}

export async function createCustomer(
  vendorId: string,
  input: { name: string; flat_no: string; mobile: string },
) {
  return supabase
    .from("customers")
    .insert({ vendor_id: vendorId, ...input })
    .select("id, name, flat_no, mobile")
    .single();
}

export async function createBill(vendorId: string, customerId: string, recorderId: string) {
  // No total. issue_token recomputes it from the line items, and sending one here would
  // suggest the client's figure is authoritative when the server discards it.
  return supabase
    .from("bills")
    .insert({
      vendor_id: vendorId,
      customer_id: customerId,
      recorder_id: recorderId,
      status: "recording",
    })
    .select("id")
    .single();
}

export async function addLines(vendorId: string, billId: string, lines: readonly Draft[]) {
  if (lines.length === 0) return { error: null as PostgrestErrorLike };
  return supabase.from("bill_items").insert(
    lines.map((l) => ({
      bill_id: billId,
      vendor_id: vendorId,
      item_id: l.itemId,
      qty_kg: l.qtyKg,
      unit_price: l.unitPrice,
      line_total: lineTotal(l.unitPrice, l.qtyKg),
    })),
  );
}

/** Parameter names must match 0003_functions.sql exactly; PostgREST resolves the
 *  overload by argument name, and a mismatch reads as "function not found". */
export async function issueToken(billId: string) {
  return supabase.rpc("issue_token", { p_bill_id: billId });
}

export async function listPending() {
  return supabase
    .from("bills")
    .select("id, token_no, total, customers(name, flat_no)")
    .eq("status", "billed")
    .order("token_no", { ascending: false });
}

export async function completeBill(billId: string) {
  return supabase.rpc("complete_bill", { p_bill_id: billId });
}

export type { Customer, Draft };
```

- [ ] **Step 4: Run the test**

Run: `npm --prefix web test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add web/src/data.ts web/src/__tests__/data.test.ts
git commit -m "feat(web): the billing flow's data layer"
```

---

## Task 4: i18n keys for the billing flow

**Files:**
- Modify: `web/src/i18n/en.json`, `web/src/i18n/hi.json`, `web/src/i18n/mr.json`
- Test: `web/src/__tests__/i18n-billing.test.ts`

**Interfaces:**
- Consumes: the existing i18n setup.
- Produces: a `bill` and a `pending` top-level key block in all three locales.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from "vitest";
import en from "../i18n/en.json";
import hi from "../i18n/hi.json";
import mr from "../i18n/mr.json";

const flatten = (o: Record<string, unknown>, p = ""): string[] =>
  Object.entries(o).flatMap(([k, v]) =>
    v && typeof v === "object" ? flatten(v as Record<string, unknown>, `${p}${k}.`) : [`${p}${k}`],
  );

describe("billing translations", () => {
  it("adds the keys the billing screens need", () => {
    for (const key of [
      "bill.chooseCustomer", "bill.searchCustomer", "bill.newCustomer", "bill.name",
      "bill.flatNo", "bill.mobile", "bill.save", "bill.customerExists", "bill.required",
      "bill.addItem", "bill.weightKg", "bill.add", "bill.basket", "bill.total",
      "bill.empty", "bill.done", "bill.confirmTitle", "bill.confirmBody", "bill.cancel",
      "bill.tokenTitle", "bill.startNew", "bill.remove", "bill.stock", "bill.outOfStock",
      "bill.badWeight.empty", "bill.badWeight.notANumber",
      "bill.badWeight.notPositive", "bill.badWeight.tooPrecise",
      "pending.title", "pending.empty", "pending.token", "pending.complete",
      "pending.confirmBody", "pending.completed", "pending.pointsAwarded",
    ]) {
      expect(flatten(en), `missing en: ${key}`).toContain(key);
    }
  });

  it("keeps every locale's key structure identical", () => {
    // A key present in en but missing from mr silently falls back to English for a
    // Marathi user -- which looks like a translation nobody wrote, not a bug.
    const a = flatten(en).sort();
    expect(flatten(hi).sort()).toEqual(a);
    expect(flatten(mr).sort()).toEqual(a);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npm --prefix web test`
Expected: FAIL — the `bill.*` and `pending.*` keys are absent.

- [ ] **Step 3: Add the keys**

Add a `bill` and a `pending` block to each of the three files, with every key the test
lists. English content:

```json
"bill": {
  "chooseCustomer": "Choose a customer",
  "searchCustomer": "Search by name, flat or mobile",
  "newCustomer": "New customer",
  "name": "Name",
  "flatNo": "Flat no",
  "mobile": "Mobile",
  "save": "Save",
  "customerExists": "That customer already exists — using their record.",
  "required": "All three fields are required.",
  "addItem": "Add item",
  "weightKg": "Weight (kg)",
  "add": "Add",
  "basket": "Basket",
  "total": "Total",
  "empty": "No items yet.",
  "done": "Done",
  "confirmTitle": "Issue the token?",
  "confirmBody": "The bill cannot be changed after this.",
  "cancel": "Cancel",
  "tokenTitle": "Token",
  "startNew": "Start new bill",
  "remove": "Remove",
  "stock": "{{kg}} kg in stock",
  "outOfStock": "Out of stock",
  "badWeight": {
    "empty": "Enter a weight.",
    "notANumber": "That is not a number.",
    "notPositive": "Weight must be more than zero.",
    "tooPrecise": "At most two decimal places."
  }
},
"pending": {
  "title": "Waiting to be billed",
  "empty": "Nothing waiting.",
  "token": "Token {{n}}",
  "complete": "Complete",
  "confirmBody": "Complete this bill and award points?",
  "completed": "Completed.",
  "pointsAwarded": "{{n}} points awarded"
}
```

Write the Hindi and Marathi equivalents. **Say in your report that these need
native-speaker review** — so do the existing strings, and the list must not shrink
silently.

- [ ] **Step 4: Run the test**

Run: `npm --prefix web test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add web/src/i18n web/src/__tests__/i18n-billing.test.ts
git commit -m "feat(web): translations for the billing flow"
```

---

## Task 5: The recorder's bill screen

**Files:**
- Create: `web/src/screens/Bill.tsx`, `web/src/screens/bill/CustomerStep.tsx`,
  `web/src/screens/bill/ItemGrid.tsx`, `web/src/screens/bill/Basket.tsx`,
  `web/src/screens/bill/TokenResult.tsx`
- Modify: `web/src/App.tsx` (replace the `/bill` placeholder)
- Test: `web/src/__tests__/Bill.test.tsx`

**Interfaces:**
- Consumes: `useSession`, everything from `billing.ts`, `customers.ts`, `data.ts`,
  `itemName` from `i18n/locales.ts`, `describeError` from `errors.ts`.
- Produces: the `/bill` route.

The screen holds one state machine: `phase: "customer" | "items" | "done"`, plus
`lines: Draft[]`, plus `token: number | null`.

- [ ] **Step 1: Write the failing test**

```tsx
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

vi.mock("../data", () => ({
  listItems: vi.fn(async () => ({ data: [{ id: "i1", name_en: "Onion", name_hi: "प्याज", name_mr: "कांदा", price: 40, stock_kg: 100, is_active: true }], error: null })),
  listCustomers: vi.fn(async () => ({ data: [{ id: "c1", name: "Asha", flat_no: "A-1", mobile: "+9198" }], error: null })),
  createCustomer: vi.fn(),
  createBill: vi.fn(async () => ({ data: { id: "b1" }, error: null })),
  addLines: vi.fn(async () => ({ error: null })),
  issueToken: vi.fn(async () => ({ data: 7, error: null })),
}));

vi.mock("../components/SessionProvider", () => ({
  useSession: () => ({ kind: "ready", userId: "u1", vendorId: "v1", vendorName: "V", name: "R", role: "recorder" }),
}));

const { default: Bill } = await import("../screens/Bill");
const data = await import("../data");

beforeEach(() => vi.clearAllMocks());

describe("the bill screen", () => {
  it("issues a token through the full flow", async () => {
    render(<Bill />);

    // 1. pick the customer
    fireEvent.click(await screen.findByText("Asha"));

    // 2. add a line
    fireEvent.click(await screen.findByText(/Onion|कांदा/));
    fireEvent.change(screen.getByLabelText(/weight/i), { target: { value: "2" } });
    fireEvent.click(screen.getByRole("button", { name: /^add$/i }));

    // the running total is feedback for the recorder
    expect(await screen.findByText(/80/)).toBeTruthy();

    // 3. Done is guarded by a confirm, because the basket freezes afterwards
    fireEvent.click(screen.getByRole("button", { name: /done/i }));
    fireEvent.click(screen.getByRole("button", { name: /issue the token/i }));

    await waitFor(() => expect(data.issueToken).toHaveBeenCalledWith("b1"));
    expect(data.createBill).toHaveBeenCalledWith("v1", "c1", "u1");
    expect(data.addLines).toHaveBeenCalledWith("v1", "b1", [
      { itemId: "i1", name: expect.any(String), unitPrice: 40, qtyKg: 2 },
    ]);
    expect(await screen.findByText("7")).toBeTruthy();
  });

  it("will not issue a token for an empty basket", async () => {
    render(<Bill />);
    fireEvent.click(await screen.findByText("Asha"));
    expect(screen.getByRole("button", { name: /done/i })).toHaveProperty("disabled", true);
    expect(data.issueToken).not.toHaveBeenCalled();
  });

  it("rejects a weight with more precision than the column stores", async () => {
    render(<Bill />);
    fireEvent.click(await screen.findByText("Asha"));
    fireEvent.click(await screen.findByText(/Onion|कांदा/));
    fireEvent.change(screen.getByLabelText(/weight/i), { target: { value: "1.234" } });
    fireEvent.click(screen.getByRole("button", { name: /^add$/i }));
    expect(await screen.findByText(/two decimal places|दोन|दो/i)).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npm --prefix web test`
Expected: FAIL — cannot resolve `../screens/Bill`.

- [ ] **Step 3: Build the screen**

Write `Bill.tsx` as the state machine, with the four child components. Requirements the
test does not spell out but the spec does:

- **Item tiles** render `itemName(item, lang)` — never `name_en` directly — with the price
  and `bill.stock` / `bill.outOfStock`. Colour a tile whose `stock_kg` is under 10, and
  again at 0. **Do not disable it**: `complete_bill` clamps at zero deliberately, and
  blocking the sale client-side would be a weaker second copy of a rule the database owns.
- **The weight input** is `<input type="text" inputMode="decimal">` with a `<label>` so
  `getByLabelText(/weight/i)` finds it. Invalid input renders `bill.badWeight.<reason>`.
- **Basket lines** are tappable to remove (`bill.remove`); the running total comes from
  `runningTotal(lines)`.
- **Done** is disabled when the basket is empty or `navigator.onLine` is false — the
  offline rule from §1 of the spec: a token cannot be issued offline, so do not let a
  recorder promise one.
- **The confirm dialog** uses `bill.confirmTitle` / `bill.confirmBody`, and its accept
  button is what actually calls `createBill` → `addLines` → `issueToken`, in that order.
  Creating the bill only at Done keeps abandoned baskets out of the database entirely.
- **The token screen** shows the number large, plus `bill.startNew`, which resets to
  `phase: "customer"` with empty lines.
- **Errors** from any call render through `describeError`; a duplicate mobile in the create
  form uses `isDuplicateMobile` and `bill.customerExists`.

- [ ] **Step 4: Wire the route**

In `web/src/App.tsx`, replace
`<Route path="/bill" element={<Placeholder titleKey="nav.bill" />} />`
with `<Route path="/bill" element={<Bill />} />` and import it.

- [ ] **Step 5: Run the tests and the build**

```bash
npm --prefix web test
npm --prefix web run build
```

Expected: all pass; the build is clean under `strict` and `noUncheckedIndexedAccess`.

- [ ] **Step 6: Commit**

```bash
git add web/src/screens web/src/App.tsx web/src/__tests__/Bill.test.tsx
git commit -m "feat(web): the recorder bill flow with edit-before-Done"
```

---

## Task 6: The biller's pending queue

**Files:**
- Create: `web/src/screens/Pending.tsx`
- Modify: `web/src/App.tsx` (replace the `/pending` placeholder)
- Test: `web/src/__tests__/Pending.test.tsx`

**Interfaces:**
- Consumes: `listPending`, `completeBill` from `data.ts`; `describeError`.
- Produces: the `/pending` route.

- [ ] **Step 1: Write the failing test**

```tsx
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

const listPending = vi.fn(async () => ({
  data: [{ id: "b1", token_no: 7, total: 500, customers: { name: "Asha", flat_no: "A-1" } }],
  error: null,
}));
const completeBill = vi.fn(async () => ({ error: null }));
vi.mock("../data", () => ({ listPending: (...a: unknown[]) => listPending(...a), completeBill: (...a: unknown[]) => completeBill(...a) }));

const { default: Pending } = await import("../screens/Pending");

beforeEach(() => vi.clearAllMocks());

describe("the pending queue", () => {
  it("lists a waiting bill by token and customer", async () => {
    render(<Pending />);
    expect(await screen.findByText(/7/)).toBeTruthy();
    expect(screen.getByText(/Asha/)).toBeTruthy();
  });

  it("completes a bill after confirming", async () => {
    render(<Pending />);
    fireEvent.click(await screen.findByRole("button", { name: /complete/i }));
    fireEvent.click(screen.getByRole("button", { name: /complete this bill|yes/i }));
    await waitFor(() => expect(completeBill).toHaveBeenCalledWith("b1"));
  });

  it("disables the button while the call is in flight", async () => {
    // complete_bill is idempotent, so a double tap is harmless -- but a spinner is
    // cheaper than explaining idempotency to a biller with a queue.
    let release: (v: { error: null }) => void = () => {};
    completeBill.mockImplementationOnce(() => new Promise((r) => { release = r; }));
    render(<Pending />);
    fireEvent.click(await screen.findByRole("button", { name: /complete/i }));
    fireEvent.click(screen.getByRole("button", { name: /complete this bill|yes/i }));
    await waitFor(() => {
      const b = screen.getByRole("button", { name: /complete/i });
      expect(b).toHaveProperty("disabled", true);
    });
    release({ error: null });
  });

  it("says so plainly when nothing is waiting", async () => {
    listPending.mockResolvedValueOnce({ data: [], error: null });
    render(<Pending />);
    // An empty queue is the normal state of a quiet shop, not an error or a blank box.
    expect(await screen.findByText(/nothing waiting|काही नाही|कुछ नहीं/i)).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npm --prefix web test`
Expected: FAIL — cannot resolve `../screens/Pending`.

- [ ] **Step 3: Build the screen**

A list of `listPending()` rows, newest token first, each showing `pending.token`, the
customer's name and flat, and the total. A Complete button opens a confirm
(`pending.confirmBody`); accepting calls `completeBill`, disables while in flight, then
refetches the list. On success show `pending.completed`. Errors render through
`describeError`. An empty list renders `pending.empty` — an empty queue is a quiet shop,
not a failure.

- [ ] **Step 4: Wire the route**

Replace the `/pending` placeholder in `web/src/App.tsx` with `<Pending />`.

- [ ] **Step 5: Run the tests and the build**

```bash
npm --prefix web test
npm --prefix web run build
```

- [ ] **Step 6: Commit**

```bash
git add web/src/screens/Pending.tsx web/src/App.tsx web/src/__tests__/Pending.test.tsx
git commit -m "feat(web): the biller completion queue"
```

---

## Task 7: Verify against the live project, and record what was checked

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Build and preview**

```bash
npm --prefix web run build
npm --prefix web run preview
```

- [ ] **Step 2: Walk the real flow**

Signed in against the live project, record what you observe at each step:

1. Create a customer with all three fields; confirm a duplicate mobile reports
   "already exists" rather than a constraint error.
2. Build a bill with two lines; check the running total.
3. Press Done, confirm, and note the token number.
4. Check in the Supabase dashboard that `bills.total` equals the **line-item sum** — this
   is the server recomputing it, and the point of not trusting the client's figure.
5. As the biller, complete that bill; confirm the points awarded match the vendor's
   configured thresholds and that `items.stock_kg` decreased.

**If you cannot sign in, say so plainly and list what you could not verify.** Do not
invent results and do not stub the client to work around it. Stage 1 shipped two Critical
bugs that only a real sign-in would have caught; this step exists because of them.

- [ ] **Step 3: Update `README.md`**

Change the Live section: `/bill` and `/pending` are real; items, customers, staff and
dashboards remain placeholders until stage 3. Record what the live walkthrough confirmed,
and anything it could not.

- [ ] **Step 4: Commit**

```bash
git add README.md
git commit -m "docs: stage 2 is live; record what the walkthrough verified"
```

---

## Self-review notes

Checked against the spec:

- §5 recorder flow → Task 5; biller flow → Task 6.
- §5 `vendor_id` explicit → Task 3, enforced in one module and asserted by its test.
- §5 client total ignored → Task 3 (`createBill` sends no total) and Task 1 (running total
  is display-only).
- §5 Done is one-way → Task 5's confirm dialog; no undo is offered anywhere.
- §11a customer step, item grid, basket, token screen → Task 5.
- §11a stock shown not enforced → Task 5, stated as a requirement with its reason.
- §11a pending queue → Task 6.
- §11a no bill deletion → not built, deliberately.
- §11a testing → pure logic in Tasks 1-2 with no mocks; component tests in Tasks 5-6
  mocking only `data.ts`, never `supabase-js`.
- §1 offline: Done disabled → Task 5. The banner already exists from stage 1.
- Global: i18n keys in all three locales → Task 4, with a structural equality test.

**Gap I am carrying, not closing:** E2E remains impossible without PostgREST and GoTrue in
the test environment. Task 7 is a manual walkthrough, which is weaker than a test and
cannot run in CI. Unchanged from stage 1 and closed only by a Cloud test project.
