# Slice 3 Stage 3 — Admin Screens Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the four admin screens — items and stock, customers, staff, and loyalty settings — so an admin can run the shop's configuration without opening the SQL editor.

**Architecture:** A new `web/src/admin.ts` holds every PostgREST call these screens make, mirroring `web/src/data.ts` (which stays the billing flow's file). Pure validation lives in `web/src/adminRules.ts` and is tested with no mocks at all. Each screen is a component under `web/src/screens/` that stubs `admin.ts` in its test, exactly as `Bill.test.tsx` and `Pending.test.tsx` stub `data.ts`.

**Tech Stack:** React 19, TypeScript, react-router-dom 7, react-i18next 17, Tailwind 4, Vitest 5 + @testing-library/react, supabase-js 2.

**Spec:** `docs/superpowers/specs/2026-09-08-slice-3-spa-design.md` — §11b is this stage; §5 settles the data flow; §6 explains why staff invites are absent.

## Global Constraints

- **Never filter by vendor in a client query.** RLS scopes every read; a client-side vendor filter is a weaker second copy of the policy. This rule is stated in `web/src/data.ts`'s header and carries over verbatim.
- **`vendor_id` is NOT NULL with no default** on every child table. Every INSERT must carry it. Omitting it has already shipped as a bug once.
- **RPC parameter names must match `supabase/migrations/0003_functions.sql` exactly.** PostgREST resolves overloads by argument name; a mismatch reads as "function not found".
- **Route guards are UX, not security.** `web/src/routes.ts` says so in a comment. Never move an authorization decision into that file.
- **A blocked write is an error (42501); a filtered read is zero rows.** An empty list renders "nothing yet", never "not allowed". See `web/src/errors.ts`.
- **All money is rendered through `rupees()`** from `web/src/money.ts`. Never interpolate a raw number into currency copy.
- **Every new user-facing string gets a key in all three of** `web/src/i18n/en.json`, `hi.json`, `mr.json`. The `hi` and `mr` values are AI-written and unreviewed — a known, documented debt, not something to hide.
- **Tap targets are `min-h-[44px]`,** matching every existing button.
- **Tests run with** `cd web && npm test`. A single file: `cd web && npx vitest run src/__tests__/<name>`.
- **`npm run build` runs `tsc --noEmit` first.** TypeScript must be clean before any commit.

---

## File Structure

**Create:**
- `web/src/admin.ts` — every PostgREST call for the four admin screens.
- `web/src/adminRules.ts` — pure validation and guards. No supabase import, no React.
- `web/src/screens/Items.tsx` — item list and create/edit form.
- `web/src/screens/Customers.tsx` — customer list, edit, points balance.
- `web/src/screens/Staff.tsx` — roster, rename, role change, remove.
- `web/src/screens/Settings.tsx` — the vendor's loyalty config.
- `web/src/__tests__/adminRules.test.ts`, `admin.test.ts`, `Items.test.tsx`, `Customers.test.tsx`, `Staff.test.tsx`, `Settings.test.tsx`.

**Modify:**
- `web/src/routes.ts` — add `/settings` to the admin nav.
- `web/src/App.tsx` — replace three `Placeholder` routes with real screens, add a fourth.
- `web/src/i18n/{en,hi,mr}.json` — new `items`, `customersScreen`, `staff`, `settings` namespaces.
- `web/src/__tests__/routes.test.ts` — the admin path list changes.
- `README.md` — record what stage 3 ships and what it still cannot do.

---

### Task 1: Route and translations for the whole stage

Everything downstream needs these keys to exist. Doing them once keeps the three locale files in step.

**Files:**
- Modify: `web/src/routes.ts:19-26`
- Modify: `web/src/i18n/en.json`, `web/src/i18n/hi.json`, `web/src/i18n/mr.json`
- Test: `web/src/__tests__/routes.test.ts:13-24`

**Interfaces:**
- Consumes: nothing.
- Produces: the route `/settings` with `labelKey: "nav.settings"`; the i18n namespaces `items.*`, `customersScreen.*`, `staff.*`, `settings.*` used by Tasks 4–7.

- [ ] **Step 1: Write the failing test**

In `web/src/__tests__/routes.test.ts`, replace the "gives admin the full set" expectation and add a guard test below it:

```ts
  it("gives admin the full set, including billing", () => {
    // The policies permit ('admin','recorder') to create bills and issue tokens, so the
    // UI follows the policy rather than narrowing it.
    expect(routesForRole("admin").map((r) => r.path)).toEqual([
      "/bill",
      "/pending",
      "/items",
      "/customers",
      "/staff",
      "/settings",
      "/dashboards",
    ]);
  });

  it("keeps loyalty settings away from recorders and billers", () => {
    // Politeness, not protection: vendors_admin_update is what actually refuses the
    // write. See the header comment in routes.ts.
    expect(canAccess("recorder", "/settings")).toBe(false);
    expect(canAccess("biller", "/settings")).toBe(false);
    expect(canAccess("admin", "/settings")).toBe(true);
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd web && npx vitest run src/__tests__/routes.test.ts`
Expected: FAIL — the admin list does not contain `/settings`.

- [ ] **Step 3: Add the route**

In `web/src/routes.ts`, in the `admin` array, insert between `/staff` and `/dashboards`:

```ts
    { path: "/settings", labelKey: "nav.settings" },
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd web && npx vitest run src/__tests__/routes.test.ts`
Expected: PASS.

- [ ] **Step 5: Add the English strings**

In `web/src/i18n/en.json`, add `"settings": "Settings"` to the existing `nav` object, and add these four top-level namespaces:

```json
  "items": {
    "title": "Items and stock",
    "add": "Add item",
    "edit": "Edit item",
    "nameEn": "Name (English)",
    "nameHi": "Name (Hindi)",
    "nameMr": "Name (Marathi)",
    "price": "Price per kg",
    "stock": "Stock (kg)",
    "save": "Save",
    "cancel": "Cancel",
    "empty": "No items yet. Add the first one.",
    "inStock": "{{kg}} kg",
    "low": "Low stock",
    "out": "Out of stock",
    "inactive": "Hidden",
    "deactivate": "Hide from billing",
    "reactivate": "Put back on sale",
    "stockNote": "Type the stock you counted. This replaces the current figure; completing a bill still subtracts from it.",
    "namesNote": "All three names are required. Customers see the name in their own language.",
    "required": "This field is required.",
    "badPrice": "Enter a price of zero or more.",
    "badStock": "Enter a stock figure of zero or more."
  },
  "customersScreen": {
    "title": "Customers",
    "search": "Search by name, flat or mobile",
    "empty": "No customers yet.",
    "edit": "Edit customer",
    "points": "{{n}} points",
    "pointsUnknown": "Points could not be checked.",
    "save": "Save",
    "cancel": "Cancel",
    "duplicate": "Another customer already uses this mobile number."
  },
  "staff": {
    "title": "Staff",
    "empty": "No staff yet.",
    "role": "Role",
    "name": "Name",
    "edit": "Edit",
    "roleAdmin": "Admin",
    "roleRecorder": "Recorder",
    "roleBiller": "Biller",
    "save": "Save",
    "cancel": "Cancel",
    "remove": "Remove",
    "confirmRemoveTitle": "Remove this person?",
    "confirmRemoveBody": "They will lose access to this shop. Their sign-in account is not deleted.",
    "confirmRemoveAccept": "Remove them",
    "self": "You",
    "selfLocked": "You cannot change your own role or remove yourself. If you did, nobody could undo it without direct database access.",
    "cannotInvite": "Adding someone is not done here yet. They sign up first, then an admin links their account in the database — see docs/runbook-first-admin.md."
  },
  "settings": {
    "title": "Loyalty settings",
    "threshold1": "First spend target",
    "reward1": "Points for the first target",
    "threshold2": "Second spend target",
    "reward2": "Points for the second target",
    "redeemDays": "Points expire after (days)",
    "save": "Save",
    "saved": "Saved.",
    "futureOnly": "These rules apply to bills completed from now on. Points already awarded are never recalculated.",
    "required": "This field is required.",
    "badNumber": "Enter a number.",
    "notPositive": "Enter a number above zero.",
    "notWhole": "Enter a whole number.",
    "outOfOrder": "The second target must be larger than the first."
  }
```

- [ ] **Step 6: Add the Hindi strings**

In `web/src/i18n/hi.json`, add `"settings": "सेटिंग"` to `nav`, and the same four namespaces with identical keys:

```json
  "items": {
    "title": "सामान और स्टॉक",
    "add": "सामान जोड़ें",
    "edit": "सामान बदलें",
    "nameEn": "नाम (अंग्रेज़ी)",
    "nameHi": "नाम (हिंदी)",
    "nameMr": "नाम (मराठी)",
    "price": "भाव प्रति किलो",
    "stock": "स्टॉक (किलो)",
    "save": "सहेजें",
    "cancel": "रद्द करें",
    "empty": "अभी कोई सामान नहीं। पहला जोड़ें।",
    "inStock": "{{kg}} किलो",
    "low": "स्टॉक कम है",
    "out": "स्टॉक खत्म",
    "inactive": "छिपा हुआ",
    "deactivate": "बिलिंग से छिपाएं",
    "reactivate": "फिर बिक्री पर लाएं",
    "stockNote": "आपने जो स्टॉक गिना है वह लिखें। यह मौजूदा आंकड़े की जगह लेगा; बिल पूरा होने पर उसमें से घटता रहेगा।",
    "namesNote": "तीनों नाम ज़रूरी हैं। ग्राहक को नाम उसकी अपनी भाषा में दिखता है।",
    "required": "यह ज़रूरी है।",
    "badPrice": "शून्य या उससे ज़्यादा भाव लिखें।",
    "badStock": "शून्य या उससे ज़्यादा स्टॉक लिखें।"
  },
  "customersScreen": {
    "title": "ग्राहक",
    "search": "नाम, फ्लैट या मोबाइल से खोजें",
    "empty": "अभी कोई ग्राहक नहीं।",
    "edit": "ग्राहक बदलें",
    "points": "{{n}} पॉइंट",
    "pointsUnknown": "पॉइंट जांचे नहीं जा सके।",
    "save": "सहेजें",
    "cancel": "रद्द करें",
    "duplicate": "यह मोबाइल नंबर किसी और ग्राहक का है।"
  },
  "staff": {
    "title": "स्टाफ",
    "empty": "अभी कोई स्टाफ नहीं।",
    "role": "भूमिका",
    "name": "नाम",
    "edit": "बदलें",
    "roleAdmin": "एडमिन",
    "roleRecorder": "रिकॉर्डर",
    "roleBiller": "बिलर",
    "save": "सहेजें",
    "cancel": "रद्द करें",
    "remove": "हटाएं",
    "confirmRemoveTitle": "इन्हें हटाएं?",
    "confirmRemoveBody": "इनकी इस दुकान तक पहुंच खत्म हो जाएगी। इनका साइन-इन खाता नहीं मिटता।",
    "confirmRemoveAccept": "हटा दें",
    "self": "आप",
    "selfLocked": "आप अपनी भूमिका नहीं बदल सकते और न खुद को हटा सकते हैं। ऐसा होने पर इसे डेटाबेस के बिना कोई ठीक नहीं कर पाएगा।",
    "cannotInvite": "किसी को जोड़ना अभी यहां से नहीं होता। पहले वे साइन अप करें, फिर एडमिन उनका खाता डेटाबेस में जोड़े — docs/runbook-first-admin.md देखें।"
  },
  "settings": {
    "title": "लॉयल्टी सेटिंग",
    "threshold1": "पहला खर्च लक्ष्य",
    "reward1": "पहले लक्ष्य के पॉइंट",
    "threshold2": "दूसरा खर्च लक्ष्य",
    "reward2": "दूसरे लक्ष्य के पॉइंट",
    "redeemDays": "पॉइंट कितने दिन बाद खत्म हों",
    "save": "सहेजें",
    "saved": "सहेजा गया।",
    "futureOnly": "ये नियम अब से पूरे होने वाले बिलों पर लागू होंगे। पहले दिए गए पॉइंट कभी दोबारा नहीं गिने जाते।",
    "required": "यह ज़रूरी है।",
    "badNumber": "संख्या लिखें।",
    "notPositive": "शून्य से बड़ी संख्या लिखें।",
    "notWhole": "पूरी संख्या लिखें।",
    "outOfOrder": "दूसरा लक्ष्य पहले से बड़ा होना चाहिए।"
  }
```

- [ ] **Step 7: Add the Marathi strings**

In `web/src/i18n/mr.json`, add `"settings": "सेटिंग"` to `nav`, and:

```json
  "items": {
    "title": "माल आणि साठा",
    "add": "माल जोडा",
    "edit": "माल बदला",
    "nameEn": "नाव (इंग्रजी)",
    "nameHi": "नाव (हिंदी)",
    "nameMr": "नाव (मराठी)",
    "price": "प्रति किलो भाव",
    "stock": "साठा (किलो)",
    "save": "जतन करा",
    "cancel": "रद्द करा",
    "empty": "अजून माल नाही. पहिला जोडा.",
    "inStock": "{{kg}} किलो",
    "low": "साठा कमी आहे",
    "out": "साठा संपला",
    "inactive": "लपवलेला",
    "deactivate": "बिलिंगमधून लपवा",
    "reactivate": "पुन्हा विक्रीवर आणा",
    "stockNote": "तुम्ही मोजलेला साठा लिहा. हा आताच्या आकड्याची जागा घेईल; बिल पूर्ण झाल्यावर त्यातून वजा होत राहील.",
    "namesNote": "तिन्ही नावे आवश्यक आहेत. ग्राहकाला नाव त्याच्या भाषेत दिसते.",
    "required": "हे आवश्यक आहे.",
    "badPrice": "शून्य किंवा त्याहून जास्त भाव लिहा.",
    "badStock": "शून्य किंवा त्याहून जास्त साठा लिहा."
  },
  "customersScreen": {
    "title": "ग्राहक",
    "search": "नाव, फ्लॅट किंवा मोबाइलने शोधा",
    "empty": "अजून ग्राहक नाहीत.",
    "edit": "ग्राहक बदला",
    "points": "{{n}} पॉइंट",
    "pointsUnknown": "पॉइंट तपासता आले नाहीत.",
    "save": "जतन करा",
    "cancel": "रद्द करा",
    "duplicate": "हा मोबाइल नंबर दुसऱ्या ग्राहकाचा आहे."
  },
  "staff": {
    "title": "कर्मचारी",
    "empty": "अजून कर्मचारी नाहीत.",
    "role": "भूमिका",
    "name": "नाव",
    "edit": "बदला",
    "roleAdmin": "अ‍ॅडमिन",
    "roleRecorder": "रेकॉर्डर",
    "roleBiller": "बिलर",
    "save": "जतन करा",
    "cancel": "रद्द करा",
    "remove": "काढून टाका",
    "confirmRemoveTitle": "यांना काढून टाकायचे?",
    "confirmRemoveBody": "त्यांचा या दुकानाशी संपर्क संपेल. त्यांचे साइन-इन खाते मिटत नाही.",
    "confirmRemoveAccept": "काढून टाका",
    "self": "तुम्ही",
    "selfLocked": "तुम्ही स्वतःची भूमिका बदलू शकत नाही किंवा स्वतःला काढू शकत नाही. तसे झाल्यास डेटाबेसशिवाय ते कोणीही दुरुस्त करू शकणार नाही.",
    "cannotInvite": "कोणाला जोडणे अजून इथून होत नाही. आधी त्यांनी साइन अप करावे, मग अ‍ॅडमिनने त्यांचे खाते डेटाबेसमध्ये जोडावे — docs/runbook-first-admin.md पाहा."
  },
  "settings": {
    "title": "लॉयल्टी सेटिंग",
    "threshold1": "पहिले खर्च लक्ष्य",
    "reward1": "पहिल्या लक्ष्याचे पॉइंट",
    "threshold2": "दुसरे खर्च लक्ष्य",
    "reward2": "दुसऱ्या लक्ष्याचे पॉइंट",
    "redeemDays": "पॉइंट किती दिवसांनी संपावेत",
    "save": "जतन करा",
    "saved": "जतन झाले.",
    "futureOnly": "हे नियम आतापासून पूर्ण होणाऱ्या बिलांना लागू होतील. आधी दिलेले पॉइंट पुन्हा कधीच मोजले जात नाहीत.",
    "required": "हे आवश्यक आहे.",
    "badNumber": "संख्या लिहा.",
    "notPositive": "शून्यापेक्षा मोठी संख्या लिहा.",
    "notWhole": "पूर्ण संख्या लिहा.",
    "outOfOrder": "दुसरे लक्ष्य पहिल्यापेक्षा मोठे हवे."
  }
```

- [ ] **Step 8: Run the whole suite**

Run: `cd web && npm test`
Expected: PASS, all files. Then `cd web && npm run build` — expected: clean.

- [ ] **Step 9: Commit**

```bash
git add web/src/routes.ts web/src/i18n web/src/__tests__/routes.test.ts
git commit -m "feat: add the /settings route and stage 3's translation keys"
```

---

### Task 2: Pure rules — item, settings and staff validation

No mocks anywhere in this task. These are the decisions §11b makes, expressed as functions the screens call.

**Files:**
- Create: `web/src/adminRules.ts`
- Test: `web/src/__tests__/adminRules.test.ts`

**Interfaces:**
- Consumes: nothing (deliberately — no supabase, no React).
- Produces:
  - `type ItemInput = { name_en: string; name_hi: string; name_mr: string; price: string; stock_kg: string }`
  - `type ItemField = keyof ItemInput`
  - `type ItemValue = { name_en: string; name_hi: string; name_mr: string; price: number; stock_kg: number }`
  - `validateItem(input: ItemInput): { ok: true; value: ItemValue } | { ok: false; errors: Partial<Record<ItemField, string>> }`
  - `type SettingsInput = { points_threshold_1: string; points_reward_1: string; points_threshold_2: string; points_reward_2: string; redeem_days: string }`
  - `type SettingsField = keyof SettingsInput`
  - `validateSettings(input: SettingsInput): { ok: true; value: Record<SettingsField, number> } | { ok: false; errors: Partial<Record<SettingsField, string>> }`
  - `canEditStaff(selfUserId: string, targetUserId: string): boolean`
  - `LOW_STOCK_KG: number`, `stockLevel(kg: number): "out" | "low" | "ok"`

- [ ] **Step 1: Write the failing test**

Create `web/src/__tests__/adminRules.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import {
  validateItem, validateSettings, canEditStaff, stockLevel, LOW_STOCK_KG,
} from "../adminRules";

const item = { name_en: "Onion", name_hi: "प्याज", name_mr: "कांदा", price: "40", stock_kg: "12.5" };

describe("validateItem", () => {
  it("accepts a complete item and returns numbers, not strings", () => {
    const r = validateItem(item);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toEqual({
      name_en: "Onion", name_hi: "प्याज", name_mr: "कांदा", price: 40, stock_kg: 12.5,
    });
  });

  it("requires all three names", () => {
    // §11b: a shopkeeper's own Marathi is the only native-quality Indian-language text
    // this app will ever hold, and a blank never gets filled in later.
    const r = validateItem({ ...item, name_hi: "", name_mr: "  " });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(Object.keys(r.errors).sort()).toEqual(["name_hi", "name_mr"]);
  });

  it("reports every problem at once", () => {
    const r = validateItem({ name_en: "", name_hi: "", name_mr: "", price: "x", stock_kg: "-1" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(Object.keys(r.errors).sort())
      .toEqual(["name_en", "name_hi", "name_mr", "price", "stock_kg"]);
  });

  it("accepts zero price and zero stock", () => {
    // 0001_schema.sql checks price >= 0 and stock_kg >= 0, not > 0. A free item and a
    // sold-out item are both legitimate.
    expect(validateItem({ ...item, price: "0", stock_kg: "0" }).ok).toBe(true);
  });

  it("rejects a negative price or stock", () => {
    expect(validateItem({ ...item, price: "-1" }).ok).toBe(false);
    expect(validateItem({ ...item, stock_kg: "-0.5" }).ok).toBe(false);
  });

  it("trims the names it returns", () => {
    const r = validateItem({ ...item, name_en: "  Onion  " });
    if (r.ok) expect(r.value.name_en).toBe("Onion");
  });
});

describe("validateSettings", () => {
  const ok = {
    points_threshold_1: "600", points_reward_1: "50",
    points_threshold_2: "1000", points_reward_2: "100", redeem_days: "30",
  };

  it("accepts the schema defaults", () => {
    const r = validateSettings(ok);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.points_threshold_1).toBe(600);
  });

  it("requires the second target to exceed the first", () => {
    // complete_bill() awards reward_2 when the total clears threshold_2; an inverted
    // pair makes the first tier unreachable and is a config mistake, not a policy.
    const r = validateSettings({ ...ok, points_threshold_2: "500" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.points_threshold_2).toBeTruthy();
  });

  it("rejects an equal pair", () => {
    expect(validateSettings({ ...ok, points_threshold_2: "600" }).ok).toBe(false);
  });

  it("requires whole numbers for rewards and days", () => {
    // points_reward_1 and redeem_days are integer columns; 2.5 would be silently
    // truncated by Postgres.
    expect(validateSettings({ ...ok, points_reward_1: "2.5" }).ok).toBe(false);
    expect(validateSettings({ ...ok, redeem_days: "30.5" }).ok).toBe(false);
  });

  it("allows a fractional threshold", () => {
    // thresholds are numeric(10,2) -- rupees and paise.
    expect(validateSettings({ ...ok, points_threshold_1: "599.50" }).ok).toBe(true);
  });

  it("rejects zero and negative values", () => {
    expect(validateSettings({ ...ok, redeem_days: "0" }).ok).toBe(false);
    expect(validateSettings({ ...ok, points_reward_1: "-5" }).ok).toBe(false);
  });

  it("rejects blanks and non-numbers", () => {
    const r = validateSettings({ ...ok, points_threshold_1: "", points_reward_2: "lots" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(Object.keys(r.errors).sort())
      .toEqual(["points_reward_2", "points_threshold_1"]);
  });
});

describe("canEditStaff", () => {
  it("lets an admin edit someone else", () => {
    expect(canEditStaff("me", "them")).toBe(true);
  });

  it("refuses self-edit", () => {
    // The one action that locks a vendor out of its own tenant: users_admin_write needs
    // current_user_role() = 'admin', so a last admin who demotes themselves leaves
    // nobody able to undo it, and the repair is hand-written SQL against production.
    expect(canEditStaff("me", "me")).toBe(false);
  });
});

describe("stockLevel", () => {
  it("calls zero out of stock", () => {
    expect(stockLevel(0)).toBe("out");
  });

  it("calls anything at or under the threshold low", () => {
    expect(stockLevel(LOW_STOCK_KG)).toBe("low");
    expect(stockLevel(0.5)).toBe("low");
  });

  it("calls a healthy figure ok", () => {
    expect(stockLevel(LOW_STOCK_KG + 0.01)).toBe("ok");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd web && npx vitest run src/__tests__/adminRules.test.ts`
Expected: FAIL — cannot resolve `../adminRules`.

- [ ] **Step 3: Write the implementation**

Create `web/src/adminRules.ts`:

```ts
/**
 * Pure rules for the admin screens. No supabase import, no React -- these are the
 * decisions §11b makes, and they are testable without mocking anything.
 *
 * These validations are convenience, not enforcement. The column CHECKs in
 * 0001_schema.sql (price >= 0, stock_kg >= 0) and the policies in 0002_rls.sql are what
 * actually hold. Rejecting here only buys a clearer message than a 400 from PostgREST.
 */

export type ItemInput = {
  name_en: string;
  name_hi: string;
  name_mr: string;
  price: string;
  stock_kg: string;
};
export type ItemField = keyof ItemInput;

export type ItemValue = {
  name_en: string;
  name_hi: string;
  name_mr: string;
  price: number;
  stock_kg: number;
};

/** At or below this many kg, a row is coloured. Matches the bill grid's threshold. */
export const LOW_STOCK_KG = 2;

export function stockLevel(kg: number): "out" | "low" | "ok" {
  if (kg <= 0) return "out";
  return kg <= LOW_STOCK_KG ? "low" : "ok";
}

/** A non-negative decimal, or null. Rejects "", "x", "1e3" and "-1". */
function nonNegative(raw: string): number | null {
  const s = raw.trim();
  if (s === "" || !/^\d+(\.\d+)?$/.test(s)) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

export function validateItem(
  input: ItemInput,
): { ok: true; value: ItemValue } | { ok: false; errors: Partial<Record<ItemField, string>> } {
  const errors: Partial<Record<ItemField, string>> = {};

  // All three names, per §11b. The columns default to '' so the database will not stop
  // a blank; this is the only place it is stopped.
  for (const f of ["name_en", "name_hi", "name_mr"] as const) {
    if (input[f].trim() === "") errors[f] = "items.required";
  }

  const price = nonNegative(input.price);
  if (price === null) errors.price = "items.badPrice";

  const stock = nonNegative(input.stock_kg);
  if (stock === null) errors.stock_kg = "items.badStock";

  if (Object.keys(errors).length > 0) return { ok: false, errors };
  return {
    ok: true,
    value: {
      name_en: input.name_en.trim(),
      name_hi: input.name_hi.trim(),
      name_mr: input.name_mr.trim(),
      price: price as number,
      stock_kg: stock as number,
    },
  };
}

export type SettingsInput = {
  points_threshold_1: string;
  points_reward_1: string;
  points_threshold_2: string;
  points_reward_2: string;
  redeem_days: string;
};
export type SettingsField = keyof SettingsInput;

/** Which of the five are integer columns in 0001_schema.sql. The thresholds are
 *  numeric(10,2) and may carry paise; the rest would be truncated silently. */
const WHOLE: readonly SettingsField[] = ["points_reward_1", "points_reward_2", "redeem_days"];

export function validateSettings(
  input: SettingsInput,
):
  | { ok: true; value: Record<SettingsField, number> }
  | { ok: false; errors: Partial<Record<SettingsField, string>> } {
  const errors: Partial<Record<SettingsField, string>> = {};
  const value = {} as Record<SettingsField, number>;

  for (const f of Object.keys(input) as SettingsField[]) {
    const s = input[f].trim();
    if (s === "") { errors[f] = "settings.required"; continue; }
    const n = nonNegative(s);
    if (n === null) { errors[f] = "settings.badNumber"; continue; }
    if (n <= 0) { errors[f] = "settings.notPositive"; continue; }
    if (WHOLE.includes(f) && !Number.isInteger(n)) { errors[f] = "settings.notWhole"; continue; }
    value[f] = n;
  }

  // Only meaningful once both parsed. complete_bill() awards reward_2 above threshold_2;
  // an inverted pair makes the first tier unreachable.
  if (
    errors.points_threshold_1 === undefined &&
    errors.points_threshold_2 === undefined &&
    value.points_threshold_2 <= value.points_threshold_1
  ) {
    errors.points_threshold_2 = "settings.outOfOrder";
  }

  if (Object.keys(errors).length > 0) return { ok: false, errors };
  return { ok: true, value };
}

/**
 * Whether an admin may change this staff row.
 *
 * False for themselves. Demoting or removing yourself is the single action that locks a
 * vendor out of its own tenant: users_admin_write requires current_user_role() = 'admin',
 * so once the last admin is gone nobody can undo it and the repair is hand-written SQL
 * against production.
 */
export function canEditStaff(selfUserId: string, targetUserId: string): boolean {
  return selfUserId !== targetUserId;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd web && npx vitest run src/__tests__/adminRules.test.ts`
Expected: PASS, all cases.

- [ ] **Step 5: Commit**

```bash
git add web/src/adminRules.ts web/src/__tests__/adminRules.test.ts
git commit -m "feat: add the admin screens' validation rules"
```

---

### Task 3: The admin data layer

**Files:**
- Create: `web/src/admin.ts`
- Test: `web/src/__tests__/admin.test.ts`

**Interfaces:**
- Consumes: `supabase` from `./supabase`; `ItemValue`, `SettingsField` from `./adminRules`; `Role` from `./config`.
- Produces:
  - `type AdminItem = { id: string; name_en: string; name_hi: string; name_mr: string; price: number; stock_kg: number; is_active: boolean }`
  - `type StaffRow = { id: string; name: string; role: Role }`
  - `type VendorConfig = Record<SettingsField, number>`
  - `listAllItems()`, `createItem(vendorId, value)`, `updateItem(id, value)`, `setItemActive(id, isActive)`
  - `updateCustomer(id, input)`, `customerPoints(customerId)`
  - `listStaff()`, `updateStaff(id, patch)`, `removeStaff(id)`
  - `loadVendorConfig(vendorId)`, `updateVendorConfig(vendorId, value)`

- [ ] **Step 1: Write the failing test**

Create `web/src/__tests__/admin.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";

const insert = vi.fn((..._a: unknown[]) => ({
  select: () => ({ single: async () => ({ data: { id: "i1" }, error: null }) }),
}));
const eqUpdate = vi.fn(async (..._a: unknown[]) => ({ error: null }));
const update = vi.fn((..._a: unknown[]) => ({ eq: (...b: unknown[]) => eqUpdate(...b) }));
const del = vi.fn((..._a: unknown[]) => ({ eq: (...b: unknown[]) => eqUpdate(...b) }));
const rpc = vi.fn(async (..._a: unknown[]) => ({ data: 120, error: null }));
const from = vi.fn((..._a: unknown[]) => ({
  insert, update, delete: del,
  select: () => ({
    order: async () => ({ data: [], error: null }),
    eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }),
  }),
}));

vi.mock("../supabase", () => ({
  supabase: { from: (...a: unknown[]) => from(...a), rpc: (...a: unknown[]) => rpc(...a) },
}));

const {
  listAllItems, createItem, updateItem, setItemActive,
  updateCustomer, customerPoints, listStaff, updateStaff, removeStaff,
  loadVendorConfig, updateVendorConfig,
} = await import("../admin");

const value = { name_en: "Onion", name_hi: "प्याज", name_mr: "कांदा", price: 40, stock_kg: 12.5 };

beforeEach(() => vi.clearAllMocks());

describe("listAllItems", () => {
  it("reads items without filtering is_active", async () => {
    // listItems() in data.ts hides inactive items from the bill grid on purpose. An
    // admin who cannot see a hidden item cannot bring it back.
    await listAllItems();
    expect(from).toHaveBeenCalledWith("items");
  });
});

describe("createItem", () => {
  it("stamps vendor_id", async () => {
    // NOT NULL with no default. Forgetting it has shipped as a bug once already.
    await createItem("v1", value);
    expect(insert).toHaveBeenCalledWith(expect.objectContaining({
      vendor_id: "v1", name_en: "Onion",
    }));
  });
});

describe("updateItem", () => {
  it("updates by id and never sends vendor_id", async () => {
    // RLS scopes the row; re-sending vendor_id would let a typo attempt a tenant move
    // that items_admin_write would refuse anyway.
    await updateItem("i1", value);
    expect(update).toHaveBeenCalledWith(expect.objectContaining({ price: 40 }));
    expect(update.mock.calls[0]?.[0]).not.toHaveProperty("vendor_id");
    expect(eqUpdate).toHaveBeenCalledWith("id", "i1");
  });
});

describe("setItemActive", () => {
  it("flips is_active rather than deleting", async () => {
    // bill_items.item_id references items; a delete would fail the FK or destroy the
    // history the dashboards read.
    await setItemActive("i1", false);
    expect(update).toHaveBeenCalledWith({ is_active: false });
    expect(del).not.toHaveBeenCalled();
  });
});

describe("updateCustomer", () => {
  it("updates the three editable fields by id", async () => {
    await updateCustomer("c1", { name: "Asha", flat_no: "A-1", mobile: "+919000000000" });
    expect(from).toHaveBeenCalledWith("customers");
    expect(update).toHaveBeenCalledWith({ name: "Asha", flat_no: "A-1", mobile: "+919000000000" });
    expect(eqUpdate).toHaveBeenCalledWith("id", "c1");
  });
});

describe("customerPoints", () => {
  it("calls the function with the parameter name the migration declares", async () => {
    // 0003_functions.sql declares customer_points_balance(p_customer_id uuid).
    const r = await customerPoints("c1");
    expect(rpc).toHaveBeenCalledWith("customer_points_balance", { p_customer_id: "c1" });
    expect(r.data).toBe(120);
  });
});

describe("listStaff", () => {
  it("reads app_users", async () => {
    await listStaff();
    expect(from).toHaveBeenCalledWith("app_users");
  });
});

describe("updateStaff", () => {
  it("sends only the fields given", async () => {
    await updateStaff("u2", { role: "biller" });
    expect(update).toHaveBeenCalledWith({ role: "biller" });
    expect(eqUpdate).toHaveBeenCalledWith("id", "u2");
  });
});

describe("removeStaff", () => {
  it("deletes the app_users row by id", async () => {
    // This unlinks the person from the vendor. It does NOT delete their auth account --
    // the SPA holds only the anon key, and the screen's copy must not imply otherwise.
    await removeStaff("u2");
    expect(from).toHaveBeenCalledWith("app_users");
    expect(del).toHaveBeenCalled();
    expect(eqUpdate).toHaveBeenCalledWith("id", "u2");
  });
});

describe("vendor config", () => {
  it("reads the vendor row by id", async () => {
    await loadVendorConfig("v1");
    expect(from).toHaveBeenCalledWith("vendors");
  });

  it("updates the five loyalty columns and nothing else", async () => {
    await updateVendorConfig("v1", {
      points_threshold_1: 600, points_reward_1: 50,
      points_threshold_2: 1000, points_reward_2: 100, redeem_days: 30,
    });
    expect(Object.keys(update.mock.calls[0]?.[0] as object).sort()).toEqual([
      "points_reward_1", "points_reward_2",
      "points_threshold_1", "points_threshold_2", "redeem_days",
    ]);
    expect(eqUpdate).toHaveBeenCalledWith("id", "v1");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd web && npx vitest run src/__tests__/admin.test.ts`
Expected: FAIL — cannot resolve `../admin`.

- [ ] **Step 3: Write the implementation**

Create `web/src/admin.ts`:

```ts
import { supabase } from "./supabase";
import type { ItemValue, SettingsField } from "./adminRules";
import type { Role } from "./config";

/**
 * Every PostgREST call the admin screens make.
 *
 * Separate from data.ts, which is the billing flow's file, for the reason data.ts gives
 * for existing at all: a small surface the screens can stub in tests, kept small enough
 * to hold in one head.
 *
 * As in data.ts, none of these functions filters by vendor. RLS scopes every query to
 * the caller's tenant, and a client-side filter would be a weaker second copy of the
 * policy. Nor do the update functions re-send vendor_id: the row is already scoped, and
 * sending it would suggest a tenant move is something the client can attempt.
 */

export type AdminItem = {
  id: string;
  name_en: string;
  name_hi: string;
  name_mr: string;
  price: number;
  stock_kg: number;
  is_active: boolean;
};

export type StaffRow = { id: string; name: string; role: Role };

export type VendorConfig = Record<SettingsField, number>;

const ITEM_COLS = "id, name_en, name_hi, name_mr, price, stock_kg, is_active";

/** Unlike listItems() in data.ts, this does NOT filter is_active. The bill grid hides
 *  inactive items; the admin list must show them or they can never be brought back. */
export async function listAllItems() {
  return supabase.from("items").select(ITEM_COLS).order("name_en");
}

export async function createItem(vendorId: string, value: ItemValue) {
  return supabase.from("items").insert({ vendor_id: vendorId, ...value }).select("id").single();
}

export async function updateItem(id: string, value: ItemValue) {
  return supabase.from("items").update({ ...value }).eq("id", id);
}

/** Items are hidden, never deleted: bill_items.item_id references them, so a delete
 *  would either fail the FK or destroy the history the dashboards read. */
export async function setItemActive(id: string, isActive: boolean) {
  return supabase.from("items").update({ is_active: isActive }).eq("id", id);
}

export async function updateCustomer(
  id: string,
  input: { name: string; flat_no: string; mobile: string },
) {
  return supabase.from("customers").update({ ...input }).eq("id", id);
}

/** Parameter name must match 0003_functions.sql exactly; PostgREST resolves the overload
 *  by argument name, and a mismatch reads as "function not found". The function already
 *  excludes expired rows, so this is the balance, not a raw sum. */
export async function customerPoints(customerId: string) {
  return supabase.rpc("customer_points_balance", { p_customer_id: customerId });
}

export async function listStaff() {
  return supabase.from("app_users").select("id, name, role").order("name");
}

export async function updateStaff(id: string, patch: { name?: string; role?: Role }) {
  return supabase.from("app_users").update(patch).eq("id", id);
}

/** Unlinks a person from this vendor. Their auth.users account is untouched -- the SPA
 *  holds only the anon key and has no admin API. They simply stop resolving to a tenant,
 *  which SessionProvider renders as the "not linked to a shop" screen. */
export async function removeStaff(id: string) {
  return supabase.from("app_users").delete().eq("id", id);
}

const CONFIG_COLS =
  "points_threshold_1, points_reward_1, points_threshold_2, points_reward_2, redeem_days";

export async function loadVendorConfig(vendorId: string) {
  return supabase.from("vendors").select(CONFIG_COLS).eq("id", vendorId).maybeSingle();
}

/** vendors_admin_update permits the whole row to an admin; this sends only the five
 *  loyalty columns so a future column cannot be clobbered by this screen by accident. */
export async function updateVendorConfig(vendorId: string, value: VendorConfig) {
  return supabase
    .from("vendors")
    .update({
      points_threshold_1: value.points_threshold_1,
      points_reward_1: value.points_reward_1,
      points_threshold_2: value.points_threshold_2,
      points_reward_2: value.points_reward_2,
      redeem_days: value.redeem_days,
    })
    .eq("id", vendorId);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd web && npx vitest run src/__tests__/admin.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add web/src/admin.ts web/src/__tests__/admin.test.ts
git commit -m "feat: add the admin screens' PostgREST layer"
```

---

### Task 4: Items and stock screen

**Files:**
- Create: `web/src/screens/Items.tsx`
- Test: `web/src/__tests__/Items.test.tsx`

**Interfaces:**
- Consumes: `listAllItems`, `createItem`, `updateItem`, `setItemActive`, `AdminItem` from `../admin`; `validateItem`, `stockLevel`, `ItemInput`, `ItemField` from `../adminRules`; `useSession` from `../components/SessionProvider`; `itemName`, `Lang` from `../i18n/locales`; `rupees` from `../money`; `describeError` from `../errors`.
- Produces: `export default function Items()`.

- [ ] **Step 1: Write the failing test**

Create `web/src/__tests__/Items.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import type { AdminItem } from "../admin";

const rows: AdminItem[] = [
  { id: "i1", name_en: "Onion", name_hi: "प्याज", name_mr: "कांदा", price: 40, stock_kg: 12.5, is_active: true },
  { id: "i2", name_en: "Beet", name_hi: "चुकंदर", name_mr: "बीट", price: 30, stock_kg: 0, is_active: false },
];

const listAllItems = vi.fn(async (): Promise<{ data: AdminItem[] | null; error: null }> =>
  ({ data: rows, error: null }));
const createItem = vi.fn(async (..._a: unknown[]) => ({ data: { id: "i3" }, error: null }));
const updateItem = vi.fn(async (..._a: unknown[]) => ({ error: null }));
const setItemActive = vi.fn(async (..._a: unknown[]) => ({ error: null }));

vi.mock("../admin", () => ({
  listAllItems: (...a: unknown[]) => listAllItems(...a),
  createItem: (...a: unknown[]) => createItem(...a),
  updateItem: (...a: unknown[]) => updateItem(...a),
  setItemActive: (...a: unknown[]) => setItemActive(...a),
}));

vi.mock("../components/SessionProvider", () => ({
  useSession: () => ({
    kind: "ready", userId: "u1", vendorId: "v1", vendorName: "Shop", name: "Admin", role: "admin",
  }),
}));

const { default: Items } = await import("../screens/Items");

beforeEach(() => vi.clearAllMocks());

describe("the items screen", () => {
  it("lists inactive items too", async () => {
    // listItems() hides them from the bill grid; an admin who cannot see a hidden item
    // cannot bring it back.
    render(<Items />);
    expect(await screen.findByText(/Onion|कांदा/)).toBeTruthy();
    expect(screen.getByText(/Beet|बीट/)).toBeTruthy();
  });

  it("shows the price through rupees()", async () => {
    render(<Items />);
    expect(await screen.findByText(/₹40\.00/)).toBeTruthy();
  });

  it("marks a zero-stock item out of stock", async () => {
    render(<Items />);
    expect(await screen.findByText(/out of stock|साठा संपला|स्टॉक खत्म/i)).toBeTruthy();
  });

  it("refuses to save an item missing its Marathi name", async () => {
    render(<Items />);
    fireEvent.click(await screen.findByRole("button", { name: /add item|माल जोडा|सामान जोड़ें/i }));
    fireEvent.change(screen.getByLabelText(/english|इंग्रजी|अंग्रेज़ी/i), { target: { value: "Carrot" } });
    fireEvent.change(screen.getByLabelText(/hindi|हिंदी/i), { target: { value: "गाजर" } });
    fireEvent.change(screen.getByLabelText(/price|भाव/i), { target: { value: "50" } });
    fireEvent.change(screen.getByLabelText(/stock|साठा|स्टॉक/i), { target: { value: "5" } });
    fireEvent.click(screen.getByTestId("item-save"));
    await waitFor(() => expect(createItem).not.toHaveBeenCalled());
  });

  it("creates a complete item with the vendor id", async () => {
    render(<Items />);
    fireEvent.click(await screen.findByRole("button", { name: /add item|माल जोडा|सामान जोड़ें/i }));
    fireEvent.change(screen.getByLabelText(/english|इंग्रजी|अंग्रेज़ी/i), { target: { value: "Carrot" } });
    fireEvent.change(screen.getByLabelText(/hindi|हिंदी/i), { target: { value: "गाजर" } });
    fireEvent.change(screen.getByLabelText(/marathi|मराठी/i), { target: { value: "गाजर" } });
    fireEvent.change(screen.getByLabelText(/price|भाव/i), { target: { value: "50" } });
    fireEvent.change(screen.getByLabelText(/stock|साठा|स्टॉक/i), { target: { value: "5" } });
    fireEvent.click(screen.getByTestId("item-save"));
    await waitFor(() => expect(createItem).toHaveBeenCalledWith("v1", expect.objectContaining({
      name_en: "Carrot", price: 50, stock_kg: 5,
    })));
  });

  it("edits an existing item by id, not by insert", async () => {
    render(<Items />);
    fireEvent.click((await screen.findAllByTestId(/^item-edit-/))[0]!);
    fireEvent.change(screen.getByLabelText(/stock|साठा|स्टॉक/i), { target: { value: "20" } });
    fireEvent.click(screen.getByTestId("item-save"));
    await waitFor(() => expect(updateItem)
      .toHaveBeenCalledWith("i1", expect.objectContaining({ stock_kg: 20 })));
    expect(createItem).not.toHaveBeenCalled();
  });

  it("hides an item rather than deleting it", async () => {
    render(<Items />);
    fireEvent.click((await screen.findAllByTestId(/^item-toggle-/))[0]!);
    await waitFor(() => expect(setItemActive).toHaveBeenCalledWith("i1", false));
  });

  it("reloads after a change so the list matches the server", async () => {
    render(<Items />);
    await screen.findAllByTestId(/^item-toggle-/);
    expect(listAllItems).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getAllByTestId(/^item-toggle-/)[0]!);
    await waitFor(() => expect(listAllItems).toHaveBeenCalledTimes(2));
  });

  it("says nothing yet, not not allowed, on an empty list", async () => {
    // A policy-filtered read is zero rows, not an error. See errors.ts.
    listAllItems.mockResolvedValueOnce({ data: [], error: null });
    render(<Items />);
    expect(await screen.findByText(/no items yet|अजून माल नाही|कोई सामान नहीं/i)).toBeTruthy();
  });
});
```

Note on the queries: the suite runs under whatever language i18n resolves to in jsdom, which defaults to Marathi (`resolveLang(null, ...)` returns `mr`). Buttons whose label would be ambiguous or language-dependent are found by `data-testid` instead; visible copy is matched with an alternation covering all three languages. Do not change the app's default language to make a test easier.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd web && npx vitest run src/__tests__/Items.test.tsx`
Expected: FAIL — cannot resolve `../screens/Items`.

- [ ] **Step 3: Write the screen**

Create `web/src/screens/Items.tsx`. Follow `web/src/screens/Pending.tsx` for the load/refresh/error shape.

```tsx
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { listAllItems, createItem, updateItem, setItemActive, type AdminItem } from "../admin";
import { validateItem, stockLevel, type ItemInput, type ItemField } from "../adminRules";
import { useSession } from "../components/SessionProvider";
import { itemName, type Lang } from "../i18n/locales";
import { rupees } from "../money";
import { describeError } from "../errors";

const BLANK: ItemInput = { name_en: "", name_hi: "", name_mr: "", price: "", stock_kg: "" };

const FIELDS = [
  ["name_en", "items.nameEn", "text"],
  ["name_hi", "items.nameHi", "text"],
  ["name_mr", "items.nameMr", "text"],
  ["price", "items.price", "decimal"],
  ["stock_kg", "items.stock", "decimal"],
] as const;

function toInput(it: AdminItem): ItemInput {
  return {
    name_en: it.name_en, name_hi: it.name_hi, name_mr: it.name_mr,
    price: String(it.price), stock_kg: String(it.stock_kg),
  };
}

export default function Items() {
  const { t, i18n } = useTranslation();
  const session = useSession();
  const [rows, setRows] = useState<AdminItem[]>([]);
  const [problem, setProblem] = useState<{ key: string; detail: string } | null>(null);
  const [editing, setEditing] = useState<{ id: string | null; input: ItemInput } | null>(null);
  const [errors, setErrors] = useState<Partial<Record<ItemField, string>>>({});
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const { data, error } = await listAllItems();
    setProblem(describeError(error));
    setRows(data ?? []);
  }, []);

  useEffect(() => { void load(); }, [load]);

  if (session.kind !== "ready") return null;
  const { vendorId } = session;
  const lang = i18n.language as Lang;

  async function save() {
    if (!editing) return;
    const result = validateItem(editing.input);
    if (!result.ok) { setErrors(result.errors); return; }
    setErrors({});
    setBusy(true);
    const { error } = editing.id === null
      ? await createItem(vendorId, result.value)
      : await updateItem(editing.id, result.value);
    setBusy(false);
    const described = describeError(error);
    setProblem(described);
    if (described) return;
    setEditing(null);
    await load();
  }

  async function toggle(it: AdminItem) {
    setBusy(true);
    const { error } = await setItemActive(it.id, !it.is_active);
    setBusy(false);
    setProblem(describeError(error));
    await load();
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="font-semibold text-slate-800">{t("items.title")}</h2>
        <button
          onClick={() => { setErrors({}); setEditing({ id: null, input: BLANK }); }}
          className="border border-slate-300 rounded-lg px-3 py-2 text-sm bg-white min-h-[44px]"
        >
          {t("items.add")}
        </button>
      </div>

      {problem && (
        <p className="text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg p-3">
          {t(problem.key)}
        </p>
      )}

      {editing && (
        <form
          onSubmit={(e) => { e.preventDefault(); void save(); }}
          className="bg-white border border-slate-200 rounded-xl p-4 space-y-3"
        >
          <h3 className="font-semibold text-slate-800">
            {editing.id === null ? t("items.add") : t("items.edit")}
          </h3>
          <p className="text-xs text-slate-500">{t("items.namesNote")}</p>

          {FIELDS.map(([field, labelKey, kind]) => (
            <div key={field}>
              <label className="block text-sm text-slate-600 mb-1" htmlFor={`item-${field}`}>
                {t(labelKey)}
              </label>
              <input
                id={`item-${field}`}
                value={editing.input[field]}
                inputMode={kind === "decimal" ? "decimal" : undefined}
                onChange={(e) =>
                  setEditing({ ...editing, input: { ...editing.input, [field]: e.target.value } })
                }
                className="w-full border border-slate-300 rounded-lg px-3 py-2 min-h-[44px]"
              />
              {errors[field] && <p className="text-xs text-red-700 mt-1">{t(errors[field]!)}</p>}
            </div>
          ))}

          <p className="text-xs text-slate-500">{t("items.stockNote")}</p>

          <div className="flex gap-2">
            <button
              type="submit" data-testid="item-save" disabled={busy}
              className="rounded-lg px-4 py-2 text-sm bg-slate-800 text-white min-h-[44px] disabled:opacity-50"
            >
              {t("items.save")}
            </button>
            <button
              type="button" onClick={() => { setEditing(null); setErrors({}); }}
              className="border border-slate-300 rounded-lg px-4 py-2 text-sm bg-white min-h-[44px]"
            >
              {t("items.cancel")}
            </button>
          </div>
        </form>
      )}

      {rows.length === 0 ? (
        <p className="text-sm text-slate-500">{t("items.empty")}</p>
      ) : (
        <ul className="space-y-2">
          {rows.map((it) => {
            const level = stockLevel(it.stock_kg);
            return (
              <li
                key={it.id}
                className="bg-white border border-slate-200 rounded-xl p-3 flex items-center gap-3"
              >
                <div className="flex-1 min-w-0">
                  <p className="font-medium text-slate-800 truncate">
                    {itemName(it, lang)}
                    {!it.is_active && (
                      <span className="ml-2 text-xs text-slate-500">({t("items.inactive")})</span>
                    )}
                  </p>
                  <p className="text-sm text-slate-500">
                    {rupees(it.price)}
                    {" · "}
                    <span className={
                      level === "out" ? "text-red-700" : level === "low" ? "text-amber-700" : ""
                    }>
                      {level === "out" ? t("items.out") : t("items.inStock", { kg: it.stock_kg })}
                      {level === "low" && ` — ${t("items.low")}`}
                    </span>
                  </p>
                </div>
                <button
                  data-testid={`item-edit-${it.id}`}
                  onClick={() => { setErrors({}); setEditing({ id: it.id, input: toInput(it) }); }}
                  className="border border-slate-300 rounded-lg px-3 py-2 text-sm bg-white min-h-[44px]"
                >
                  {t("items.edit")}
                </button>
                <button
                  data-testid={`item-toggle-${it.id}`}
                  onClick={() => void toggle(it)} disabled={busy}
                  className="border border-slate-300 rounded-lg px-3 py-2 text-sm bg-white min-h-[44px] disabled:opacity-50"
                >
                  {it.is_active ? t("items.deactivate") : t("items.reactivate")}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd web && npx vitest run src/__tests__/Items.test.tsx`
Expected: PASS. If a query is ambiguous, tighten the query — do not loosen the component to satisfy it.

- [ ] **Step 5: Commit**

```bash
git add web/src/screens/Items.tsx web/src/__tests__/Items.test.tsx
git commit -m "feat: add the items and stock admin screen"
```

---

### Task 5: Customers screen

**Files:**
- Create: `web/src/screens/Customers.tsx`
- Test: `web/src/__tests__/Customers.test.tsx`

**Interfaces:**
- Consumes: `listCustomers` from `../data`; `updateCustomer`, `customerPoints` from `../admin`; `matchCustomers`, `validateCustomer`, `isDuplicateMobile`, `Customer` from `../customers`; `describeError` from `../errors`.
- Produces: `export default function Customers()`.

- [ ] **Step 1: Write the failing test**

Create `web/src/__tests__/Customers.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import type { Customer } from "../customers";

const all: Customer[] = [
  { id: "c1", name: "Asha", flat_no: "A-1", mobile: "+919000000001" },
  { id: "c2", name: "Bhau", flat_no: "B-2", mobile: "+919000000002" },
];

const listCustomers = vi.fn(async (): Promise<{ data: Customer[] | null; error: null }> =>
  ({ data: all, error: null }));
const updateCustomer = vi.fn(async (..._a: unknown[]): Promise<{
  error: { code?: string; message?: string } | null;
}> => ({ error: null }));
const customerPoints = vi.fn(async (..._a: unknown[]): Promise<{
  data: number | null; error: { code?: string; message?: string } | null;
}> => ({ data: 120, error: null }));

vi.mock("../data", () => ({ listCustomers: (...a: unknown[]) => listCustomers(...a) }));
vi.mock("../admin", () => ({
  updateCustomer: (...a: unknown[]) => updateCustomer(...a),
  customerPoints: (...a: unknown[]) => customerPoints(...a),
}));

const { default: Customers } = await import("../screens/Customers");

beforeEach(() => vi.clearAllMocks());

describe("the customers screen", () => {
  it("lists customers", async () => {
    render(<Customers />);
    expect(await screen.findByText(/Asha/)).toBeTruthy();
    expect(screen.getByText(/Bhau/)).toBeTruthy();
  });

  it("filters with the same matcher the bill flow uses", async () => {
    render(<Customers />);
    await screen.findByText(/Asha/);
    fireEvent.change(screen.getByTestId("customer-search"), { target: { value: "B-2" } });
    await waitFor(() => expect(screen.queryByText(/Asha/)).toBeNull());
    expect(screen.getByText(/Bhau/)).toBeTruthy();
  });

  it("shows the points balance when a customer is opened", async () => {
    render(<Customers />);
    fireEvent.click(await screen.findByTestId("customer-c1"));
    await waitFor(() => expect(customerPoints).toHaveBeenCalledWith("c1"));
    expect(await screen.findByText(/120/)).toBeTruthy();
  });

  it("distinguishes a failed points lookup from a zero balance", async () => {
    // Zero points is a real answer -- a bill under the first threshold earns none. A
    // failed call is not, and the two must not read alike.
    customerPoints.mockResolvedValueOnce({ data: null, error: { message: "boom" } });
    render(<Customers />);
    fireEvent.click(await screen.findByTestId("customer-c1"));
    expect(await screen.findByText(/could not be checked|तपासता आले नाहीं|जांचे नहीं/i)).toBeTruthy();
  });

  it("saves an edit by id", async () => {
    render(<Customers />);
    fireEvent.click(await screen.findByTestId("customer-c1"));
    fireEvent.change(screen.getByTestId("customer-field-flat_no"), { target: { value: "A-9" } });
    fireEvent.click(screen.getByTestId("customer-save"));
    await waitFor(() => expect(updateCustomer)
      .toHaveBeenCalledWith("c1", expect.objectContaining({ flat_no: "A-9" })));
  });

  it("refuses to save with a field blanked", async () => {
    // #11 makes all three mandatory, and validateCustomer already reports them at once.
    render(<Customers />);
    fireEvent.click(await screen.findByTestId("customer-c1"));
    fireEvent.change(screen.getByTestId("customer-field-mobile"), { target: { value: "" } });
    fireEvent.click(screen.getByTestId("customer-save"));
    await waitFor(() => expect(updateCustomer).not.toHaveBeenCalled());
  });

  it("reports a duplicate mobile in words, not as a constraint violation", async () => {
    // (vendor_id, mobile) is unique and an edit can collide with it exactly as a create
    // can. CustomerStep already handles this on the create path.
    updateCustomer.mockResolvedValueOnce({
      error: {
        code: "23505",
        message: 'duplicate key value violates unique constraint "customers_vendor_id_mobile_key"',
      },
    });
    render(<Customers />);
    fireEvent.click(await screen.findByTestId("customer-c1"));
    fireEvent.change(screen.getByTestId("customer-field-mobile"), { target: { value: "+919000000002" } });
    fireEvent.click(screen.getByTestId("customer-save"));
    expect(await screen.findByTestId("customer-duplicate")).toBeTruthy();
  });

  it("offers no delete", async () => {
    // A customer carries bills and an append-only ledger; a delete cascades the ledger
    // and orphans bills.customer_id.
    render(<Customers />);
    fireEvent.click(await screen.findByTestId("customer-c1"));
    expect(screen.queryByRole("button", { name: /delete|remove|काढून|हटाएं/i })).toBeNull();
  });

  it("says nothing yet on an empty list", async () => {
    listCustomers.mockResolvedValueOnce({ data: [], error: null });
    render(<Customers />);
    expect(await screen.findByText(/no customers yet|अजून ग्राहक नाहीत|कोई ग्राहक नहीं/i)).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd web && npx vitest run src/__tests__/Customers.test.tsx`
Expected: FAIL — cannot resolve `../screens/Customers`.

- [ ] **Step 3: Write the screen**

Create `web/src/screens/Customers.tsx`:

```tsx
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { listCustomers } from "../data";
import { updateCustomer, customerPoints } from "../admin";
import { matchCustomers, validateCustomer, isDuplicateMobile, type Customer } from "../customers";
import { describeError } from "../errors";

type Draft = { name: string; flat_no: string; mobile: string };

const FIELDS = [
  ["name", "bill.name"],
  ["flat_no", "bill.flatNo"],
  ["mobile", "bill.mobile"],
] as const;

export default function Customers() {
  const { t } = useTranslation();
  const [all, setAll] = useState<Customer[]>([]);
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState<Customer | null>(null);
  const [draft, setDraft] = useState<Draft>({ name: "", flat_no: "", mobile: "" });
  const [points, setPoints] = useState<number | null>(null);
  const [pointsFailed, setPointsFailed] = useState(false);
  const [incomplete, setIncomplete] = useState(false);
  const [duplicate, setDuplicate] = useState(false);
  const [problem, setProblem] = useState<{ key: string; detail: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const { data, error } = await listCustomers();
    setProblem(describeError(error));
    setAll(data ?? []);
  }, []);

  useEffect(() => { void load(); }, [load]);

  async function openCustomer(c: Customer) {
    setOpen(c);
    setDraft({ name: c.name, flat_no: c.flat_no, mobile: c.mobile });
    setIncomplete(false); setDuplicate(false); setProblem(null);
    setPoints(null); setPointsFailed(false);
    const { data, error } = await customerPoints(c.id);
    // Zero is a real balance -- a bill under the first threshold earns nothing. A failed
    // lookup is not, and rendering them alike would hide the failure.
    if (error) setPointsFailed(true);
    else setPoints(typeof data === "number" ? data : 0);
  }

  async function save() {
    if (!open) return;
    const check = validateCustomer(draft);
    if (!check.ok) { setIncomplete(true); return; }
    setIncomplete(false); setDuplicate(false);
    setBusy(true);
    const { error } = await updateCustomer(open.id, draft);
    setBusy(false);
    if (isDuplicateMobile(error)) { setDuplicate(true); return; }
    const described = describeError(error);
    setProblem(described);
    if (described) return;
    setOpen(null);
    await load();
  }

  const shown = matchCustomers(all, query);

  return (
    <div className="space-y-4">
      <h2 className="font-semibold text-slate-800">{t("customersScreen.title")}</h2>

      <div>
        <label className="block text-sm text-slate-600 mb-1" htmlFor="customer-search">
          {t("customersScreen.search")}
        </label>
        <input
          id="customer-search" data-testid="customer-search"
          value={query} onChange={(e) => setQuery(e.target.value)}
          className="w-full border border-slate-300 rounded-lg px-3 py-2 min-h-[44px]"
        />
      </div>

      {problem && (
        <p className="text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg p-3">
          {t(problem.key)}
        </p>
      )}

      {open && (
        <form
          onSubmit={(e) => { e.preventDefault(); void save(); }}
          className="bg-white border border-slate-200 rounded-xl p-4 space-y-3"
        >
          <h3 className="font-semibold text-slate-800">{t("customersScreen.edit")}</h3>
          <p className="text-sm text-slate-500">
            {pointsFailed
              ? t("customersScreen.pointsUnknown")
              : points === null ? "…" : t("customersScreen.points", { n: points })}
          </p>

          {FIELDS.map(([field, labelKey]) => (
            <div key={field}>
              <label className="block text-sm text-slate-600 mb-1" htmlFor={`customer-${field}`}>
                {t(labelKey)}
              </label>
              <input
                id={`customer-${field}`} data-testid={`customer-field-${field}`}
                value={draft[field]}
                inputMode={field === "mobile" ? "tel" : undefined}
                onChange={(e) => setDraft({ ...draft, [field]: e.target.value })}
                className="w-full border border-slate-300 rounded-lg px-3 py-2 min-h-[44px]"
              />
            </div>
          ))}

          {incomplete && <p className="text-sm text-red-700">{t("bill.required")}</p>}
          {duplicate && (
            <p data-testid="customer-duplicate" className="text-sm text-red-700">
              {t("customersScreen.duplicate")}
            </p>
          )}

          <div className="flex gap-2">
            <button
              type="submit" data-testid="customer-save" disabled={busy}
              className="rounded-lg px-4 py-2 text-sm bg-slate-800 text-white min-h-[44px] disabled:opacity-50"
            >
              {t("customersScreen.save")}
            </button>
            <button
              type="button" onClick={() => setOpen(null)}
              className="border border-slate-300 rounded-lg px-4 py-2 text-sm bg-white min-h-[44px]"
            >
              {t("customersScreen.cancel")}
            </button>
          </div>
        </form>
      )}

      {shown.length === 0 ? (
        <p className="text-sm text-slate-500">{t("customersScreen.empty")}</p>
      ) : (
        <ul className="space-y-2">
          {shown.map((c) => (
            <li key={c.id}>
              <button
                data-testid={`customer-${c.id}`} onClick={() => void openCustomer(c)}
                className="w-full text-left bg-white border border-slate-200 rounded-xl p-3 min-h-[44px]"
              >
                <span className="font-medium text-slate-800">{c.name}</span>
                <span className="block text-sm text-slate-500">{c.flat_no} · {c.mobile}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd web && npx vitest run src/__tests__/Customers.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add web/src/screens/Customers.tsx web/src/__tests__/Customers.test.tsx
git commit -m "feat: add the customers admin screen"
```

---

### Task 6: Staff screen

**Files:**
- Create: `web/src/screens/Staff.tsx`
- Test: `web/src/__tests__/Staff.test.tsx`

**Interfaces:**
- Consumes: `listStaff`, `updateStaff`, `removeStaff`, `StaffRow` from `../admin`; `canEditStaff` from `../adminRules`; `ROLES`, `Role` from `../config`; `useSession`; `describeError`.
- Produces: `export default function Staff()`.

- [ ] **Step 1: Write the failing test**

Create `web/src/__tests__/Staff.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import type { StaffRow } from "../admin";

const rows: StaffRow[] = [
  { id: "u1", name: "Admin One", role: "admin" },
  { id: "u2", name: "Rina", role: "recorder" },
];

const listStaff = vi.fn(async (): Promise<{ data: StaffRow[] | null; error: null }> =>
  ({ data: rows, error: null }));
const updateStaff = vi.fn(async (..._a: unknown[]) => ({ error: null }));
const removeStaff = vi.fn(async (..._a: unknown[]) => ({ error: null }));

vi.mock("../admin", () => ({
  listStaff: (...a: unknown[]) => listStaff(...a),
  updateStaff: (...a: unknown[]) => updateStaff(...a),
  removeStaff: (...a: unknown[]) => removeStaff(...a),
}));

vi.mock("../components/SessionProvider", () => ({
  useSession: () => ({
    kind: "ready", userId: "u1", vendorId: "v1", vendorName: "Shop", name: "Admin One", role: "admin",
  }),
}));

const { default: Staff } = await import("../screens/Staff");

beforeEach(() => vi.clearAllMocks());

describe("the staff screen", () => {
  it("lists the roster", async () => {
    render(<Staff />);
    expect(await screen.findByText(/Rina/)).toBeTruthy();
    expect(screen.getByText(/Admin One/)).toBeTruthy();
  });

  it("says plainly that nobody can be invited here yet", async () => {
    // §6: creating auth accounts is slice 2's Edge Function. A screen that appeared to
    // invite and silently could not would be worse than one that admits the seam.
    render(<Staff />);
    expect(await screen.findByText(/runbook-first-admin/i)).toBeTruthy();
  });

  it("changes someone else's role", async () => {
    render(<Staff />);
    fireEvent.click(await screen.findByTestId("staff-edit-u2"));
    fireEvent.change(screen.getByTestId("staff-role"), { target: { value: "biller" } });
    fireEvent.click(screen.getByTestId("staff-save"));
    await waitFor(() => expect(updateStaff)
      .toHaveBeenCalledWith("u2", expect.objectContaining({ role: "biller" })));
  });

  it("gives the signed-in admin no way to change their own row", async () => {
    // The single action that locks a vendor out of its own tenant.
    render(<Staff />);
    await screen.findByText(/Admin One/);
    expect(screen.queryByTestId("staff-edit-u1")).toBeNull();
    expect(screen.queryByTestId("staff-remove-u1")).toBeNull();
  });

  it("explains why the admin's own row is locked", async () => {
    render(<Staff />);
    expect(await screen.findByTestId("staff-self-locked")).toBeTruthy();
  });

  it("confirms before removing someone", async () => {
    render(<Staff />);
    fireEvent.click(await screen.findByTestId("staff-remove-u2"));
    expect(removeStaff).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId("staff-remove-confirm"));
    await waitFor(() => expect(removeStaff).toHaveBeenCalledWith("u2"));
  });

  it("gives the confirm dialog an accessible name", async () => {
    // Commit 1dc5cc4 fixed exactly this on the two existing dialogs; a third must not
    // reintroduce it.
    render(<Staff />);
    fireEvent.click(await screen.findByTestId("staff-remove-u2"));
    const dialog = screen.getByRole("dialog");
    expect(dialog.getAttribute("aria-label")).toBeTruthy();
  });

  it("does not claim the sign-in account is deleted", async () => {
    // removeStaff unlinks the person from the vendor; the SPA holds only the anon key
    // and cannot touch auth.users.
    render(<Staff />);
    fireEvent.click(await screen.findByTestId("staff-remove-u2"));
    expect(screen.getByTestId("staff-remove-body").textContent ?? "").toMatch(
      /not deleted|मिटत नाही|नहीं मिटता/i,
    );
  });

  it("reloads after a removal", async () => {
    render(<Staff />);
    await screen.findByTestId("staff-remove-u2");
    expect(listStaff).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByTestId("staff-remove-u2"));
    fireEvent.click(screen.getByTestId("staff-remove-confirm"));
    await waitFor(() => expect(listStaff).toHaveBeenCalledTimes(2));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd web && npx vitest run src/__tests__/Staff.test.tsx`
Expected: FAIL — cannot resolve `../screens/Staff`.

- [ ] **Step 3: Write the screen**

Create `web/src/screens/Staff.tsx`. The confirm dialog follows `Pending.tsx`'s, including the `aria-label` that commit 1dc5cc4 added to both existing dialogs.

```tsx
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { listStaff, updateStaff, removeStaff, type StaffRow } from "../admin";
import { canEditStaff } from "../adminRules";
import { ROLES, type Role } from "../config";
import { useSession } from "../components/SessionProvider";
import { describeError } from "../errors";

const ROLE_KEY: Record<Role, string> = {
  admin: "staff.roleAdmin",
  recorder: "staff.roleRecorder",
  biller: "staff.roleBiller",
};

export default function Staff() {
  const { t } = useTranslation();
  const session = useSession();
  const [rows, setRows] = useState<StaffRow[]>([]);
  const [editing, setEditing] = useState<{ id: string; name: string; role: Role } | null>(null);
  const [confirming, setConfirming] = useState<StaffRow | null>(null);
  const [problem, setProblem] = useState<{ key: string; detail: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const { data, error } = await listStaff();
    setProblem(describeError(error));
    setRows(data ?? []);
  }, []);

  useEffect(() => { void load(); }, [load]);

  if (session.kind !== "ready") return null;
  const selfId = session.userId;

  async function save() {
    if (!editing) return;
    setBusy(true);
    const { error } = await updateStaff(editing.id, { name: editing.name, role: editing.role });
    setBusy(false);
    const described = describeError(error);
    setProblem(described);
    if (described) return;
    setEditing(null);
    await load();
  }

  async function remove(row: StaffRow) {
    setBusy(true);
    const { error } = await removeStaff(row.id);
    setBusy(false);
    setConfirming(null);
    setProblem(describeError(error));
    await load();
  }

  return (
    <div className="space-y-4">
      <h2 className="font-semibold text-slate-800">{t("staff.title")}</h2>

      <p className="text-sm text-slate-600 bg-slate-50 border border-slate-200 rounded-lg p-3">
        {t("staff.cannotInvite")}
      </p>

      {problem && (
        <p className="text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg p-3">
          {t(problem.key)}
        </p>
      )}

      {editing && (
        <form
          onSubmit={(e) => { e.preventDefault(); void save(); }}
          className="bg-white border border-slate-200 rounded-xl p-4 space-y-3"
        >
          <div>
            <label className="block text-sm text-slate-600 mb-1" htmlFor="staff-name">
              {t("staff.name")}
            </label>
            <input
              id="staff-name" data-testid="staff-name" value={editing.name}
              onChange={(e) => setEditing({ ...editing, name: e.target.value })}
              className="w-full border border-slate-300 rounded-lg px-3 py-2 min-h-[44px]"
            />
          </div>
          <div>
            <label className="block text-sm text-slate-600 mb-1" htmlFor="staff-role">
              {t("staff.role")}
            </label>
            <select
              id="staff-role" data-testid="staff-role" value={editing.role}
              onChange={(e) => setEditing({ ...editing, role: e.target.value as Role })}
              className="w-full border border-slate-300 rounded-lg px-3 py-2 min-h-[44px] bg-white"
            >
              {ROLES.map((r) => <option key={r} value={r}>{t(ROLE_KEY[r])}</option>)}
            </select>
          </div>
          <div className="flex gap-2">
            <button
              type="submit" data-testid="staff-save" disabled={busy}
              className="rounded-lg px-4 py-2 text-sm bg-slate-800 text-white min-h-[44px] disabled:opacity-50"
            >
              {t("staff.save")}
            </button>
            <button
              type="button" onClick={() => setEditing(null)}
              className="border border-slate-300 rounded-lg px-4 py-2 text-sm bg-white min-h-[44px]"
            >
              {t("staff.cancel")}
            </button>
          </div>
        </form>
      )}

      {rows.length === 0 ? (
        <p className="text-sm text-slate-500">{t("staff.empty")}</p>
      ) : (
        <ul className="space-y-2">
          {rows.map((row) => {
            const editable = canEditStaff(selfId, row.id);
            return (
              <li
                key={row.id}
                className="bg-white border border-slate-200 rounded-xl p-3 flex items-center gap-3"
              >
                <div className="flex-1 min-w-0">
                  <p className="font-medium text-slate-800 truncate">
                    {row.name}
                    {!editable && (
                      <span className="ml-2 text-xs text-slate-500">({t("staff.self")})</span>
                    )}
                  </p>
                  <p className="text-sm text-slate-500">{t(ROLE_KEY[row.role])}</p>
                </div>
                {editable && (
                  <>
                    <button
                      data-testid={`staff-edit-${row.id}`}
                      onClick={() => setEditing({ id: row.id, name: row.name, role: row.role })}
                      className="border border-slate-300 rounded-lg px-3 py-2 text-sm bg-white min-h-[44px]"
                    >
                      {t("staff.edit")}
                    </button>
                    <button
                      data-testid={`staff-remove-${row.id}`}
                      onClick={() => setConfirming(row)}
                      className="border border-red-300 text-red-700 rounded-lg px-3 py-2 text-sm bg-white min-h-[44px]"
                    >
                      {t("staff.remove")}
                    </button>
                  </>
                )}
              </li>
            );
          })}
        </ul>
      )}

      <p data-testid="staff-self-locked" className="text-xs text-slate-500">
        {t("staff.selfLocked")}
      </p>

      {confirming && (
        <div
          role="dialog" aria-label={t("staff.confirmRemoveTitle")}
          className="fixed inset-0 bg-black/40 flex items-center justify-center p-4"
        >
          <div className="bg-white rounded-xl p-5 max-w-sm w-full space-y-3">
            <h3 className="font-semibold text-slate-800">{t("staff.confirmRemoveTitle")}</h3>
            <p data-testid="staff-remove-body" className="text-sm text-slate-600">
              {t("staff.confirmRemoveBody")}
            </p>
            <div className="flex gap-2">
              <button
                data-testid="staff-remove-confirm"
                onClick={() => void remove(confirming)} disabled={busy}
                className="rounded-lg px-4 py-2 text-sm bg-red-700 text-white min-h-[44px] disabled:opacity-50"
              >
                {t("staff.confirmRemoveAccept")}
              </button>
              <button
                onClick={() => setConfirming(null)}
                className="border border-slate-300 rounded-lg px-4 py-2 text-sm bg-white min-h-[44px]"
              >
                {t("staff.cancel")}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd web && npx vitest run src/__tests__/Staff.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add web/src/screens/Staff.tsx web/src/__tests__/Staff.test.tsx
git commit -m "feat: add the staff roster screen"
```

---

### Task 7: Loyalty settings screen

**Files:**
- Create: `web/src/screens/Settings.tsx`
- Test: `web/src/__tests__/Settings.test.tsx`

**Interfaces:**
- Consumes: `loadVendorConfig`, `updateVendorConfig`, `VendorConfig` from `../admin`; `validateSettings`, `SettingsInput`, `SettingsField` from `../adminRules`; `useSession`; `describeError`.
- Produces: `export default function Settings()`.

- [ ] **Step 1: Write the failing test**

Create `web/src/__tests__/Settings.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import type { VendorConfig } from "../admin";

const config: VendorConfig = {
  points_threshold_1: 600, points_reward_1: 50,
  points_threshold_2: 1000, points_reward_2: 100, redeem_days: 30,
};

const loadVendorConfig = vi.fn(async (..._a: unknown[]): Promise<{
  data: VendorConfig | null; error: null;
}> => ({ data: config, error: null }));
const updateVendorConfig = vi.fn(async (..._a: unknown[]): Promise<{
  error: { code?: string; message?: string } | null;
}> => ({ error: null }));

vi.mock("../admin", () => ({
  loadVendorConfig: (...a: unknown[]) => loadVendorConfig(...a),
  updateVendorConfig: (...a: unknown[]) => updateVendorConfig(...a),
}));

vi.mock("../components/SessionProvider", () => ({
  useSession: () => ({
    kind: "ready", userId: "u1", vendorId: "v1", vendorName: "Shop", name: "Admin", role: "admin",
  }),
}));

const { default: Settings } = await import("../screens/Settings");

beforeEach(() => vi.clearAllMocks());

describe("the loyalty settings screen", () => {
  it("loads the vendor's current rules", async () => {
    render(<Settings />);
    await waitFor(() => expect(loadVendorConfig).toHaveBeenCalledWith("v1"));
    const field = await screen.findByTestId("settings-points_threshold_1");
    expect((field as HTMLInputElement).value).toBe("600");
  });

  it("warns that past points are never recalculated", async () => {
    // points_ledger is append-only. A vendor who raises a reward and expects yesterday's
    // customers to benefit is going to be wrong, and the screen is where to say so.
    render(<Settings />);
    expect(await screen.findByTestId("settings-future-only")).toBeTruthy();
  });

  it("saves valid numbers as numbers", async () => {
    render(<Settings />);
    fireEvent.change(await screen.findByTestId("settings-points_threshold_1"), {
      target: { value: "700" },
    });
    fireEvent.click(screen.getByTestId("settings-save"));
    await waitFor(() => expect(updateVendorConfig).toHaveBeenCalledWith("v1",
      expect.objectContaining({ points_threshold_1: 700, points_reward_1: 50 })));
  });

  it("refuses an inverted pair of targets", async () => {
    render(<Settings />);
    fireEvent.change(await screen.findByTestId("settings-points_threshold_2"), {
      target: { value: "500" },
    });
    fireEvent.click(screen.getByTestId("settings-save"));
    await waitFor(() => expect(updateVendorConfig).not.toHaveBeenCalled());
    expect(screen.getByTestId("settings-error-points_threshold_2")).toBeTruthy();
  });

  it("refuses a fractional reward", async () => {
    // points_reward_1 is an integer column; Postgres would truncate 2.5 silently.
    render(<Settings />);
    fireEvent.change(await screen.findByTestId("settings-points_reward_1"), {
      target: { value: "2.5" },
    });
    fireEvent.click(screen.getByTestId("settings-save"));
    await waitFor(() => expect(updateVendorConfig).not.toHaveBeenCalled());
  });

  it("confirms a successful save", async () => {
    render(<Settings />);
    await screen.findByTestId("settings-points_threshold_1");
    fireEvent.click(screen.getByTestId("settings-save"));
    expect(await screen.findByTestId("settings-saved")).toBeTruthy();
  });

  it("shows the policy refusal when the write is blocked", async () => {
    // A non-admin reaching this screen gets 42501 from vendors_admin_update. The route
    // guard is politeness; this is the actual enforcement surfacing.
    updateVendorConfig.mockResolvedValueOnce({
      error: { code: "42501", message: "row-level security" },
    });
    render(<Settings />);
    await screen.findByTestId("settings-points_threshold_1");
    fireEvent.click(screen.getByTestId("settings-save"));
    expect(await screen.findByTestId("settings-problem")).toBeTruthy();
    expect(screen.queryByTestId("settings-saved")).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd web && npx vitest run src/__tests__/Settings.test.tsx`
Expected: FAIL — cannot resolve `../screens/Settings`.

- [ ] **Step 3: Write the screen**

Create `web/src/screens/Settings.tsx`:

```tsx
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { loadVendorConfig, updateVendorConfig } from "../admin";
import { validateSettings, type SettingsInput, type SettingsField } from "../adminRules";
import { useSession } from "../components/SessionProvider";
import { describeError } from "../errors";

const FIELDS = [
  ["points_threshold_1", "settings.threshold1"],
  ["points_reward_1", "settings.reward1"],
  ["points_threshold_2", "settings.threshold2"],
  ["points_reward_2", "settings.reward2"],
  ["redeem_days", "settings.redeemDays"],
] as const;

const BLANK: SettingsInput = {
  points_threshold_1: "", points_reward_1: "",
  points_threshold_2: "", points_reward_2: "", redeem_days: "",
};

export default function Settings() {
  const { t } = useTranslation();
  const session = useSession();
  const [input, setInput] = useState<SettingsInput>(BLANK);
  const [errors, setErrors] = useState<Partial<Record<SettingsField, string>>>({});
  const [problem, setProblem] = useState<{ key: string; detail: string } | null>(null);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);

  const vendorId = session.kind === "ready" ? session.vendorId : null;

  useEffect(() => {
    if (!vendorId) return;
    void (async () => {
      const { data, error } = await loadVendorConfig(vendorId);
      setProblem(describeError(error));
      if (data) {
        setInput({
          points_threshold_1: String(data.points_threshold_1),
          points_reward_1: String(data.points_reward_1),
          points_threshold_2: String(data.points_threshold_2),
          points_reward_2: String(data.points_reward_2),
          redeem_days: String(data.redeem_days),
        });
      }
    })();
  }, [vendorId]);

  if (!vendorId) return null;

  async function save() {
    setSaved(false);
    const result = validateSettings(input);
    if (!result.ok) { setErrors(result.errors); return; }
    setErrors({});
    setBusy(true);
    const { error } = await updateVendorConfig(vendorId!, result.value);
    setBusy(false);
    const described = describeError(error);
    setProblem(described);
    if (!described) setSaved(true);
  }

  return (
    <form
      onSubmit={(e) => { e.preventDefault(); void save(); }}
      className="bg-white border border-slate-200 rounded-xl p-4 space-y-3 max-w-md"
    >
      <h2 className="font-semibold text-slate-800">{t("settings.title")}</h2>
      <p data-testid="settings-future-only" className="text-sm text-slate-600">
        {t("settings.futureOnly")}
      </p>

      {FIELDS.map(([field, labelKey]) => (
        <div key={field}>
          <label className="block text-sm text-slate-600 mb-1" htmlFor={`settings-${field}`}>
            {t(labelKey)}
          </label>
          <input
            id={`settings-${field}`} data-testid={`settings-${field}`}
            value={input[field]} inputMode="decimal"
            onChange={(e) => setInput({ ...input, [field]: e.target.value })}
            className="w-full border border-slate-300 rounded-lg px-3 py-2 min-h-[44px]"
          />
          {errors[field] && (
            <p data-testid={`settings-error-${field}`} className="text-xs text-red-700 mt-1">
              {t(errors[field]!)}
            </p>
          )}
        </div>
      ))}

      {problem && (
        <p data-testid="settings-problem" className="text-sm text-red-700">{t(problem.key)}</p>
      )}
      {saved && (
        <p data-testid="settings-saved" className="text-sm text-green-700">{t("settings.saved")}</p>
      )}

      <button
        type="submit" data-testid="settings-save" disabled={busy}
        className="rounded-lg px-4 py-2 text-sm bg-slate-800 text-white min-h-[44px] disabled:opacity-50"
      >
        {t("settings.save")}
      </button>
    </form>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd web && npx vitest run src/__tests__/Settings.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add web/src/screens/Settings.tsx web/src/__tests__/Settings.test.tsx
git commit -m "feat: add the loyalty settings screen"
```

---

### Task 8: Wire the screens into the app and tell the truth in the README

**Files:**
- Modify: `web/src/App.tsx` (imports near line 7; routes near lines 56-61)
- Modify: `README.md`
- Test: `web/src/__tests__/App.test.tsx`

**Interfaces:**
- Consumes: the four default exports from Tasks 4–7.
- Produces: nothing further.

- [ ] **Step 1: Write the failing test**

Read `web/src/__tests__/App.test.tsx` first and keep its existing mocks intact. Add:

```tsx
  it("no longer serves a placeholder to an admin", async () => {
    // The three admin routes stopped being stubs in stage 3. This test exists so the
    // "coming soon" copy cannot quietly outlive the screens, as the README's did
    // until c1d2f1e. /dashboards is still a placeholder and is reached only by
    // navigating to it, so the default landing route must show none.
    render(<App />);
    expect(screen.queryByText(/coming soon|लवकरच|जल्द/i)).toBeNull();
  });
```

If `App.test.tsx` renders with a stubbed session, extend that stub to an `admin` role so the assertion exercises the admin routes; if it stubs the screen modules, add `../screens/Items`, `Customers`, `Staff` and `Settings` to that stub list in the same shape as the existing entries.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd web && npx vitest run src/__tests__/App.test.tsx`
Expected: FAIL — a placeholder still renders. (If it passes because the default landing route is `/bill`, keep the test: it still pins the invariant, and Step 3 must not break it.)

- [ ] **Step 3: Wire the routes**

In `web/src/App.tsx`, add beside the existing `Bill` and `Pending` imports:

```tsx
import Items from "./screens/Items";
import Customers from "./screens/Customers";
import Staff from "./screens/Staff";
import Settings from "./screens/Settings";
```

Replace the three placeholder routes and add the new one. `/dashboards` stays a `Placeholder` — that is stage 4 — so keep the `Placeholder` import:

```tsx
          <Route path="/items" element={<Items />} />
          <Route path="/customers" element={<Customers />} />
          <Route path="/staff" element={<Staff />} />
          <Route path="/settings" element={<Settings />} />
          <Route path="/dashboards" element={<Placeholder titleKey="nav.dashboards" />} />
```

- [ ] **Step 4: Run the whole suite and the type check**

Run: `cd web && npm test`
Expected: PASS, every file.
Run: `cd web && npm run build`
Expected: clean `tsc --noEmit`, then a successful bundle.

- [ ] **Step 5: Update the README**

In the section recording what the stages ship, state what is now true and what still is not. Extend the existing notes rather than starting parallel ones:

- Stage 3 ships items and stock, customers, staff and loyalty settings. `/dashboards` is the only screen still a placeholder; the console at `/console.html` still serves those.
- **Staff cannot be invited from the SPA.** A person signs up, then an admin links their `app_users` row by hand — `docs/runbook-first-admin.md`. This is slice 2's Edge Function, unbuilt.
- **Stock is set absolutely** and can overwrite a concurrent `complete_bill()` decrement. Accepted deliberately; the fix, if the race is ever observed, is a delta RPC.
- **Removing someone from Staff unlinks them from the vendor**; it does not delete their sign-in account. They land on the "not linked to a shop" screen.
- The stage-3 `hi` and `mr` strings are AI-written and unreviewed, like the rest — extend the existing note, do not start a second one.
- The E2E gap is unchanged, and stage 3 widens what it leaves uncovered: `vendors`, `items` and `app_users` are now written from the client, and `vendors_admin_update`, `items_admin_write` and `users_admin_write` have never been exercised through PostgREST.

- [ ] **Step 6: Commit**

```bash
git add web/src/App.tsx web/src/__tests__/App.test.tsx README.md
git commit -m "feat: serve the four admin screens, and record what stage 3 still cannot do"
```

---

## Self-Review

**Spec coverage.** §11b "Where the code lives" → Tasks 1 and 3. "Items and stock" → Tasks 2 and 4. "Customers" → Task 5. "Staff" → Tasks 2 and 6. "Settings" → Tasks 2 and 7. "Not built in stage 3" → held by omission and asserted where a test can assert it (no delete button, Task 5; `setItemActive` rather than a delete, Task 3). "Testing" → every task, with the pure rules mock-free in Task 2 and the screens stubbing only `admin.ts` (and `data.ts` for `listCustomers`).

**Type consistency.** `ItemValue` is produced by `validateItem` (Task 2) and consumed by `createItem`/`updateItem` (Task 3). `VendorConfig` is `Record<SettingsField, number>`, exactly what `validateSettings` returns and what `loadVendorConfig` is typed to yield. `StaffRow.role` is `Role` from `config.ts` — the same type `updateStaff` accepts and `ROLES` enumerates. `AdminItem` is structurally compatible with `itemName()`'s parameter, which needs only the three name columns.

**Two things the implementer should not "fix" quietly.** The suite runs in Marathi by default (`resolveLang(null, [])` returns `mr`), which is why button queries use `data-testid` and copy assertions use three-language alternations — do not change the default language to simplify a test. And where a query is ambiguous, tighten the query rather than loosening the component.
