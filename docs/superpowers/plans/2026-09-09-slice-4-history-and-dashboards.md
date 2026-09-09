# Slice 4 — Bill History and Dashboards Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the shop its own numbers — a completed-bill history and a dashboard, both filtered by date — plus the item list and the Settings/Staff merge the vendor asked for.

**Architecture:** One pure `dateRange.ts` owns every date boundary so two screens cannot disagree about what "this week" means. One `history.ts` holds the new PostgREST calls, mirroring `data.ts` (billing) and `admin.ts` (admin). Migration `0007` adds two invoker-rights functions so top-items and bought-together can answer a date range, which today's views cannot. Screens follow the shape settled in slice 3.

**Tech Stack:** React 19, TypeScript, react-router-dom 7, react-i18next 17, Tailwind 4, Vitest 5 + @testing-library/react, supabase-js 2, PostgreSQL 17.

**Spec:** `docs/superpowers/specs/2026-09-09-slice-4-history-and-dashboards-design.md`

## Global Constraints

- **Never filter by vendor in a client query.** RLS scopes every read; a client-side vendor filter is a weaker second copy of the policy. Stated in `web/src/data.ts`'s header.
- **`vendor_id` is NOT NULL with no default** on every child table; every INSERT carries it, no UPDATE re-sends it.
- **RPC parameter names must match the migration exactly** — PostgREST resolves overloads by argument name; a mismatch reads as "function not found".
- **New SQL functions must NOT be `SECURITY DEFINER`.** They run as the caller and inherit the `0002` policies. A definer function here hands every vendor everyone else's numbers.
- **Route guards are UX, not security** (`web/src/routes.ts` header). Never move an authorization decision there.
- **A blocked write is an error (42501); a filtered read is zero rows.** An empty list says "nothing yet", never "not allowed". See `web/src/errors.ts`.
- **All money renders through `rupees()`** from `web/src/money.ts`.
- **Every user-facing string gets a key in all three of** `web/src/i18n/{en,hi,mr}.json`. The `hi`/`mr` values are AI-written and unreviewed — a documented debt.
- **Tap targets are `min-h-[44px]`.**
- **Component tests query by `data-testid`, not by visible copy.** (Corrected 2026-09-09: earlier drafts of this plan claimed the suite runs in Marathi. Measured, it does not — jsdom reports `navigator.languages = ["en-US","en"]`, so `resolveLang` returns `en`. Marathi is the PRODUCTION fallback for a browser with no matching language.) The convention stands on its own merit: `data-testid` does not couple a test to translated strings that are AI-written and expected to change.
- **Corrected 2026-09-09: the `tests/` suite DOES run locally** — `npm test` at the repo root passes 76/76 against the machine's native PostgreSQL. This plan originally claimed it could not, inferred from `psql` and `docker` being absent from PATH. That inference was wrong: the suite connects through the `pg` node driver and never invokes the psql binary. **CI remains the authority for the WEB build**, though, and that part is verified rather than assumed: TypeScript 7 ships as a per-platform native binary and the Windows build has already passed code the Linux build rejects. A local green is a smoke test.
- **Web tests:** `cd web && npm test` (currently 165 across 21 files — must not go down). **DB tests:** `npm test` at the repo root, CI only.

---

## File Structure

**Create:**
- `supabase/migrations/0007_analytics_by_date.sql` — `top_items_between`, `bought_together_between`.
- `tests/analytics.test.mjs` — DB tests for both, including tenant isolation.
- `web/src/dateRange.ts` — presets, validation, and the timestamp bounds. Pure.
- `web/src/history.ts` — the PostgREST calls for history and dashboards.
- `web/src/components/DateFilter.tsx` — the shared preset + custom-range control.
- `web/src/screens/Completed.tsx` — the paged bill history.
- `web/src/screens/Dashboards.tsx` — the totals.
- Tests: `web/src/__tests__/dateRange.test.ts`, `history.test.ts`, `DateFilter.test.tsx`, `Completed.test.tsx`, `Dashboards.test.tsx`.

**Modify:**
- `web/src/screens/bill/ItemGrid.tsx` — grid becomes a list.
- `web/src/screens/Settings.tsx` — absorbs Staff as a section.
- `web/src/routes.ts` — add `/completed`; drop `/staff` from the nav.
- `web/src/App.tsx` — new routes, `/staff` redirect, `/dashboards` stops being a Placeholder.
- `web/src/i18n/{en,hi,mr}.json` — new namespaces.
- `web/src/__tests__/{routes,Items,App}.test.*` — updated expectations.
- `README.md` — what slice 4 ships and what it still cannot do.

---

## A correction to the spec, made here deliberately

§4 of the spec says the dashboard's money-collected and bill-count come from
`v_payments_daily/weekly/monthly`. **This plan does not use those views for the totals.**

Those views bucket with `date_trunc('day', completed_at)`, which resolves in the database
server's timezone — UTC on Supabase. The shops are in India, UTC+5:30. A sale rung up at
02:00 IST is 20:30 the *previous* day in UTC, so a "today" filter driven by UTC buckets
would attribute the first five and a half hours of every Indian day to yesterday. Nobody
would notice until they compared the dashboard against the cash drawer.

So the totals are a direct aggregate over `bills` between two explicit `timestamptz`
bounds, which is correct in any timezone because the comparison happens on the instant,
not on a truncated local day. The three views stay exactly as they are for `console.html`.

Task 5 implements this. It is called out here because a reviewer comparing plan to spec
will otherwise read it as a mistake.

---

### Task 1: Routes and translations for the whole slice

Everything downstream needs these keys. Doing them once keeps the three locale files in step.

**Files:**
- Modify: `web/src/routes.ts`
- Modify: `web/src/i18n/en.json`, `hi.json`, `mr.json`
- Test: `web/src/__tests__/routes.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: route `/completed` (`labelKey: "nav.completed"`) for admin and biller; `/staff` removed from every nav list; i18n namespaces `range.*`, `completed.*`, `dash.*` and the added `settings.staffSection` / `settings.loyaltySection`.

- [ ] **Step 1: Write the failing test**

Replace the three role expectations in `web/src/__tests__/routes.test.ts` and add a guard test:

```ts
  it("gives the recorder billing and customers", () => {
    expect(routesForRole("recorder").map((r) => r.path)).toEqual(["/bill", "/customers"]);
  });

  it("gives the biller the queue and the history", () => {
    // A biller completes bills and sees each total as they do it, so the record of what
    // they completed is theirs too. bills_read would permit more; this is nav, not policy.
    expect(routesForRole("biller").map((r) => r.path)).toEqual(["/pending", "/completed"]);
  });

  it("gives admin the full set, with staff folded into settings", () => {
    expect(routesForRole("admin").map((r) => r.path)).toEqual([
      "/bill",
      "/pending",
      "/completed",
      "/items",
      "/customers",
      "/settings",
      "/dashboards",
    ]);
  });

  it("no longer lists /staff anywhere", () => {
    // The screen still exists, as a section of /settings. The route survives as a
    // redirect (App.tsx) because it has been linkable since stage 3.
    for (const role of ["admin", "recorder", "biller"] as const) {
      expect(routesForRole(role).some((r) => r.path === "/staff")).toBe(false);
    }
  });

  it("keeps the history away from recorders", () => {
    expect(canAccess("recorder", "/completed")).toBe(false);
    expect(canAccess("biller", "/completed")).toBe(true);
    expect(canAccess("admin", "/completed")).toBe(true);
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd web && npx vitest run src/__tests__/routes.test.ts`
Expected: FAIL — `/completed` is absent and `/staff` is still listed.

- [ ] **Step 3: Update the route table**

In `web/src/routes.ts`, replace the `BY_ROLE` entries for `biller` and `admin`:

```ts
  biller: [
    { path: "/pending", labelKey: "nav.pending" },
    { path: "/completed", labelKey: "nav.completed" },
  ],
  admin: [
    { path: "/bill", labelKey: "nav.bill" },
    { path: "/pending", labelKey: "nav.pending" },
    { path: "/completed", labelKey: "nav.completed" },
    { path: "/items", labelKey: "nav.items" },
    { path: "/customers", labelKey: "nav.customers" },
    { path: "/settings", labelKey: "nav.settings" },
    { path: "/dashboards", labelKey: "nav.dashboards" },
  ],
```

Leave `recorder` unchanged. Do not delete the `/staff` route from `App.tsx` — Task 8 turns it into a redirect.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd web && npx vitest run src/__tests__/routes.test.ts`
Expected: PASS.

- [ ] **Step 5: Add the English strings**

In `web/src/i18n/en.json`, add `"completed": "Completed"` to the existing `nav` object, add two keys to the existing `settings` object, and add two new top-level namespaces:

```json
  "range": {
    "today": "Today",
    "week": "This week",
    "month": "This month",
    "custom": "Custom",
    "from": "From",
    "to": "To",
    "apply": "Apply",
    "backwards": "The start date is after the end date."
  },
  "completed": {
    "title": "Completed bills",
    "empty": "No completed bills in this period.",
    "token": "Token {{n}}",
    "loadMore": "Load more",
    "loading": "Loading…",
    "lines": "Items",
    "qtyLine": "{{qty}} kg",
    "noCustomer": "No customer"
  },
  "dash": {
    "title": "Dashboards",
    "collected": "Money collected",
    "billCount": "Completed bills",
    "topItems": "Top items",
    "topItemsSub": "By weight sold",
    "together": "Bought together",
    "togetherSub": "Pairs seen 3 or more times",
    "empty": "Nothing in this period.",
    "kg": "{{kg}} kg",
    "pairCount": "{{n}} bills"
  }
```

Add into the existing `settings` object:

```json
    "loyaltySection": "Loyalty",
    "staffSection": "Staff"
```

- [ ] **Step 6: Add the Hindi strings**

In `web/src/i18n/hi.json`, add `"completed": "पूरे हुए"` to `nav`, the same two keys in `settings`, and:

```json
  "range": {
    "today": "आज",
    "week": "इस हफ्ते",
    "month": "इस महीने",
    "custom": "अपनी तारीख",
    "from": "से",
    "to": "तक",
    "apply": "लागू करें",
    "backwards": "शुरू की तारीख आखिरी तारीख के बाद है।"
  },
  "completed": {
    "title": "पूरे हुए बिल",
    "empty": "इस अवधि में कोई पूरा बिल नहीं।",
    "token": "टोकन {{n}}",
    "loadMore": "और दिखाएं",
    "loading": "लोड हो रहा है…",
    "lines": "सामान",
    "qtyLine": "{{qty}} किलो",
    "noCustomer": "कोई ग्राहक नहीं"
  },
  "dash": {
    "title": "डैशबोर्ड",
    "collected": "कुल वसूली",
    "billCount": "पूरे हुए बिल",
    "topItems": "सबसे ज़्यादा बिकने वाले",
    "topItemsSub": "वजन के हिसाब से",
    "together": "साथ में खरीदे गए",
    "togetherSub": "3 या ज़्यादा बिलों में साथ",
    "empty": "इस अवधि में कुछ नहीं।",
    "kg": "{{kg}} किलो",
    "pairCount": "{{n}} बिल"
  }
```

Settings additions: `"loyaltySection": "लॉयल्टी"`, `"staffSection": "स्टाफ"`.

- [ ] **Step 7: Add the Marathi strings**

In `web/src/i18n/mr.json`, add `"completed": "पूर्ण झालेले"` to `nav`, the same two `settings` keys, and:

```json
  "range": {
    "today": "आज",
    "week": "या आठवड्यात",
    "month": "या महिन्यात",
    "custom": "स्वतःची तारीख",
    "from": "पासून",
    "to": "पर्यंत",
    "apply": "लागू करा",
    "backwards": "सुरुवातीची तारीख शेवटच्या तारखेनंतर आहे."
  },
  "completed": {
    "title": "पूर्ण झालेली बिले",
    "empty": "या काळात एकही पूर्ण बिल नाही.",
    "token": "टोकन {{n}}",
    "loadMore": "आणखी दाखवा",
    "loading": "लोड होत आहे…",
    "lines": "माल",
    "qtyLine": "{{qty}} किलो",
    "noCustomer": "ग्राहक नाही"
  },
  "dash": {
    "title": "डॅशबोर्ड",
    "collected": "एकूण जमा",
    "billCount": "पूर्ण झालेली बिले",
    "topItems": "सर्वाधिक विकलेले",
    "topItemsSub": "वजनानुसार",
    "together": "एकत्र घेतलेले",
    "togetherSub": "3 किंवा अधिक बिलांत एकत्र",
    "empty": "या काळात काहीही नाही.",
    "kg": "{{kg}} किलो",
    "pairCount": "{{n}} बिले"
  }
```

Settings additions: `"loyaltySection": "लॉयल्टी"`, `"staffSection": "कर्मचारी"`.

- [ ] **Step 8: Run the whole suite**

Run: `cd web && npm test` — expected PASS. Then `cd web && npm run build` — expected clean.

- [ ] **Step 9: Commit**

```bash
git add web/src/routes.ts web/src/i18n web/src/__tests__/routes.test.ts
git commit -m "feat: add the /completed route and slice 4's translation keys"
```

---

### Task 2: The new-bill item list

**Files:**
- Modify: `web/src/screens/bill/ItemGrid.tsx`
- Test: `web/src/__tests__/Bill.test.tsx`

**Interfaces:**
- Consumes: `Item` from `../../data`, `validateWeight`/`Draft` from `../../billing`, `itemName`/`Lang`, `rupees`.
- Produces: no signature change. `ItemGrid({ items, lang, onAdd })` keeps its exact props — only the markup changes.

- [ ] **Step 1: Write the failing test**

Add to `web/src/__tests__/Bill.test.tsx`, keeping every existing test:

```tsx
  it("shows items as one row each, not a two-column grid", async () => {
    // The vendor asked for a list. The grid class is the thing being replaced, so this
    // asserts its absence rather than a vaguer 'renders items'.
    const { container } = render(<Bill />);
    await screen.findByText(/Onion|कांदा|प्याज/);
    expect(container.querySelector(".grid-cols-2")).toBeNull();
    expect(container.querySelectorAll("[data-testid^='item-row-']").length).toBeGreaterThan(0);
  });

  it("still takes a decimal weight after tapping a row", async () => {
    // Scales report 1.35. The layout changed; the keypad must not.
    render(<Bill />);
    fireEvent.click(await screen.findByTestId(/^item-row-/));
    const input = screen.getByTestId("weight-input") as HTMLInputElement;
    expect(input.getAttribute("inputmode")).toBe("decimal");
    fireEvent.change(input, { target: { value: "1.35" } });
    expect(input.value).toBe("1.35");
  });
```

If `Bill.test.tsx`'s existing tests select an item by its tile, update those selectors to
`data-testid="item-row-<id>"` in the same commit — do not leave two selection idioms.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd web && npx vitest run src/__tests__/Bill.test.tsx`
Expected: FAIL — `.grid-cols-2` is still present and no `item-row-` testid exists.

- [ ] **Step 3: Convert the grid to a list**

In `web/src/screens/bill/ItemGrid.tsx`, replace the `<div className="grid grid-cols-2 gap-2">` block with a single-column list. Keep `stockClass` and its comment exactly as they are:

```tsx
      <ul className="space-y-2">
        {items.map((item) => (
          <li key={item.id}>
            <button
              data-testid={`item-row-${item.id}`}
              onClick={() => {
                setSelected(item);
                setWeight("");
                setReason(null);
              }}
              className={`w-full flex items-center gap-3 rounded-xl border p-3 min-h-[44px] text-left bg-white ${
                selected?.id === item.id
                  ? "border-emerald-500 ring-2 ring-emerald-200"
                  : "border-slate-200"
              }`}
            >
              <span className="flex-1 min-w-0 font-medium text-slate-800 truncate">
                {itemName(item, lang)}
              </span>
              <span className="text-sm text-slate-600 whitespace-nowrap">{rupees(item.price)}</span>
              <span className={`text-xs whitespace-nowrap ${stockClass(item.stock_kg)}`}>
                {item.stock_kg <= 0 ? t("bill.outOfStock") : t("bill.stock", { kg: item.stock_kg })}
              </span>
            </button>
          </li>
        ))}
      </ul>
```

Add `data-testid="weight-input"` to the existing weight `<input>`. Change nothing else about
that input — it stays `type="text"` with `inputMode="decimal"`.

**Do not add a search box.** The spec (§2) records that as deliberately excluded.
**Do not disable a row for low or zero stock.** Stock is shown, never enforced; the
existing comment in this file explains why and must survive.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd web && npx vitest run src/__tests__/Bill.test.tsx`
Expected: PASS, including every pre-existing test in the file.

- [ ] **Step 5: Commit**

```bash
git add web/src/screens/bill/ItemGrid.tsx web/src/__tests__/Bill.test.tsx
git commit -m "feat: show billable items as a list rather than a grid"
```

---

### Task 3: The shared date range module

Pure. No mocks, no React, no supabase.

**Files:**
- Create: `web/src/dateRange.ts`
- Test: `web/src/__tests__/dateRange.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `type Preset = "today" | "week" | "month"`
  - `type Range = { from: string; to: string }` — inclusive, `YYYY-MM-DD`
  - `PRESETS: readonly Preset[]`
  - `presetRange(preset: Preset, now: Date): Range`
  - `validateRange(from: string, to: string): { ok: true; value: Range } | { ok: false; error: string }`
  - `toBounds(r: Range): { fromTs: string; toTs: string }` — `fromTs` inclusive, `toTs` **exclusive**

- [ ] **Step 1: Write the failing test**

Create `web/src/__tests__/dateRange.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { presetRange, validateRange, toBounds, PRESETS } from "../dateRange";

// A Wednesday, chosen so the week boundary is visibly not the same as the day boundary.
const wed = new Date(2026, 8, 9, 14, 30);

describe("presetRange", () => {
  it("makes today a single inclusive day", () => {
    expect(presetRange("today", wed)).toEqual({ from: "2026-09-09", to: "2026-09-09" });
  });

  it("starts the week on Monday", () => {
    // v_payments_weekly uses date_trunc('week', ...), which is Monday in Postgres. A
    // Sunday-start UI would silently disagree with the data it filters.
    expect(presetRange("week", wed)).toEqual({ from: "2026-09-07", to: "2026-09-09" });
  });

  it("treats Monday itself as the whole week so far", () => {
    const mon = new Date(2026, 8, 7, 9, 0);
    expect(presetRange("week", mon)).toEqual({ from: "2026-09-07", to: "2026-09-07" });
  });

  it("treats Sunday as the END of its week, not the start", () => {
    const sun = new Date(2026, 8, 13, 9, 0);
    expect(presetRange("week", sun)).toEqual({ from: "2026-09-07", to: "2026-09-13" });
  });

  it("runs the month from the first to today", () => {
    expect(presetRange("month", wed)).toEqual({ from: "2026-09-01", to: "2026-09-09" });
  });

  it("offers exactly three presets", () => {
    expect([...PRESETS]).toEqual(["today", "week", "month"]);
  });
});

describe("validateRange", () => {
  it("accepts a normal range", () => {
    const r = validateRange("2026-09-01", "2026-09-09");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toEqual({ from: "2026-09-01", to: "2026-09-09" });
  });

  it("accepts a single day", () => {
    expect(validateRange("2026-09-09", "2026-09-09").ok).toBe(true);
  });

  it("rejects a backwards range rather than sending it", () => {
    // The query would succeed and return nothing, which reads as "no sales" instead of
    // "bad input". A false answer is worse than an error.
    const r = validateRange("2026-09-10", "2026-09-09");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("range.backwards");
  });

  it("rejects a blank or unparseable date", () => {
    expect(validateRange("", "2026-09-09").ok).toBe(false);
    expect(validateRange("2026-09-09", "not-a-date").ok).toBe(false);
    expect(validateRange("2026-13-01", "2026-09-09").ok).toBe(false);
  });
});

describe("toBounds", () => {
  it("makes the end exclusive so the last day is fully included", () => {
    // completed_at is a timestamp. An inclusive '2026-09-09' bound would drop every bill
    // rung up after midnight on the 9th -- which is all of them.
    const b = toBounds({ from: "2026-09-09", to: "2026-09-09" });
    expect(b.fromTs).toBe(new Date(2026, 8, 9, 0, 0, 0).toISOString());
    expect(b.toTs).toBe(new Date(2026, 8, 10, 0, 0, 0).toISOString());
  });

  it("crosses a month boundary correctly", () => {
    const b = toBounds({ from: "2026-08-31", to: "2026-09-01" });
    expect(b.fromTs).toBe(new Date(2026, 7, 31, 0, 0, 0).toISOString());
    expect(b.toTs).toBe(new Date(2026, 8, 2, 0, 0, 0).toISOString());
  });

  it("crosses a year boundary correctly", () => {
    const b = toBounds({ from: "2026-12-31", to: "2026-12-31" });
    expect(b.toTs).toBe(new Date(2027, 0, 1, 0, 0, 0).toISOString());
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd web && npx vitest run src/__tests__/dateRange.test.ts`
Expected: FAIL — cannot resolve `../dateRange`.

- [ ] **Step 3: Write the implementation**

Create `web/src/dateRange.ts`:

```ts
/**
 * Every date boundary in the app, in one place.
 *
 * Two screens filter by date, and if they disagreed about where a week starts the same
 * question would get two answers depending on which screen you asked. So the boundaries
 * live here and the screens hold only a Range.
 *
 * Dates are plain YYYY-MM-DD strings, interpreted in the DEVICE's timezone. That is the
 * shop's timezone in practice, and it is the only one the person reading the screen
 * thinks in. toBounds() converts to instants for the query, so the comparison the
 * database performs is on the instant and is correct regardless of the server's zone --
 * which matters, because Supabase runs in UTC and the shops are at UTC+5:30.
 */

export type Preset = "today" | "week" | "month";

/** Inclusive at both ends, at day granularity. */
export type Range = { from: string; to: string };

export const PRESETS: readonly Preset[] = ["today", "week", "month"];

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

function ymd(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Monday of the week containing d. Postgres's date_trunc('week') is Monday-based
 *  (0004_views.sql), and a UI that started weeks on Sunday would disagree with the very
 *  numbers it filters. getDay() is 0 for Sunday, so Sunday maps back six days. */
function mondayOf(d: Date): Date {
  const day = d.getDay();
  const back = day === 0 ? 6 : day - 1;
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() - back);
}

export function presetRange(preset: Preset, now: Date): Range {
  const today = ymd(now);
  if (preset === "today") return { from: today, to: today };
  if (preset === "week") return { from: ymd(mondayOf(now)), to: today };
  return { from: ymd(new Date(now.getFullYear(), now.getMonth(), 1)), to: today };
}

/** Parses YYYY-MM-DD strictly. new Date("2026-13-01") does not throw in every engine, so
 *  the parts are checked against the date that comes back rather than trusted. */
function parseYmd(s: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s.trim());
  if (!m) return null;
  const [y, mo, da] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const d = new Date(y, mo - 1, da);
  if (d.getFullYear() !== y || d.getMonth() !== mo - 1 || d.getDate() !== da) return null;
  return d;
}

export function validateRange(
  from: string,
  to: string,
): { ok: true; value: Range } | { ok: false; error: string } {
  const f = parseYmd(from);
  const t = parseYmd(to);
  if (!f || !t) return { ok: false, error: "range.badDate" };
  // Rejected rather than sent: the query would succeed and return nothing, which reads
  // as "no sales" rather than "bad input".
  if (f.getTime() > t.getTime()) return { ok: false, error: "range.backwards" };
  return { ok: true, value: { from: ymd(f), to: ymd(t) } };
}

/** fromTs inclusive, toTs EXCLUSIVE -- the instant midnight begins the day after `to`.
 *  An inclusive end at day granularity would drop every bill completed after midnight on
 *  the final day, which is all of them. */
export function toBounds(r: Range): { fromTs: string; toTs: string } {
  const f = parseYmd(r.from);
  const t = parseYmd(r.to);
  if (!f || !t) throw new Error(`toBounds called with an invalid range: ${r.from}..${r.to}`);
  const end = new Date(t.getFullYear(), t.getMonth(), t.getDate() + 1);
  return { fromTs: f.toISOString(), toTs: end.toISOString() };
}
```

Note the test for a blank date expects `range.badDate`; add that key to all three locale
files in this task (English: "Enter a valid date."; Hindi: "सही तारीख लिखें।"; Marathi:
"योग्य तारीख लिहा.").

- [ ] **Step 4: Run test to verify it passes**

Run: `cd web && npx vitest run src/__tests__/dateRange.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add web/src/dateRange.ts web/src/__tests__/dateRange.test.ts web/src/i18n
git commit -m "feat: add the shared date range module"
```

---

### Task 4: Migration 0007 — analytics that can answer a date range

**Files:**
- Create: `supabase/migrations/0007_analytics_by_date.sql`
- Test: `tests/analytics.test.mjs`

**Interfaces:**
- Consumes: `bills`, `bill_items`, `items` from `0001`; the policies from `0002`.
- Produces: `top_items_between(p_from timestamptz, p_to timestamptz)` returning `(item_id uuid, name_en text, name_hi text, name_mr text, total_qty_kg numeric, total_revenue numeric)`; `bought_together_between(p_from timestamptz, p_to timestamptz)` returning `(item_a uuid, item_b uuid, name_a text, name_b text, bill_count bigint)`.

- [ ] **Step 1: Write the failing test**

Create `tests/analytics.test.mjs`:

```js
import { test, assert, assertEqual, once } from "./framework.mjs";
import { sql } from "./fixtures.mjs";
import { seedTwoVendors } from "./seed.mjs";

// A vendor whose bills sit on known days, so a date window can include some and exclude
// others. Times are explicit rather than now()-relative: a test that drifts with the
// clock fails at midnight and nowhere else.
async function windowedVendor() {
  const { rows: [v] } = await sql(`insert into vendors (name) values ('Window Co') returning id`);
  const { rows: [c] } = await sql(
    `insert into customers (vendor_id, name, flat_no, mobile)
     values ($1,'Win','W-1','+91955550' || floor(random()*10000)::text) returning id`, [v.id]);
  const item = async (n) => {
    const { rows: [i] } = await sql(
      `insert into items (vendor_id, name_en, name_hi, name_mr, price, stock_kg)
       values ($1,$2,$3,$4,50,100) returning id`, [v.id, n, `${n}-hi`, `${n}-mr`]);
    return i.id;
  };
  const onion = await item("Onion");
  const tomato = await item("Tomato");
  const bill = async (itemIds, when, qty) => {
    const { rows: [b] } = await sql(
      `insert into bills (vendor_id, customer_id, total, status, completed_at)
       values ($1,$2,100,'done',$3::timestamptz) returning id`, [v.id, c.id, when]);
    for (const id of itemIds) {
      await sql(`insert into bill_items (bill_id, vendor_id, item_id, qty_kg, unit_price, line_total)
                 values ($1,$2,$3,$4,50,100)`, [b.id, v.id, id, qty]);
    }
    return b.id;
  };
  // Inside the window: three onion+tomato bills on the 9th.
  await bill([onion, tomato], "2026-09-09T04:00:00Z", 2);
  await bill([onion, tomato], "2026-09-09T05:00:00Z", 2);
  await bill([onion, tomato], "2026-09-09T06:00:00Z", 2);
  // Outside: a big onion bill the month before, which must not leak into the window.
  await bill([onion], "2026-08-09T04:00:00Z", 999);
  // A bill still recording -- never counted, whatever its date.
  const { rows: [open] } = await sql(
    `insert into bills (vendor_id, customer_id, total, status) values ($1,$2,100,'recording') returning id`,
    [v.id, c.id]);
  await sql(`insert into bill_items (bill_id, vendor_id, item_id, qty_kg, unit_price, line_total)
             values ($1,$2,$3,500,50,100)`, [open.id, v.id, onion]);
  return { vendorId: v.id, onion, tomato };
}

const getW = once(windowedVendor);
const SEP = ["2026-09-01T00:00:00Z", "2026-10-01T00:00:00Z"];

test("top_items_between counts only bills completed inside the window", async () => {
  const w = await getW();
  const { rows } = await sql(
    `select * from top_items_between($1::timestamptz, $2::timestamptz)
      where item_id = $3`, [...SEP, w.onion]);
  assertEqual(rows.length, 1, "expected the onion row");
  // 3 bills x 2 kg. The 999 kg August bill is outside the window.
  assertEqual(Number(rows[0].total_qty_kg), 6, "August's bill leaked into September");
});

test("top_items_between ignores bills that are not done", async () => {
  const w = await getW();
  const { rows } = await sql(
    `select * from top_items_between('2000-01-01T00:00:00Z'::timestamptz,
                                     '2100-01-01T00:00:00Z'::timestamptz)
      where item_id = $1`, [w.onion]);
  // 6 kg in September + 999 kg in August. The 500 kg still 'recording' must not appear.
  assertEqual(Number(rows[0].total_qty_kg), 1005, "a recording bill was counted");
});

test("top_items_between returns all three names for the language the UI needs", async () => {
  const w = await getW();
  const { rows } = await sql(
    `select * from top_items_between($1::timestamptz, $2::timestamptz) where item_id = $3`,
    [...SEP, w.onion]);
  assertEqual(rows[0].name_hi, "Onion-hi", "name_hi missing");
  assertEqual(rows[0].name_mr, "Onion-mr", "name_mr missing");
});

test("bought_together_between applies the 3-bill threshold inside the window", async () => {
  const w = await getW();
  const { rows } = await sql(
    `select * from bought_together_between($1::timestamptz, $2::timestamptz)`, SEP);
  assertEqual(rows.length, 1, "expected exactly the onion/tomato pair");
  assertEqual(Number(rows[0].bill_count), 3, "expected three co-occurrences");
});

test("bought_together_between drops a pair that only qualifies outside the window", async () => {
  const w = await getW();
  // One day of the three: the pair now co-occurs once, below the threshold of 3.
  const { rows } = await sql(
    `select * from bought_together_between('2026-09-09T03:30:00Z'::timestamptz,
                                           '2026-09-09T04:30:00Z'::timestamptz)`);
  assertEqual(rows.length, 0, "a pair under the threshold was returned");
});

test("neither function is SECURITY DEFINER", async () => {
  // A definer function would bypass RLS and hand every vendor everyone else's numbers.
  const { rows } = await sql(
    `select proname, prosecdef from pg_proc
      where proname in ('top_items_between','bought_together_between')`);
  assertEqual(rows.length, 2, "expected both functions to exist");
  for (const r of rows) assert(r.prosecdef === false, `${r.proname} is SECURITY DEFINER`);
});

test("one vendor's admin cannot see another vendor's top items", async () => {
  const world = await once(seedTwoVendors)();
  const { data, error } = await world.a.clients.admin.rpc("top_items_between", {
    p_from: "2000-01-01T00:00:00Z", p_to: "2100-01-01T00:00:00Z",
  });
  assert(!error, `rpc failed: ${error?.message}`);
  // Vendor B's items must be absent entirely -- invoker rights means RLS filtered them.
  const ids = (data ?? []).map((r) => r.item_id);
  assert(!ids.includes(world.b.itemId), "vendor A saw vendor B's item");
});
```

Register the file with the runner. `tests/run.mjs` imports each suite by name (lines
5-13); add `import "./analytics.test.mjs";` after the `views.test.mjs` line. Without it
the file is never loaded and the suite passes while testing nothing.

- [ ] **Step 2: Run test to verify it fails**

The DB suite does not run locally (no Postgres on the dev machine). Push the branch and
open a PR against `main`; CI's `test` job runs `npm test` against a real Postgres 17.
Expected: FAIL with `function top_items_between(...) does not exist`.

- [ ] **Step 3: Write the migration**

Create `supabase/migrations/0007_analytics_by_date.sql`:

```sql
-- Dashboards that can answer a date range.
--
-- v_top_items and v_bought_together (0004) group over all history and carry no date
-- column at all, so "top items this week" is not a question they can answer. A dashboard
-- built on them would show a date filter that governs the payment figures and is silently
-- ignored by these two -- worse than no filter, because nothing on the screen says which
-- half it reached.
--
-- Functions rather than views, because a view cannot take a parameter. Added ALONGSIDE
-- the originals, which console.html still reads.
--
-- NEITHER IS `security definer`. A plain function runs with the caller's rights and
-- inherits the policies from 0002, which is the same property `security_invoker = true`
-- buys the views. Making either one definer would hand every vendor everyone else's
-- numbers.
--
-- Bounds are [p_from, p_to): half-open, so a caller passing midnight-to-midnight gets
-- whole days without double-counting the instant on the boundary.

create function top_items_between(p_from timestamptz, p_to timestamptz)
  returns table (
    item_id       uuid,
    name_en       text,
    name_hi       text,
    name_mr       text,
    total_qty_kg  numeric,
    total_revenue numeric
  )
  language sql stable as $$
  select bi.item_id, i.name_en, i.name_hi, i.name_mr,
         sum(bi.qty_kg)     as total_qty_kg,
         sum(bi.line_total) as total_revenue
    from bill_items bi
    join bills b on b.id = bi.bill_id
                and b.status = 'done'
                and b.completed_at >= p_from
                and b.completed_at <  p_to
    join items i on i.id = bi.item_id
   group by bi.item_id, i.name_en, i.name_hi, i.name_mr
   order by sum(bi.qty_kg) desc;
$$;

-- The 3-bill threshold is the product spec's (#8) and is applied WITHIN the window: a
-- pair that qualified last year but was bought once this week is not this week's pair.
create function bought_together_between(p_from timestamptz, p_to timestamptz)
  returns table (
    item_a     uuid,
    item_b     uuid,
    name_a     text,
    name_b     text,
    bill_count bigint
  )
  language sql stable as $$
  select a.item_id as item_a, b.item_id as item_b,
         ia.name_en as name_a, ib.name_en as name_b,
         count(distinct a.bill_id) as bill_count
    from bill_items a
    join bill_items b on b.bill_id = a.bill_id and a.item_id < b.item_id
    join bills bl on bl.id = a.bill_id
                 and bl.status = 'done'
                 and bl.completed_at >= p_from
                 and bl.completed_at <  p_to
    join items ia on ia.id = a.item_id
    join items ib on ib.id = b.item_id
   group by a.item_id, b.item_id, ia.name_en, ib.name_en
  having count(distinct a.bill_id) >= 3
   order by count(distinct a.bill_id) desc;
$$;

revoke all on function top_items_between(timestamptz, timestamptz) from public, anon;
revoke all on function bought_together_between(timestamptz, timestamptz) from public, anon;
grant execute on function top_items_between(timestamptz, timestamptz) to authenticated, service_role;
grant execute on function bought_together_between(timestamptz, timestamptz) to authenticated, service_role;
```

- [ ] **Step 4: Run test to verify it passes**

Push; CI's `test` job must go green with the new cases included. Do not proceed on a red
or pending gate.

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/0007_analytics_by_date.sql tests/analytics.test.mjs
git commit -m "feat: add date-windowed analytics functions"
```

---

### Task 5: The history and dashboard data layer

**Files:**
- Create: `web/src/history.ts`
- Test: `web/src/__tests__/history.test.ts`

**Interfaces:**
- Consumes: `supabase` from `./supabase`; `Range`/`toBounds` from `./dateRange`.
- Produces:
  - `type CompletedBill = { id: string; token_no: number; total: number; completed_at: string; customers: { name: string; flat_no: string } | null }`
  - `type BillLine = { id: string; qty_kg: number; unit_price: number; line_total: number; items: { name_en: string; name_hi: string; name_mr: string } | null }`
  - `type TopItem = { item_id: string; name_en: string; name_hi: string; name_mr: string; total_qty_kg: number; total_revenue: number }`
  - `type Pair = { item_a: string; item_b: string; name_a: string; name_b: string; bill_count: number }`
  - `type Cursor = { completedAt: string; id: string }`
  - `PAGE_SIZE: number`
  - `listCompleted(range: Range, after: Cursor | null)`
  - `billLines(billId: string)`
  - `collectedBetween(range: Range)`
  - `topItemsBetween(range: Range)`
  - `pairsBetween(range: Range)`

- [ ] **Step 1: Write the failing test**

Create `web/src/__tests__/history.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";

const chain: Record<string, ReturnType<typeof vi.fn>> = {};
const make = () => {
  const o: Record<string, unknown> = {};
  for (const k of ["select", "eq", "gte", "lt", "order", "limit", "or"]) {
    chain[k] = chain[k] ?? vi.fn();
    o[k] = (...a: unknown[]) => { chain[k](...a); return o; };
  }
  (o as { then: unknown }).then = (res: (v: unknown) => unknown) =>
    Promise.resolve({ data: [], error: null }).then(res);
  return o;
};
const from = vi.fn((..._a: unknown[]) => make());
const rpc = vi.fn(async (..._a: unknown[]) => ({ data: [], error: null }));

vi.mock("../supabase", () => ({
  supabase: { from: (...a: unknown[]) => from(...a), rpc: (...a: unknown[]) => rpc(...a) },
}));

const { listCompleted, billLines, collectedBetween, topItemsBetween, pairsBetween, PAGE_SIZE } =
  await import("../history");

const RANGE = { from: "2026-09-09", to: "2026-09-09" };

beforeEach(() => { vi.clearAllMocks(); });

describe("listCompleted", () => {
  it("reads bills, filtered to done and to the window", async () => {
    await listCompleted(RANGE, null);
    expect(from).toHaveBeenCalledWith("bills");
    expect(chain.eq).toHaveBeenCalledWith("status", "done");
    // Half-open: gte the start instant, lt the instant the day after `to` begins.
    expect(chain.gte).toHaveBeenCalledWith("completed_at", expect.any(String));
    expect(chain.lt).toHaveBeenCalledWith("completed_at", expect.any(String));
  });

  it("asks for one more row than the page size", async () => {
    // The extra row is how the screen learns there IS a next page without a count query.
    await listCompleted(RANGE, null);
    expect(chain.limit).toHaveBeenCalledWith(PAGE_SIZE + 1);
  });

  it("orders by completed_at and id, both descending", async () => {
    // id breaks ties: completed_at is not unique, and an unstable order would drop or
    // repeat a row at the page boundary.
    await listCompleted(RANGE, null);
    expect(chain.order).toHaveBeenCalledWith("completed_at", { ascending: false });
    expect(chain.order).toHaveBeenCalledWith("id", { ascending: false });
  });

  it("pages with a keyset, not an offset", async () => {
    await listCompleted(RANGE, { completedAt: "2026-09-09T10:00:00.000Z", id: "b9" });
    const clause = chain.or.mock.calls[0]?.[0] as string;
    expect(clause).toContain("completed_at.lt.2026-09-09T10:00:00.000Z");
    expect(clause).toContain("id.lt.b9");
  });
});

describe("billLines", () => {
  it("reads the lines of one bill with their item names", async () => {
    await billLines("b1");
    expect(from).toHaveBeenCalledWith("bill_items");
    expect(chain.eq).toHaveBeenCalledWith("bill_id", "b1");
  });
});

describe("collectedBetween", () => {
  it("aggregates bills directly rather than through the daily view", async () => {
    // v_payments_daily buckets with date_trunc in the SERVER's timezone (UTC on
    // Supabase). The shops are at UTC+5:30, so a UTC day boundary would attribute the
    // first 5.5 hours of every Indian day to the day before. Comparing instants is
    // correct in any zone.
    await collectedBetween(RANGE);
    expect(from).toHaveBeenCalledWith("bills");
    expect(from).not.toHaveBeenCalledWith("v_payments_daily");
    expect(chain.eq).toHaveBeenCalledWith("status", "done");
  });
});

describe("the analytics RPCs", () => {
  it("calls top_items_between with the parameter names the migration declares", async () => {
    await topItemsBetween(RANGE);
    expect(rpc).toHaveBeenCalledWith("top_items_between", {
      p_from: expect.any(String), p_to: expect.any(String),
    });
  });

  it("calls bought_together_between with the parameter names the migration declares", async () => {
    await pairsBetween(RANGE);
    expect(rpc).toHaveBeenCalledWith("bought_together_between", {
      p_from: expect.any(String), p_to: expect.any(String),
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd web && npx vitest run src/__tests__/history.test.ts`
Expected: FAIL — cannot resolve `../history`.

- [ ] **Step 3: Write the implementation**

Create `web/src/history.ts`:

```ts
import { supabase } from "./supabase";
import { toBounds, type Range } from "./dateRange";

/**
 * The reads behind the history and dashboard screens.
 *
 * A third sibling to data.ts (billing) and admin.ts (admin), for the same reason both of
 * those exist: a small surface the screens stub in tests, kept small enough to hold in
 * one head.
 *
 * As in both siblings, nothing here filters by vendor. RLS scopes every query to the
 * caller's tenant, and a client-side filter would be a weaker second copy of the policy.
 */

export type CompletedBill = {
  id: string;
  token_no: number;
  total: number;
  completed_at: string;
  customers: { name: string; flat_no: string } | null;
};

export type BillLine = {
  id: string;
  qty_kg: number;
  unit_price: number;
  line_total: number;
  items: { name_en: string; name_hi: string; name_mr: string } | null;
};

export type TopItem = {
  item_id: string;
  name_en: string;
  name_hi: string;
  name_mr: string;
  total_qty_kg: number;
  total_revenue: number;
};

export type Pair = {
  item_a: string;
  item_b: string;
  name_a: string;
  name_b: string;
  bill_count: number;
};

/** The keyset a "load more" resumes from. completed_at alone is not unique. */
export type Cursor = { completedAt: string; id: string };

/** Roughly a busy shop's day, so the first page usually answers "what happened today"
 *  without a second request. */
export const PAGE_SIZE = 50;

const BILL_COLS = "id, token_no, total, completed_at, customers(name, flat_no)";

/**
 * One page of completed bills, newest first.
 *
 * Keyset, not offset. completed_at is not unique -- two bills finished in the same clock
 * tick are ordinary in a queue -- and an offset over a non-unique sort key silently drops
 * or repeats a row at the page boundary. The tuple (completed_at, id) is unique, so
 * resuming strictly after it is exact.
 *
 * Asks for PAGE_SIZE + 1 rows: if the extra one comes back there is another page, which
 * the caller learns without paying for a count query.
 */
export async function listCompleted(range: Range, after: Cursor | null) {
  const { fromTs, toTs } = toBounds(range);
  let q = supabase
    .from("bills")
    .select(BILL_COLS)
    .eq("status", "done")
    .gte("completed_at", fromTs)
    .lt("completed_at", toTs);

  if (after) {
    // Lexicographic on (completed_at, id): strictly earlier, or the same instant with a
    // smaller id.
    q = q.or(
      `completed_at.lt.${after.completedAt},` +
        `and(completed_at.eq.${after.completedAt},id.lt.${after.id})`,
    );
  }

  return q
    .order("completed_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(PAGE_SIZE + 1);
}

export async function billLines(billId: string) {
  return supabase
    .from("bill_items")
    .select("id, qty_kg, unit_price, line_total, items(name_en, name_hi, name_mr)")
    .eq("bill_id", billId);
}

/**
 * Money collected and bill count for the window.
 *
 * Deliberately NOT v_payments_daily. That view buckets with date_trunc('day',
 * completed_at), which resolves in the database server's timezone -- UTC on Supabase --
 * while the shops are at UTC+5:30. A sale at 02:00 IST is 20:30 the previous day in UTC,
 * so UTC buckets would attribute the first five and a half hours of every Indian day to
 * yesterday, and nobody would notice until the dashboard disagreed with the cash drawer.
 * Comparing instants is correct in any timezone.
 */
export async function collectedBetween(range: Range) {
  const { fromTs, toTs } = toBounds(range);
  return supabase
    .from("bills")
    .select("total")
    .eq("status", "done")
    .gte("completed_at", fromTs)
    .lt("completed_at", toTs);
}

/** Parameter names must match 0007_analytics_by_date.sql exactly; PostgREST resolves the
 *  overload by argument name, and a mismatch reads as "function not found". */
export async function topItemsBetween(range: Range) {
  const { fromTs, toTs } = toBounds(range);
  return supabase.rpc("top_items_between", { p_from: fromTs, p_to: toTs });
}

export async function pairsBetween(range: Range) {
  const { fromTs, toTs } = toBounds(range);
  return supabase.rpc("bought_together_between", { p_from: fromTs, p_to: toTs });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd web && npx vitest run src/__tests__/history.test.ts`
Expected: PASS. If the chainable-stub shape needs adjusting for supabase-js's builder,
adjust the STUB, never the query.

- [ ] **Step 5: Commit**

```bash
git add web/src/history.ts web/src/__tests__/history.test.ts
git commit -m "feat: add the history and dashboard data layer"
```

---

### Task 6: The date filter control

**Files:**
- Create: `web/src/components/DateFilter.tsx`
- Test: `web/src/__tests__/DateFilter.test.tsx`

**Interfaces:**
- Consumes: `PRESETS`, `presetRange`, `validateRange`, `Range`, `Preset` from `../dateRange`.
- Produces: `DateFilter({ value, onChange }: { value: Range; onChange: (r: Range) => void })`.

- [ ] **Step 1: Write the failing test**

Create `web/src/__tests__/DateFilter.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { DateFilter } from "../components/DateFilter";
import { presetRange } from "../dateRange";

const onChange = vi.fn();
const initial = { from: "2026-09-01", to: "2026-09-09" };

beforeEach(() => vi.clearAllMocks());

describe("the date filter", () => {
  it("offers the three presets", () => {
    render(<DateFilter value={initial} onChange={onChange} />);
    expect(screen.getByTestId("range-today")).toBeTruthy();
    expect(screen.getByTestId("range-week")).toBeTruthy();
    expect(screen.getByTestId("range-month")).toBeTruthy();
  });

  it("emits the range for a tapped preset", () => {
    render(<DateFilter value={initial} onChange={onChange} />);
    fireEvent.click(screen.getByTestId("range-today"));
    expect(onChange).toHaveBeenCalledWith(presetRange("today", expect.anything() as never));
  });

  it("emits a valid custom range", () => {
    render(<DateFilter value={initial} onChange={onChange} />);
    fireEvent.click(screen.getByTestId("range-custom"));
    fireEvent.change(screen.getByTestId("range-from"), { target: { value: "2026-08-01" } });
    fireEvent.change(screen.getByTestId("range-to"), { target: { value: "2026-08-31" } });
    fireEvent.click(screen.getByTestId("range-apply"));
    expect(onChange).toHaveBeenCalledWith({ from: "2026-08-01", to: "2026-08-31" });
  });

  it("refuses a backwards range instead of emitting it", () => {
    // Sending it would return zero rows, which reads as "no sales" rather than "bad
    // input" -- a false answer rather than an error.
    render(<DateFilter value={initial} onChange={onChange} />);
    fireEvent.click(screen.getByTestId("range-custom"));
    fireEvent.change(screen.getByTestId("range-from"), { target: { value: "2026-09-10" } });
    fireEvent.change(screen.getByTestId("range-to"), { target: { value: "2026-09-09" } });
    fireEvent.click(screen.getByTestId("range-apply"));
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByTestId("range-error")).toBeTruthy();
  });

  it("clears the error once a valid range is applied", () => {
    render(<DateFilter value={initial} onChange={onChange} />);
    fireEvent.click(screen.getByTestId("range-custom"));
    fireEvent.change(screen.getByTestId("range-from"), { target: { value: "2026-09-10" } });
    fireEvent.change(screen.getByTestId("range-to"), { target: { value: "2026-09-09" } });
    fireEvent.click(screen.getByTestId("range-apply"));
    fireEvent.change(screen.getByTestId("range-from"), { target: { value: "2026-09-01" } });
    fireEvent.click(screen.getByTestId("range-apply"));
    expect(screen.queryByTestId("range-error")).toBeNull();
    expect(onChange).toHaveBeenCalledWith({ from: "2026-09-01", to: "2026-09-09" });
  });
});
```

The first test's `expect.anything()` cast is awkward because `presetRange` needs a Date;
if it fights the types, compute the expected value inline instead:
`expect(onChange).toHaveBeenCalledWith(presetRange("today", new Date()))` — the range is a
date string, so it is stable within a test run unless the run straddles midnight.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd web && npx vitest run src/__tests__/DateFilter.test.tsx`
Expected: FAIL — cannot resolve `../components/DateFilter`.

- [ ] **Step 3: Write the component**

Create `web/src/components/DateFilter.tsx`:

```tsx
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { PRESETS, presetRange, validateRange, type Preset, type Range } from "../dateRange";
import "../i18n";

/** Presets plus a custom range, shared by /completed and /dashboards so the two screens
 *  cannot disagree about what "this week" means. */
export function DateFilter({
  value,
  onChange,
}: {
  value: Range;
  onChange: (r: Range) => void;
}) {
  const { t } = useTranslation();
  const [custom, setCustom] = useState(false);
  const [from, setFrom] = useState(value.from);
  const [to, setTo] = useState(value.to);
  const [error, setError] = useState<string | null>(null);

  function pick(p: Preset) {
    setCustom(false);
    setError(null);
    onChange(presetRange(p, new Date()));
  }

  function apply() {
    const checked = validateRange(from, to);
    if (!checked.ok) {
      setError(checked.error);
      return;
    }
    setError(null);
    onChange(checked.value);
  }

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-2">
        {PRESETS.map((p) => (
          <button
            key={p}
            data-testid={`range-${p}`}
            onClick={() => pick(p)}
            className="border border-slate-300 rounded-lg px-3 py-2 text-sm bg-white min-h-[44px]"
          >
            {t(`range.${p}`)}
          </button>
        ))}
        <button
          data-testid="range-custom"
          onClick={() => setCustom((c) => !c)}
          className="border border-slate-300 rounded-lg px-3 py-2 text-sm bg-white min-h-[44px]"
        >
          {t("range.custom")}
        </button>
      </div>

      {custom && (
        <div className="flex flex-wrap items-end gap-2 bg-white border border-slate-200 rounded-xl p-3">
          <label className="text-sm text-slate-600">
            {t("range.from")}
            <input
              type="date"
              data-testid="range-from"
              value={from}
              onChange={(e) => setFrom(e.target.value)}
              className="mt-1 block border border-slate-300 rounded-lg px-3 py-2 min-h-[44px]"
            />
          </label>
          <label className="text-sm text-slate-600">
            {t("range.to")}
            <input
              type="date"
              data-testid="range-to"
              value={to}
              onChange={(e) => setTo(e.target.value)}
              className="mt-1 block border border-slate-300 rounded-lg px-3 py-2 min-h-[44px]"
            />
          </label>
          <button
            data-testid="range-apply"
            onClick={apply}
            className="rounded-lg px-4 py-2 text-sm bg-slate-800 text-white min-h-[44px]"
          >
            {t("range.apply")}
          </button>
        </div>
      )}

      {error && (
        <p data-testid="range-error" className="text-sm text-red-700">
          {t(error)}
        </p>
      )}
    </div>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd web && npx vitest run src/__tests__/DateFilter.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add web/src/components/DateFilter.tsx web/src/__tests__/DateFilter.test.tsx
git commit -m "feat: add the shared date filter control"
```

---

### Task 7: The completed-bills screen

**Files:**
- Create: `web/src/screens/Completed.tsx`
- Test: `web/src/__tests__/Completed.test.tsx`

**Interfaces:**
- Consumes: `listCompleted`, `billLines`, `PAGE_SIZE`, `CompletedBill`, `BillLine`, `Cursor` from `../history`; `presetRange`, `Range` from `../dateRange`; `DateFilter`; `rupees`; `itemName`; `describeError`.
- Produces: `export default function Completed()`.

- [ ] **Step 1: Write the failing test**

Create `web/src/__tests__/Completed.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import type { CompletedBill, BillLine } from "../history";

const PAGE_SIZE = 50;

function bill(n: number): CompletedBill {
  return {
    id: `b${n}`,
    token_no: n,
    total: 100 + n,
    completed_at: `2026-09-09T10:00:${String(n % 60).padStart(2, "0")}.000Z`,
    customers: { name: `Cust ${n}`, flat_no: `A-${n}` },
  };
}

const listCompleted = vi.fn(async (..._a: unknown[]): Promise<{
  data: CompletedBill[] | null; error: { code?: string; message?: string } | null;
}> => ({ data: [bill(1), bill(2)], error: null }));
const billLines = vi.fn(async (..._a: unknown[]): Promise<{
  data: BillLine[] | null; error: null;
}> => ({
  data: [{
    id: "l1", qty_kg: 2, unit_price: 40, line_total: 80,
    items: { name_en: "Onion", name_hi: "प्याज", name_mr: "कांदा" },
  }],
  error: null,
}));

vi.mock("../history", async () => {
  const actual = await vi.importActual<typeof import("../history")>("../history");
  return {
    ...actual,
    PAGE_SIZE,
    listCompleted: (...a: unknown[]) => listCompleted(...a),
    billLines: (...a: unknown[]) => billLines(...a),
  };
});

const { default: Completed } = await import("../screens/Completed");

beforeEach(() => vi.clearAllMocks());

describe("the completed bills screen", () => {
  it("lists completed bills with token, customer and total", async () => {
    render(<Completed />);
    expect(await screen.findByText(/Cust 1/)).toBeTruthy();
    expect(screen.getByText(/₹101\.00/)).toBeTruthy();
  });

  it("says nothing yet, not not allowed, on an empty period", async () => {
    // A policy-filtered read is zero rows, not an error. See errors.ts.
    listCompleted.mockResolvedValueOnce({ data: [], error: null });
    render(<Completed />);
    expect(await screen.findByTestId("completed-empty")).toBeTruthy();
  });

  it("shows a bill's items when a row is opened", async () => {
    render(<Completed />);
    fireEvent.click(await screen.findByTestId("completed-row-b1"));
    await waitFor(() => expect(billLines).toHaveBeenCalledWith("b1"));
    expect(await screen.findByText(/Onion|कांदा|प्याज/)).toBeTruthy();
  });

  it("hides load-more when the server returned no extra row", async () => {
    // Fewer than PAGE_SIZE + 1 rows means this was the last page.
    render(<Completed />);
    await screen.findByTestId("completed-row-b1");
    expect(screen.queryByTestId("completed-more")).toBeNull();
  });

  it("offers load-more when the server returned the extra row", async () => {
    const full = Array.from({ length: PAGE_SIZE + 1 }, (_, i) => bill(i + 1));
    listCompleted.mockResolvedValueOnce({ data: full, error: null });
    render(<Completed />);
    expect(await screen.findByTestId("completed-more")).toBeTruthy();
  });

  it("does not render the extra probe row", async () => {
    // The PAGE_SIZE + 1st row exists only to prove another page exists. Rendering it
    // would show one bill twice once load-more ran.
    const full = Array.from({ length: PAGE_SIZE + 1 }, (_, i) => bill(i + 1));
    listCompleted.mockResolvedValueOnce({ data: full, error: null });
    render(<Completed />);
    await screen.findByTestId("completed-more");
    expect(screen.queryByTestId(`completed-row-b${PAGE_SIZE + 1}`)).toBeNull();
  });

  it("resumes from the last rendered row, not the probe row", async () => {
    const full = Array.from({ length: PAGE_SIZE + 1 }, (_, i) => bill(i + 1));
    listCompleted.mockResolvedValueOnce({ data: full, error: null });
    render(<Completed />);
    fireEvent.click(await screen.findByTestId("completed-more"));
    await waitFor(() => expect(listCompleted).toHaveBeenCalledTimes(2));
    const cursor = listCompleted.mock.calls[1]?.[1] as { id: string };
    expect(cursor.id).toBe(`b${PAGE_SIZE}`);
  });

  it("refetches from the first page when the date range changes", async () => {
    // A new period must not resume from the old period's cursor.
    render(<Completed />);
    await screen.findByTestId("completed-row-b1");
    fireEvent.click(screen.getByTestId("range-today"));
    await waitFor(() => expect(listCompleted).toHaveBeenCalledTimes(2));
    expect(listCompleted.mock.calls[1]?.[1]).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd web && npx vitest run src/__tests__/Completed.test.tsx`
Expected: FAIL — cannot resolve `../screens/Completed`.

- [ ] **Step 3: Write the screen**

Create `web/src/screens/Completed.tsx`:

```tsx
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  listCompleted, billLines, PAGE_SIZE,
  type CompletedBill, type BillLine, type Cursor,
} from "../history";
import { presetRange, type Range } from "../dateRange";
import { DateFilter } from "../components/DateFilter";
import { itemName, type Lang } from "../i18n/locales";
import { rupees } from "../money";
import { describeError } from "../errors";
import "../i18n";

export default function Completed() {
  const { t, i18n } = useTranslation();
  const [range, setRange] = useState<Range>(() => presetRange("today", new Date()));
  const [rows, setRows] = useState<CompletedBill[]>([]);
  const [more, setMore] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const [lines, setLines] = useState<BillLine[]>([]);
  const [problem, setProblem] = useState<{ key: string; detail: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const lang = i18n.language as Lang;

  /** after=null starts a fresh period; a cursor appends the next page. */
  const load = useCallback(async (r: Range, after: Cursor | null) => {
    setBusy(true);
    const { data, error } = await listCompleted(r, after);
    setBusy(false);
    const described = describeError(error);
    setProblem(described);
    const page = data ?? [];
    // The PAGE_SIZE + 1st row is a probe: its presence proves another page exists. It is
    // never rendered, or the same bill would appear twice once load-more ran.
    const hasMore = page.length > PAGE_SIZE;
    const visible = hasMore ? page.slice(0, PAGE_SIZE) : page;
    setMore(hasMore);
    setRows((prev) => (after ? [...prev, ...visible] : visible));
  }, []);

  useEffect(() => {
    setOpen(null);
    void load(range, null);
  }, [range, load]);

  async function openBill(id: string) {
    if (open === id) { setOpen(null); return; }
    setOpen(id);
    setLines([]);
    const { data, error } = await billLines(id);
    setProblem(describeError(error));
    setLines(data ?? []);
  }

  function loadMore() {
    const last = rows[rows.length - 1];
    if (!last) return;
    void load(range, { completedAt: last.completed_at, id: last.id });
  }

  return (
    <div className="space-y-4">
      <h2 className="font-semibold text-slate-800">{t("completed.title")}</h2>

      <DateFilter value={range} onChange={setRange} />

      {problem && (
        <p className="text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg p-3">
          {t(problem.key)}
        </p>
      )}

      {rows.length === 0 && !busy ? (
        <p data-testid="completed-empty" className="text-sm text-slate-500">
          {t("completed.empty")}
        </p>
      ) : (
        <ul className="space-y-2">
          {rows.map((b) => (
            <li key={b.id} className="bg-white border border-slate-200 rounded-xl">
              <button
                data-testid={`completed-row-${b.id}`}
                onClick={() => void openBill(b.id)}
                className="w-full text-left p-3 min-h-[44px] flex items-center gap-3"
              >
                <span className="flex-1 min-w-0">
                  <span className="block font-medium text-slate-800 truncate">
                    {b.customers?.name ?? t("completed.noCustomer")}
                  </span>
                  <span className="block text-xs text-slate-500">
                    {t("completed.token", { n: b.token_no })}
                    {" · "}
                    {new Date(b.completed_at).toLocaleString()}
                  </span>
                </span>
                <span className="font-medium text-slate-800 whitespace-nowrap">
                  {rupees(b.total)}
                </span>
              </button>

              {open === b.id && (
                <div className="border-t border-slate-100 p-3">
                  <p className="text-xs text-slate-500 mb-1">{t("completed.lines")}</p>
                  <ul className="space-y-1">
                    {lines.map((l) => (
                      <li key={l.id} className="flex justify-between text-sm">
                        <span className="text-slate-700">
                          {l.items ? itemName(l.items, lang) : "—"}
                          {" · "}
                          {t("completed.qtyLine", { qty: l.qty_kg })}
                        </span>
                        <span className="text-slate-600">{rupees(l.line_total)}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}

      {more && (
        <button
          data-testid="completed-more"
          onClick={loadMore}
          disabled={busy}
          className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm bg-white min-h-[44px] disabled:opacity-50"
        >
          {busy ? t("completed.loading") : t("completed.loadMore")}
        </button>
      )}
    </div>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd web && npx vitest run src/__tests__/Completed.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add web/src/screens/Completed.tsx web/src/__tests__/Completed.test.tsx
git commit -m "feat: add the completed bills history screen"
```

---

### Task 8: The dashboard screen, wiring, Settings merge, and the README

**Files:**
- Create: `web/src/screens/Dashboards.tsx`, `web/src/__tests__/Dashboards.test.tsx`
- Modify: `web/src/screens/Settings.tsx`, `web/src/App.tsx`, `web/src/__tests__/App.test.tsx`, `README.md`

**Interfaces:**
- Consumes: `collectedBetween`, `topItemsBetween`, `pairsBetween`, `TopItem`, `Pair` from `../history`; `DateFilter`; `presetRange`; `rupees`; `itemName`; `describeError`; the existing `Staff` default export.
- Produces: `export default function Dashboards()`; `/completed`, `/dashboards` and the `/staff` redirect wired in `App.tsx`.

- [ ] **Step 1: Write the failing tests**

Create `web/src/__tests__/Dashboards.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import type { TopItem, Pair } from "../history";

const collectedBetween = vi.fn(async (..._a: unknown[]): Promise<{
  data: { total: number }[] | null; error: { code?: string; message?: string } | null;
}> => ({ data: [{ total: 100 }, { total: 250.5 }], error: null }));
const topItemsBetween = vi.fn(async (..._a: unknown[]): Promise<{
  data: TopItem[] | null; error: null;
}> => ({
  data: [{
    item_id: "i1", name_en: "Onion", name_hi: "प्याज", name_mr: "कांदा",
    total_qty_kg: 12, total_revenue: 480,
  }],
  error: null,
}));
const pairsBetween = vi.fn(async (..._a: unknown[]): Promise<{ data: Pair[] | null; error: null }> =>
  ({ data: [{ item_a: "i1", item_b: "i2", name_a: "Onion", name_b: "Tomato", bill_count: 4 }], error: null }));

vi.mock("../history", async () => {
  const actual = await vi.importActual<typeof import("../history")>("../history");
  return {
    ...actual,
    collectedBetween: (...a: unknown[]) => collectedBetween(...a),
    topItemsBetween: (...a: unknown[]) => topItemsBetween(...a),
    pairsBetween: (...a: unknown[]) => pairsBetween(...a),
  };
});

const { default: Dashboards } = await import("../screens/Dashboards");

beforeEach(() => vi.clearAllMocks());

describe("the dashboard", () => {
  it("totals the collected money through rupees()", async () => {
    render(<Dashboards />);
    expect(await screen.findByText(/₹350\.50/)).toBeTruthy();
  });

  it("counts the completed bills", async () => {
    render(<Dashboards />);
    expect((await screen.findByTestId("dash-bill-count")).textContent).toContain("2");
  });

  it("lists top items", async () => {
    render(<Dashboards />);
    expect(await screen.findByText(/Onion|कांदा|प्याज/)).toBeTruthy();
  });

  it("lists bought-together pairs", async () => {
    render(<Dashboards />);
    expect(await screen.findByTestId("dash-pair-i1-i2")).toBeTruthy();
  });

  it("refetches every card when the range changes", async () => {
    // The whole point of 0007: the filter must reach the analytics cards too, not just
    // the money. A filter governing half a screen is worse than none.
    render(<Dashboards />);
    await screen.findByTestId("dash-bill-count");
    fireEvent.click(screen.getByTestId("range-month"));
    await waitFor(() => {
      expect(collectedBetween).toHaveBeenCalledTimes(2);
      expect(topItemsBetween).toHaveBeenCalledTimes(2);
      expect(pairsBetween).toHaveBeenCalledTimes(2);
    });
  });

  it("says nothing in this period rather than showing an error", async () => {
    collectedBetween.mockResolvedValueOnce({ data: [], error: null });
    topItemsBetween.mockResolvedValueOnce({ data: [], error: null });
    pairsBetween.mockResolvedValueOnce({ data: [], error: null });
    render(<Dashboards />);
    expect((await screen.findAllByText(/nothing in this period|काहीही नाही|कुछ नहीं/i)).length)
      .toBeGreaterThan(0);
  });
});
```

Add to `web/src/__tests__/App.test.tsx`, keeping its existing mocks and adding
`../screens/Completed` and `../screens/Dashboards` to any screen-stub list:

```tsx
  it("no longer serves a placeholder for dashboards", async () => {
    // /dashboards was the last stub. The README's stage-3 claim that it is the only
    // remaining placeholder stops being true in this slice.
    render(<App />);
    expect(screen.queryByText(/coming soon|लवकरच|जल्द/i)).toBeNull();
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd web && npx vitest run src/__tests__/Dashboards.test.tsx src/__tests__/App.test.tsx`
Expected: FAIL — cannot resolve `../screens/Dashboards`.

- [ ] **Step 3: Write the dashboard**

Create `web/src/screens/Dashboards.tsx`:

```tsx
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  collectedBetween, topItemsBetween, pairsBetween, type TopItem, type Pair,
} from "../history";
import { presetRange, type Range } from "../dateRange";
import { DateFilter } from "../components/DateFilter";
import { itemName, type Lang } from "../i18n/locales";
import { rupees } from "../money";
import { describeError } from "../errors";
import "../i18n";

function Card({ title, subtitle, children }: {
  title: string; subtitle?: string; children: React.ReactNode;
}) {
  return (
    <section className="bg-white border border-slate-200 rounded-xl p-4">
      <h3 className="font-semibold text-slate-800">{title}</h3>
      {subtitle && <p className="text-xs text-slate-500 mb-2">{subtitle}</p>}
      {children}
    </section>
  );
}

export default function Dashboards() {
  const { t, i18n } = useTranslation();
  const [range, setRange] = useState<Range>(() => presetRange("month", new Date()));
  const [collected, setCollected] = useState(0);
  const [billCount, setBillCount] = useState(0);
  const [top, setTop] = useState<TopItem[]>([]);
  const [pairs, setPairs] = useState<Pair[]>([]);
  const [problem, setProblem] = useState<{ key: string; detail: string } | null>(null);

  const lang = i18n.language as Lang;

  const load = useCallback(async (r: Range) => {
    const [money, items, together] = await Promise.all([
      collectedBetween(r), topItemsBetween(r), pairsBetween(r),
    ]);
    // First error wins: three cards failing for one reason should say it once.
    setProblem(
      describeError(money.error) ?? describeError(items.error) ?? describeError(together.error),
    );
    const bills = money.data ?? [];
    setCollected(bills.reduce((sum, b) => sum + Number(b.total), 0));
    setBillCount(bills.length);
    setTop(items.data ?? []);
    setPairs(together.data ?? []);
  }, []);

  useEffect(() => { void load(range); }, [range, load]);

  return (
    <div className="space-y-4">
      <h2 className="font-semibold text-slate-800">{t("dash.title")}</h2>

      <DateFilter value={range} onChange={setRange} />

      {problem && (
        <p className="text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg p-3">
          {t(problem.key)}
        </p>
      )}

      <div className="grid gap-3 sm:grid-cols-2">
        <Card title={t("dash.collected")}>
          <p className="text-2xl font-semibold text-slate-800">{rupees(collected)}</p>
        </Card>
        <Card title={t("dash.billCount")}>
          <p data-testid="dash-bill-count" className="text-2xl font-semibold text-slate-800">
            {billCount}
          </p>
        </Card>
      </div>

      <Card title={t("dash.topItems")} subtitle={t("dash.topItemsSub")}>
        {top.length === 0 ? (
          <p className="text-sm text-slate-500">{t("dash.empty")}</p>
        ) : (
          <ul className="space-y-1">
            {top.map((i) => (
              <li key={i.item_id} data-testid={`dash-top-${i.item_id}`} className="flex justify-between text-sm">
                <span className="text-slate-700">{itemName(i, lang)}</span>
                <span className="text-slate-600">
                  {t("dash.kg", { kg: i.total_qty_kg })} · {rupees(Number(i.total_revenue))}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card title={t("dash.together")} subtitle={t("dash.togetherSub")}>
        {pairs.length === 0 ? (
          <p className="text-sm text-slate-500">{t("dash.empty")}</p>
        ) : (
          <ul className="space-y-1">
            {pairs.map((p) => (
              <li
                key={`${p.item_a}-${p.item_b}`}
                data-testid={`dash-pair-${p.item_a}-${p.item_b}`}
                className="flex justify-between text-sm"
              >
                <span className="text-slate-700">{p.name_a} + {p.name_b}</span>
                <span className="text-slate-600">{t("dash.pairCount", { n: p.bill_count })}</span>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
```

- [ ] **Step 4: Fold Staff into Settings**

In `web/src/screens/Settings.tsx`, keep the existing loyalty form exactly as it is and
wrap the screen so it renders two labelled sections. Import the existing screen
unchanged: `import Staff from "./Staff";`. Put the loyalty form under a heading using
`t("settings.loyaltySection")` and render `<Staff />` beneath a heading using
`t("settings.staffSection")`.

Do not modify `Staff.tsx`. Its self-edit lock, its "cannot invite" note and its confirm
dialog's `aria-label` all stay exactly as they are.

- [ ] **Step 5: Wire the routes**

In `web/src/App.tsx`, add the imports:

```tsx
import Completed from "./screens/Completed";
import Dashboards from "./screens/Dashboards";
```

Replace the `/dashboards` placeholder route, add `/completed`, and turn `/staff` into a
redirect:

```tsx
          <Route path="/completed" element={<Completed />} />
          <Route path="/dashboards" element={<Dashboards />} />
          <Route path="/staff" element={<Navigate to="/settings" replace />} />
```

`Navigate` is already imported. **Remove the now-unused `Placeholder` import.** `/dashboards`
was its only remaining consumer (App.tsx:7 and :64 are the sole references outside the
file itself), so also delete `web/src/screens/Placeholder.tsx`. A stub screen kept after
the last stub route is gone is exactly the dead code that misleads the next reader into
thinking something is still unbuilt.

- [ ] **Step 6: Run the whole suite and the build**

Run: `cd web && npm test` — expected PASS, count above 165.
Run: `cd web && npm run build` — expected clean.

- [ ] **Step 7: Update the README**

Extend the existing sections rather than starting parallel ones:

- Slice 4 ships the completed-bill history, dashboards, the item list, and Staff folded
  into Settings. **No screen is a placeholder any more.**
- `console.html` stays published at `/console.html`. It is not retired in this slice; that
  is a judgement to make after the vendor has used both.
- **Migration `0007` must be pushed** with `supabase db push` for the dashboards to work at
  all — the Pages workflow deploys only the SPA. `0006` (the points threshold) may still be
  unpushed too; check before assuming.
- Dashboard money totals are computed by comparing instants, **not** from
  `v_payments_daily`, because that view buckets in the server's timezone (UTC) while the
  shops are at UTC+5:30. The three payment views remain for `console.html`.
- Staff still cannot be invited from the SPA, and item names still require all three
  languages typed by hand. Both wait on the Edge Function slice.
- The new `hi` and `mr` strings are AI-written and unreviewed, like the rest.
- The end-to-end gap is unchanged, and now includes two new RPCs never exercised through
  PostgREST.

- [ ] **Step 8: Commit**

```bash
git add web/src/screens/Dashboards.tsx web/src/__tests__/Dashboards.test.tsx \
        web/src/screens/Settings.tsx web/src/App.tsx web/src/__tests__/App.test.tsx README.md
git commit -m "feat: add dashboards, fold staff into settings, and wire the new routes"
```

---

## Self-Review

**Spec coverage.** §2 item list → Task 2. §3 completed bills incl. paging → Tasks 5 and 7.
§4 dashboards and migration 0007 → Tasks 4 and 8. §5 settings merge and the `/staff`
redirect → Tasks 1 and 8. §6 date filter → Tasks 3 and 6. §7 testing → every task, with
the date maths and the pagination boundary given real cases. §8 unchanged items → the
README step. §9 out-of-scope → no task, correctly.

**Deliberate deviation from the spec**, flagged at the top of this plan and again in
Task 5's code comment: dashboard totals aggregate `bills` over instant bounds rather than
reading `v_payments_daily`, because that view's `date_trunc` resolves in UTC and the shops
are at UTC+5:30. The spec's §4 sentence is superseded on this point.

**Type consistency.** `Range` is produced by `dateRange.ts` (Task 3) and consumed by
`history.ts` (Task 5), `DateFilter` (Task 6) and both screens. `Cursor` is produced by
Task 5 and constructed only in Task 7. `TopItem`/`Pair` field names match `0007`'s
`returns table` columns exactly — `item_id`, `name_en/hi/mr`, `total_qty_kg`,
`total_revenue`; `item_a`, `item_b`, `name_a`, `name_b`, `bill_count`. `TopItem` carries
all three name columns so `itemName()` works on it directly.

**Two things an implementer must not quietly "fix".** The suite runs in Marathi, so
queries go through `data-testid` — do not change the default language. And the DB suite
does not run locally at all; CI is the verifier, and a task whose tests are in `tests/`
is not done until CI is green.
