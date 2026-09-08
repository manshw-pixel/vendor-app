# Slice 3, Stage 1 — SPA shell: auth, role routing, i18n

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up the Vite + React + TypeScript SPA in `web/`, signed in against the real
Supabase project, routing by role, with the mr/hi/en language switch working — and publish
it at `/`, keeping the existing console at `/console.html`.

**Architecture:** A single-page app with no server of ours. `supabase-js` carries the
signed-in user's JWT straight to PostgREST; RLS is the only authorization layer. Role and
tenant come from one `app_users` row loaded once after sign-in. Route guards are UX, never
security. All decision logic lives in pure functions so it can be tested without mocking
`supabase-js` — mocking the client would test the mock, not the policies.

**Tech Stack:** Vite 8, React 19, TypeScript 7, Tailwind 4, React Router 7, i18next 26 +
react-i18next 17, `@supabase/supabase-js` 2, Vitest 5 + Testing Library, Node 24.

**Spec:** `docs/superpowers/specs/2026-09-08-slice-3-spa-design.md`

## Global Constraints

- **React 19, not 18.** The design doc says React 18; 19 is the current stable release and
  18 would be deliberately old. Deviation recorded here on purpose.
- **The `service_role` key must never appear in `web/`, in any form, ever.** It bypasses
  RLS entirely. Only the anon key belongs in a browser.
- **The anon key and project URL are public and committed** in `web/src/config.ts`. They
  grant the `anon` role and nothing more; RLS decides what a signed-in user may see. This
  is the same posture as `console.html`, which is deployed and verified.
- **Project URL:** `https://cnnqidkmcxkgwxnulvig.supabase.co`
- **Anon key:** `eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImNubnFpZGttY3hrZ3d4bnVsdmlnIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODg4MzgxOTUsImV4cCI6MjEwNDQxNDE5NX0.tSZv1HuVpDFzdcXiio_EIZPt-8cY6m8qJCPmc5oclOo`
- **Roles are exactly** `'admin' | 'recorder' | 'biller'` — the `app_users.role` check
  constraint in `0001_schema.sql` permits no others.
- **Default language is Marathi (`mr`)**, persisted in `localStorage` under `vendor-app.lang`.
- **Mobile-first.** Minimum touch target 44px. Numeric inputs use `inputMode="decimal"`.
- **Do not touch** `supabase/migrations/`, `tests/`, or `console.html`. Stage 1 adds `web/`
  and edits the Pages workflow, nothing else.
- **Never pipe `npm test`** — its exit code is the gate.

---

## File structure

```
web/
  package.json            own dependency tree; the root package.json stays the DB harness
  vite.config.ts          React + Tailwind plugins, Vitest config (jsdom)
  tsconfig.json
  index.html              Vite entry
  src/
    config.ts             project URL + anon key + the roles union
    supabase.ts           the single supabase-js client instance
    session.ts            PURE: app_users row -> session state (tested)
    routes.ts             PURE: role -> permitted routes (tested)
    errors.ts             PURE: Postgres/PostgREST error -> plain language (tested)
    i18n/
      index.ts            i18next setup, localStorage persistence
      locales.ts          PURE: language resolution + item-name fallback (tested)
      en.json  hi.json  mr.json
    components/
      SessionProvider.tsx React context; the only place app_users is read
      Login.tsx
      Shell.tsx           header, language switch, sign out, nav
      Guard.tsx           route guard (UX only)
    screens/
      Placeholder.tsx     named stubs for stage 2-4 screens
    main.tsx
    App.tsx
  src/__tests__/          Vitest specs, colocated by module name
```

Pure logic (`session.ts`, `routes.ts`, `errors.ts`, `locales.ts`) is deliberately separated
from React so every meaningful decision has a test that needs no browser, no network and no
mock.

---

## Task 1: Scaffold `web/` with a passing test

**Files:**
- Create: `web/package.json`, `web/vite.config.ts`, `web/tsconfig.json`, `web/index.html`,
  `web/src/main.tsx`, `web/src/App.tsx`, `web/src/index.css`, `web/.gitignore`
- Create: `web/src/__tests__/smoke.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `npm --prefix web run build`, `npm --prefix web test`, `npm --prefix web run dev`.

- [ ] **Step 1: Create `web/package.json`**

```json
{
  "name": "vendor-app-web",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "tsc --noEmit && vite build",
    "preview": "vite preview",
    "test": "vitest run"
  },
  "dependencies": {
    "@supabase/supabase-js": "2.116.0",
    "i18next": "26.4.2",
    "react": "19.2.8",
    "react-dom": "19.2.8",
    "react-i18next": "17.0.13",
    "react-router-dom": "7.18.3"
  },
  "devDependencies": {
    "@tailwindcss/vite": "4.3.3",
    "@testing-library/react": "16.3.3",
    "@types/react": "19.2.8",
    "@types/react-dom": "19.2.8",
    "@vitejs/plugin-react": "6.1.1",
    "jsdom": "30.0.1",
    "tailwindcss": "4.3.3",
    "typescript": "7.0.2",
    "vite": "8.2.2",
    "vitest": "5.0.0"
  }
}
```

Exact versions, not ranges: a plan that installs a different tree next week is not a plan.

- [ ] **Step 2: Create `web/vite.config.ts`**

```ts
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  // Published under https://manshw-pixel.github.io/vendor-app/ , so assets must be
  // referenced relatively -- an absolute /assets/... would 404 on Pages.
  base: "./",
  test: {
    environment: "jsdom",
    globals: true,
  },
});
```

- [ ] **Step 3: Create `web/tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "module": "ESNext",
    "moduleResolution": "bundler",
    "jsx": "react-jsx",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "noEmit": true,
    "skipLibCheck": true,
    "types": ["vitest/globals"],
    "resolveJsonModule": true,
    "esModuleInterop": true,
    "isolatedModules": true
  },
  "include": ["src"]
}
```

`strict` and `noUncheckedIndexedAccess` are on deliberately: this code indexes into
translation maps and query results, which is exactly where a silent `undefined` hides.

- [ ] **Step 4: Create `web/index.html`**

```html
<!doctype html>
<html lang="mr">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
    <title>Vendor App</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

- [ ] **Step 5: Create `web/src/index.css`**

```css
@import "tailwindcss";

/* Mobile-first defaults. Staff use this one-handed on a phone while weighing produce,
   so tap targets are large and the page never scrolls sideways. */
html { -webkit-text-size-adjust: 100%; }
body { margin: 0; background: #f6f8fb; color: #334155; overflow-x: hidden; }
button, [role="button"], a.btn { min-height: 44px; }
input, select { min-height: 44px; font-size: 16px; } /* 16px stops iOS zooming on focus */
```

- [ ] **Step 6: Create `web/src/App.tsx` and `web/src/main.tsx`**

`web/src/App.tsx`:

```tsx
export default function App() {
  return <div className="p-4">Vendor App</div>;
}
```

`web/src/main.tsx`:

```tsx
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./index.css";

const el = document.getElementById("root");
if (!el) throw new Error("no #root element");
createRoot(el).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
```

- [ ] **Step 7: Create `web/.gitignore`**

```
node_modules/
dist/
```

- [ ] **Step 8: Write the failing test**

`web/src/__tests__/smoke.test.ts`:

```ts
import { describe, it, expect } from "vitest";

describe("the web workspace", () => {
  it("runs tests at all", () => {
    expect(1 + 1).toBe(2);
  });
});
```

- [ ] **Step 9: Install and run**

```bash
npm --prefix web install
npm --prefix web test
```

Expected: 1 test passes.

- [ ] **Step 10: Verify the build works**

```bash
npm --prefix web run build
```

Expected: exits 0, writes `web/dist/index.html` and `web/dist/assets/`.

- [ ] **Step 11: Commit**

```bash
git add web/
git commit -m "feat(web): scaffold the Vite + React + TS SPA"
```

---

## Task 2: Config and the Supabase client

**Files:**
- Create: `web/src/config.ts`, `web/src/supabase.ts`
- Create: `web/src/__tests__/config.test.ts`

**Interfaces:**
- Consumes: Task 1's workspace.
- Produces: `SUPABASE_URL: string`, `SUPABASE_ANON_KEY: string`,
  `ROLES: readonly Role[]`, `type Role = "admin" | "recorder" | "biller"`,
  and `supabase` — the single `SupabaseClient` instance every module imports.

- [ ] **Step 1: Write the failing test**

`web/src/__tests__/config.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { SUPABASE_URL, SUPABASE_ANON_KEY, ROLES } from "../config";

describe("config", () => {
  it("points at the production project", () => {
    expect(SUPABASE_URL).toBe("https://cnnqidkmcxkgwxnulvig.supabase.co");
  });

  it("carries an anon key, never a service_role key", () => {
    // The payload of a Supabase JWT is base64 in the middle segment. A service_role key
    // in a browser bundle would hand every visitor the entire database, bypassing RLS --
    // so this asserts the role claim rather than trusting review to catch it.
    const parts = SUPABASE_ANON_KEY.split(".");
    expect(parts.length).toBe(3);
    const payload = JSON.parse(atob(parts[1]!));
    expect(payload.role).toBe("anon");
  });

  it("lists exactly the roles the database permits", () => {
    expect([...ROLES]).toEqual(["admin", "recorder", "biller"]);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npm --prefix web test`
Expected: FAIL — cannot resolve `../config`.

- [ ] **Step 3: Create `web/src/config.ts`**

```ts
/**
 * Public configuration. Both values below are meant to be in the bundle.
 *
 * The anon key grants the `anon` Postgres role and nothing more; what any signed-in
 * user may read or write is decided by the RLS policies in
 * supabase/migrations/0002_rls.sql, per vendor and per role.
 *
 * The service_role key must NEVER appear here or anywhere else under web/. It carries
 * bypassrls, so a copy in a browser bundle is a full database compromise.
 */
export const SUPABASE_URL = "https://cnnqidkmcxkgwxnulvig.supabase.co";
export const SUPABASE_ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImNubnFpZGttY3hrZ3d4bnVsdmlnIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODg4MzgxOTUsImV4cCI6MjEwNDQxNDE5NX0.tSZv1HuVpDFzdcXiio_EIZPt-8cY6m8qJCPmc5oclOo";

/** Exactly the values app_users.role permits (0001_schema.sql check constraint). */
export const ROLES = ["admin", "recorder", "biller"] as const;
export type Role = (typeof ROLES)[number];
```

- [ ] **Step 4: Run the test**

Run: `npm --prefix web test`
Expected: PASS (3 tests).

- [ ] **Step 5: Create `web/src/supabase.ts`**

```ts
import { createClient } from "@supabase/supabase-js";
import { SUPABASE_URL, SUPABASE_ANON_KEY } from "./config";

/**
 * One client for the whole app. Two clients would mean two session stores and a
 * signed-out tab that still holds a live token.
 */
export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: { persistSession: true, autoRefreshToken: true },
});
```

- [ ] **Step 6: Commit**

```bash
git add web/src/config.ts web/src/supabase.ts web/src/__tests__/config.test.ts
git commit -m "feat(web): public config and the shared supabase client"
```

---

## Task 3: Session state as a pure function

**Files:**
- Create: `web/src/session.ts`
- Create: `web/src/__tests__/session.test.ts`

**Interfaces:**
- Consumes: `Role` from `../config`.
- Produces:
  - `type AppUserRow = { name: string; role: Role; vendor_id: string; vendors: { name: string } | null }`
  - `type SessionState = { kind: "loading" } | { kind: "signedOut" } | { kind: "unmapped"; email: string } | { kind: "ready"; userId: string; vendorId: string; vendorName: string; name: string; role: Role }`
  - `sessionFromRow(userId: string, email: string, row: AppUserRow | null): SessionState`

- [ ] **Step 1: Write the failing test**

`web/src/__tests__/session.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { sessionFromRow } from "../session";

const row = {
  name: "Manish Wadhwani",
  role: "admin" as const,
  vendor_id: "7bf7f5c7-0a6a-4ab0-a2b9-f8341f42bcf3",
  vendors: { name: "My Kirana" },
};

describe("sessionFromRow", () => {
  it("builds a ready session from an app_users row", () => {
    const s = sessionFromRow("u1", "a@b.test", row);
    expect(s).toEqual({
      kind: "ready",
      userId: "u1",
      vendorId: "7bf7f5c7-0a6a-4ab0-a2b9-f8341f42bcf3",
      vendorName: "My Kirana",
      name: "Manish Wadhwani",
      role: "admin",
    });
  });

  it("reports an authenticated user with no app_users row as unmapped", () => {
    // This is the real state of every new staff member before an admin maps them.
    // Without naming it, every query returns empty and the app looks broken.
    const s = sessionFromRow("u1", "new@b.test", null);
    expect(s).toEqual({ kind: "unmapped", email: "new@b.test" });
  });

  it("falls back when the vendor embed is missing", () => {
    // vendors(name) is an embed; a policy change could make it come back null while
    // the app_users row is still readable. A blank header is better than a crash.
    const s = sessionFromRow("u1", "a@b.test", { ...row, vendors: null });
    expect(s.kind).toBe("ready");
    if (s.kind === "ready") expect(s.vendorName).toBe("");
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npm --prefix web test`
Expected: FAIL — cannot resolve `../session`.

- [ ] **Step 3: Create `web/src/session.ts`**

```ts
import type { Role } from "./config";

export type AppUserRow = {
  name: string;
  role: Role;
  vendor_id: string;
  vendors: { name: string } | null;
};

export type SessionState =
  | { kind: "loading" }
  | { kind: "signedOut" }
  | { kind: "unmapped"; email: string }
  | {
      kind: "ready";
      userId: string;
      vendorId: string;
      vendorName: string;
      name: string;
      role: Role;
    };

/**
 * app_users is the ONLY source of role and tenant: it is what current_vendor_id() and
 * current_user_role() resolve from in the database. Deciding role any other way in the
 * UI would risk disagreeing with the policies that actually enforce it.
 */
export function sessionFromRow(
  userId: string,
  email: string,
  row: AppUserRow | null,
): SessionState {
  if (!row) return { kind: "unmapped", email };
  return {
    kind: "ready",
    userId,
    vendorId: row.vendor_id,
    vendorName: row.vendors?.name ?? "",
    name: row.name,
    role: row.role,
  };
}
```

- [ ] **Step 4: Run the test**

Run: `npm --prefix web test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add web/src/session.ts web/src/__tests__/session.test.ts
git commit -m "feat(web): session state derived from the app_users row"
```

---

## Task 4: Role → routes, as a pure function

**Files:**
- Create: `web/src/routes.ts`
- Create: `web/src/__tests__/routes.test.ts`

**Interfaces:**
- Consumes: `Role` from `../config`.
- Produces:
  - `type RouteDef = { path: string; labelKey: string }`
  - `routesForRole(role: Role): RouteDef[]`
  - `canAccess(role: Role, path: string): boolean`
  - `homeFor(role: Role): string`

- [ ] **Step 1: Write the failing test**

`web/src/__tests__/routes.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { routesForRole, canAccess, homeFor } from "../routes";

describe("routesForRole", () => {
  it("gives the recorder billing and customers", () => {
    expect(routesForRole("recorder").map((r) => r.path)).toEqual(["/bill", "/customers"]);
  });

  it("gives the biller only the completion queue", () => {
    expect(routesForRole("biller").map((r) => r.path)).toEqual(["/pending"]);
  });

  it("gives admin the full set, including billing", () => {
    // The policies permit ('admin','recorder') to create bills and issue tokens, so the
    // UI follows the policy rather than narrowing it.
    expect(routesForRole("admin").map((r) => r.path)).toEqual([
      "/bill",
      "/pending",
      "/items",
      "/customers",
      "/staff",
      "/dashboards",
    ]);
  });
});

describe("canAccess", () => {
  it("permits a route the role owns", () => {
    expect(canAccess("biller", "/pending")).toBe(true);
  });

  it("refuses a route the role does not own", () => {
    expect(canAccess("biller", "/items")).toBe(false);
  });

  it("refuses an unknown path", () => {
    expect(canAccess("admin", "/nope")).toBe(false);
  });
});

describe("homeFor", () => {
  it("lands each role on its first route", () => {
    expect(homeFor("recorder")).toBe("/bill");
    expect(homeFor("biller")).toBe("/pending");
    expect(homeFor("admin")).toBe("/bill");
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npm --prefix web test`
Expected: FAIL — cannot resolve `../routes`.

- [ ] **Step 3: Create `web/src/routes.ts`**

```ts
import type { Role } from "./config";

export type RouteDef = { path: string; labelKey: string };

/**
 * These guards are UX, not security.
 *
 * Hiding /items from a biller is politeness; what actually stops a biller changing a
 * price is items_admin_write in supabase/migrations/0002_rls.sql. Never treat a passing
 * check here as protection, and never move an authorization decision into this file.
 */
const BY_ROLE: Record<Role, RouteDef[]> = {
  recorder: [
    { path: "/bill", labelKey: "nav.bill" },
    { path: "/customers", labelKey: "nav.customers" },
  ],
  biller: [{ path: "/pending", labelKey: "nav.pending" }],
  admin: [
    { path: "/bill", labelKey: "nav.bill" },
    { path: "/pending", labelKey: "nav.pending" },
    { path: "/items", labelKey: "nav.items" },
    { path: "/customers", labelKey: "nav.customers" },
    { path: "/staff", labelKey: "nav.staff" },
    { path: "/dashboards", labelKey: "nav.dashboards" },
  ],
};

export function routesForRole(role: Role): RouteDef[] {
  return BY_ROLE[role];
}

export function canAccess(role: Role, path: string): boolean {
  return BY_ROLE[role].some((r) => r.path === path);
}

export function homeFor(role: Role): string {
  const first = BY_ROLE[role][0];
  if (!first) throw new Error(`role ${role} has no routes`);
  return first.path;
}
```

- [ ] **Step 4: Run the test**

Run: `npm --prefix web test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add web/src/routes.ts web/src/__tests__/routes.test.ts
git commit -m "feat(web): role to route mapping"
```

---

## Task 5: Plain-language errors

**Files:**
- Create: `web/src/errors.ts`
- Create: `web/src/__tests__/errors.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `describeError(error: { message?: string; code?: string } | null): { key: string; detail: string } | null`

- [ ] **Step 1: Write the failing test**

`web/src/__tests__/errors.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { describeError } from "../errors";

describe("describeError", () => {
  it("returns null for no error", () => {
    expect(describeError(null)).toBeNull();
  });

  it("names an RLS refusal as a permission problem", () => {
    // 42501 is what a policy-blocked write raises. Showing the raw string to a biller
    // in a shop is useless; keeping it in `detail` keeps it debuggable.
    const d = describeError({ code: "42501", message: "new row violates row-level security policy" });
    expect(d?.key).toBe("error.notAllowed");
    expect(d?.detail).toContain("row-level security");
  });

  it("names a duplicate mobile as an existing customer", () => {
    // (vendor_id, mobile) is unique. "duplicate key value" is not an answer.
    const d = describeError({ code: "23505", message: 'duplicate key value violates unique constraint "customers_vendor_id_mobile_key"' });
    expect(d?.key).toBe("error.customerExists");
  });

  it("distinguishes a network failure from a refusal", () => {
    const d = describeError({ message: "Failed to fetch" });
    expect(d?.key).toBe("error.offline");
  });

  it("falls back to a generic key, keeping the raw message", () => {
    const d = describeError({ message: "something odd" });
    expect(d?.key).toBe("error.unknown");
    expect(d?.detail).toBe("something odd");
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npm --prefix web test`
Expected: FAIL — cannot resolve `../errors`.

- [ ] **Step 3: Create `web/src/errors.ts`**

```ts
/**
 * Turns a PostgREST / Postgres error into a translation key plus the raw text.
 *
 * Two things this must keep straight, because conflating them hides bugs:
 *   - a policy-BLOCKED WRITE arrives as an error (42501);
 *   - a policy-FILTERED READ arrives as zero rows, not an error at all.
 * Callers rendering an empty list must say "nothing yet", never "not allowed".
 */
export function describeError(
  error: { message?: string; code?: string } | null,
): { key: string; detail: string } | null {
  if (!error) return null;
  const detail = error.message ?? "";

  if (error.code === "42501" || /row-level security/i.test(detail)) {
    return { key: "error.notAllowed", detail };
  }
  if (error.code === "23505" && /customers/.test(detail)) {
    return { key: "error.customerExists", detail };
  }
  if (error.code === "23505") {
    return { key: "error.duplicate", detail };
  }
  if (/failed to fetch|networkerror|load failed/i.test(detail)) {
    return { key: "error.offline", detail };
  }
  return { key: "error.unknown", detail };
}
```

- [ ] **Step 4: Run the test**

Run: `npm --prefix web test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add web/src/errors.ts web/src/__tests__/errors.test.ts
git commit -m "feat(web): plain-language error mapping"
```

---

## Task 6: i18n — language resolution and item names

**Files:**
- Create: `web/src/i18n/locales.ts`, `web/src/i18n/index.ts`,
  `web/src/i18n/en.json`, `web/src/i18n/hi.json`, `web/src/i18n/mr.json`
- Create: `web/src/__tests__/locales.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `type Lang = "mr" | "hi" | "en"`, `LANGS: readonly Lang[]`
  - `resolveLang(stored: string | null, browser: readonly string[]): Lang`
  - `itemName(item: { name_en: string; name_hi: string; name_mr: string }, lang: Lang): string`
  - `LANG_STORAGE_KEY = "vendor-app.lang"`
  - default export from `i18n/index.ts`: the configured `i18next` instance

- [ ] **Step 1: Write the failing test**

`web/src/__tests__/locales.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { resolveLang, itemName, LANGS } from "../i18n/locales";

describe("resolveLang", () => {
  it("prefers a stored choice", () => {
    expect(resolveLang("hi", ["en-GB"])).toBe("hi");
  });

  it("ignores a stored value that is not a supported language", () => {
    expect(resolveLang("fr", ["en-GB"])).toBe("en");
  });

  it("falls back to a supported browser language", () => {
    expect(resolveLang(null, ["mr-IN", "en-GB"])).toBe("mr");
  });

  it("defaults to Marathi when nothing matches", () => {
    // Marathi is the default because the shop staff are the primary users; English is
    // the fallback only when the browser explicitly asks for it.
    expect(resolveLang(null, ["fr-FR"])).toBe("mr");
  });

  it("supports exactly mr, hi and en", () => {
    expect([...LANGS]).toEqual(["mr", "hi", "en"]);
  });
});

describe("itemName", () => {
  const onion = { name_en: "Onion", name_hi: "प्याज", name_mr: "कांदा" };

  it("uses the column for the active language", () => {
    expect(itemName(onion, "mr")).toBe("कांदा");
    expect(itemName(onion, "hi")).toBe("प्याज");
    expect(itemName(onion, "en")).toBe("Onion");
  });

  it("falls back to English when a translation is empty", () => {
    // name_hi and name_mr default to '' in 0001_schema.sql, so an untranslated item is
    // the normal case, not an error.
    expect(itemName({ name_en: "Beetroot", name_hi: "", name_mr: "" }, "mr")).toBe("Beetroot");
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npm --prefix web test`
Expected: FAIL — cannot resolve `../i18n/locales`.

- [ ] **Step 3: Create `web/src/i18n/locales.ts`**

```ts
export const LANGS = ["mr", "hi", "en"] as const;
export type Lang = (typeof LANGS)[number];

export const LANG_STORAGE_KEY = "vendor-app.lang";

const isLang = (v: string): v is Lang => (LANGS as readonly string[]).includes(v);

export function resolveLang(stored: string | null, browser: readonly string[]): Lang {
  if (stored && isLang(stored)) return stored;
  for (const tag of browser) {
    const base = tag.split("-")[0];
    if (base && isLang(base)) return base;
  }
  return "mr";
}

/**
 * Item names are DATA, not UI strings: items carries name_en, name_hi and name_mr.
 * Both translated columns default to '' , so an untranslated item is normal and must
 * fall back rather than render blank.
 */
export function itemName(
  item: { name_en: string; name_hi: string; name_mr: string },
  lang: Lang,
): string {
  const chosen = lang === "mr" ? item.name_mr : lang === "hi" ? item.name_hi : item.name_en;
  return chosen.trim() !== "" ? chosen : item.name_en;
}
```

- [ ] **Step 4: Run the test**

Run: `npm --prefix web test`
Expected: PASS.

- [ ] **Step 5: Create the three locale files**

`web/src/i18n/en.json`:

```json
{
  "app": { "name": "Vendor App", "signIn": "Sign in", "signOut": "Sign out", "email": "Email", "password": "Password", "signingIn": "Signing in…", "language": "Language" },
  "nav": { "bill": "New bill", "pending": "Pending", "items": "Items", "customers": "Customers", "staff": "Staff", "dashboards": "Dashboards" },
  "session": { "unmappedTitle": "Account not linked to a shop", "unmapped": "You are signed in as {{email}}, but no staff record exists for this account yet. An admin needs to add you before you can use the app." },
  "error": { "notAllowed": "Your role does not allow this.", "customerExists": "A customer with this mobile number already exists.", "duplicate": "This already exists.", "offline": "No connection. Check the network and try again.", "unknown": "Something went wrong.", "details": "Details" },
  "offline": { "banner": "You are offline. Changes cannot be saved." },
  "soon": { "title": "Coming soon", "body": "This screen arrives in a later stage. Dashboards are still available in the old console." }
}
```

`web/src/i18n/hi.json`:

```json
{
  "app": { "name": "वेंडर ऐप", "signIn": "साइन इन", "signOut": "साइन आउट", "email": "ईमेल", "password": "पासवर्ड", "signingIn": "साइन इन हो रहा है…", "language": "भाषा" },
  "nav": { "bill": "नया बिल", "pending": "बाकी", "items": "सामान", "customers": "ग्राहक", "staff": "स्टाफ", "dashboards": "डैशबोर्ड" },
  "session": { "unmappedTitle": "खाता दुकान से नहीं जुड़ा", "unmapped": "आप {{email}} के रूप में साइन इन हैं, लेकिन इस खाते के लिए कोई स्टाफ रिकॉर्ड नहीं है। एडमिन को पहले आपको जोड़ना होगा।" },
  "error": { "notAllowed": "आपकी भूमिका को इसकी अनुमति नहीं है।", "customerExists": "इस मोबाइल नंबर का ग्राहक पहले से मौजूद है।", "duplicate": "यह पहले से मौजूद है।", "offline": "कनेक्शन नहीं है। नेटवर्क जांचें और फिर कोशिश करें।", "unknown": "कुछ गड़बड़ हुई।", "details": "विवरण" },
  "offline": { "banner": "आप ऑफ़लाइन हैं। बदलाव सहेजे नहीं जा सकते।" },
  "soon": { "title": "जल्द आ रहा है", "body": "यह स्क्रीन बाद के चरण में आएगी। डैशबोर्ड अभी पुराने कंसोल में उपलब्ध हैं।" }
}
```

`web/src/i18n/mr.json`:

```json
{
  "app": { "name": "व्हेंडर अ‍ॅप", "signIn": "साइन इन", "signOut": "साइन आउट", "email": "ईमेल", "password": "पासवर्ड", "signingIn": "साइन इन होत आहे…", "language": "भाषा" },
  "nav": { "bill": "नवीन बिल", "pending": "बाकी", "items": "माल", "customers": "ग्राहक", "staff": "कर्मचारी", "dashboards": "डॅशबोर्ड" },
  "session": { "unmappedTitle": "खाते दुकानाशी जोडलेले नाही", "unmapped": "तुम्ही {{email}} म्हणून साइन इन आहात, पण या खात्यासाठी कर्मचारी नोंद नाही. अ‍ॅडमिनने आधी तुम्हाला जोडणे आवश्यक आहे." },
  "error": { "notAllowed": "तुमच्या भूमिकेला याची परवानगी नाही.", "customerExists": "या मोबाइल क्रमांकाचा ग्राहक आधीच आहे.", "duplicate": "हे आधीच अस्तित्वात आहे.", "offline": "कनेक्शन नाही. नेटवर्क तपासा आणि पुन्हा प्रयत्न करा.", "unknown": "काहीतरी चूक झाली.", "details": "तपशील" },
  "offline": { "banner": "तुम्ही ऑफलाइन आहात. बदल जतन होणार नाहीत." },
  "soon": { "title": "लवकरच येत आहे", "body": "ही स्क्रीन पुढील टप्प्यात येईल. डॅशबोर्ड सध्या जुन्या कन्सोलमध्ये उपलब्ध आहेत." }
}
```

> **Translation caveat for the reviewer:** these Hindi and Marathi strings are a
> best-effort starting point, not reviewed by a native speaker. Flag them for review by
> someone who speaks Marathi before this reaches real staff — the UI is for them.

- [ ] **Step 6: Create `web/src/i18n/index.ts`**

```ts
import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import en from "./en.json";
import hi from "./hi.json";
import mr from "./mr.json";
import { LANG_STORAGE_KEY, resolveLang, type Lang } from "./locales";

// localStorage throws in some privacy modes; a language preference is not worth a
// blank screen.
const stored = (() => {
  try {
    return localStorage.getItem(LANG_STORAGE_KEY);
  } catch {
    return null;
  }
})();

const lng = resolveLang(stored, navigator.languages ?? [navigator.language]);

void i18n.use(initReactI18next).init({
  resources: { en: { translation: en }, hi: { translation: hi }, mr: { translation: mr } },
  lng,
  fallbackLng: "en",
  interpolation: { escapeValue: false },
});

export function setLang(lang: Lang): void {
  void i18n.changeLanguage(lang);
  try {
    localStorage.setItem(LANG_STORAGE_KEY, lang);
  } catch {
    /* preference not persisted; the app still works */
  }
  document.documentElement.lang = lang;
}

document.documentElement.lang = lng;

export default i18n;
```

- [ ] **Step 7: Run tests and the build**

```bash
npm --prefix web test
npm --prefix web run build
```

Expected: all tests pass; build exits 0.

- [ ] **Step 8: Commit**

```bash
git add web/src/i18n web/src/__tests__/locales.test.ts
git commit -m "feat(web): i18n with mr/hi/en and item-name fallback"
```

---

## Task 7: SessionProvider, Login, and the shell

**Files:**
- Create: `web/src/components/SessionProvider.tsx`, `web/src/components/Login.tsx`,
  `web/src/components/Shell.tsx`, `web/src/components/Guard.tsx`,
  `web/src/screens/Placeholder.tsx`
- Modify: `web/src/App.tsx`, `web/src/main.tsx`

**Interfaces:**
- Consumes: `supabase`, `sessionFromRow`, `SessionState`, `routesForRole`, `canAccess`,
  `homeFor`, `describeError`, `setLang`, `LANGS`.
- Produces: `useSession(): SessionState`, and a mounted app at `/`.

- [ ] **Step 1: Create `web/src/components/SessionProvider.tsx`**

```tsx
import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { supabase } from "../supabase";
import { sessionFromRow, type AppUserRow, type SessionState } from "../session";

const Ctx = createContext<SessionState>({ kind: "loading" });

export function useSession(): SessionState {
  return useContext(Ctx);
}

/**
 * The ONLY place app_users is read. Role and tenant come from here and nowhere else,
 * because this is what current_vendor_id() and current_user_role() resolve from in the
 * database -- a second source could disagree with the policies that enforce it.
 */
export function SessionProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<SessionState>({ kind: "loading" });

  useEffect(() => {
    let cancelled = false;

    async function load(userId: string, email: string) {
      const { data, error } = await supabase
        .from("app_users")
        .select("name, role, vendor_id, vendors(name)")
        .eq("id", userId)
        .maybeSingle();
      if (cancelled) return;
      // An error here is not the same as "no row": treat only a clean null as unmapped,
      // so a transient failure does not tell a real admin they are not staff.
      if (error) {
        setState({ kind: "unmapped", email });
        return;
      }
      setState(sessionFromRow(userId, email, (data as AppUserRow | null) ?? null));
    }

    void supabase.auth.getSession().then(({ data }) => {
      const s = data.session;
      if (cancelled) return;
      if (!s) setState({ kind: "signedOut" });
      else void load(s.user.id, s.user.email ?? "");
    });

    const { data: sub } = supabase.auth.onAuthStateChange((_e, s) => {
      if (cancelled) return;
      if (!s) setState({ kind: "signedOut" });
      else {
        setState({ kind: "loading" });
        void load(s.user.id, s.user.email ?? "");
      }
    });

    return () => {
      cancelled = true;
      sub.subscription.unsubscribe();
    };
  }, []);

  return <Ctx.Provider value={state}>{children}</Ctx.Provider>;
}
```

- [ ] **Step 2: Create `web/src/components/Login.tsx`**

```tsx
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { supabase } from "../supabase";
import { describeError } from "../errors";
import { LangSwitch } from "./Shell";

export function Login() {
  const { t } = useTranslation();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<{ key: string; detail: string } | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    setBusy(false);
    // Sign-in failures are GoTrue's, not PostgREST's; show the message it gives rather
    // than mapping it through describeError's Postgres codes.
    if (error) setErr({ key: "error.unknown", detail: error.message });
  }

  return (
    <div className="min-h-screen flex flex-col items-center justify-center p-4 gap-4">
      <form onSubmit={submit} className="bg-white border border-slate-200 rounded-xl p-6 w-full max-w-sm shadow-sm">
        <h1 className="text-lg font-semibold text-slate-800 mb-5">{t("app.name")}</h1>
        {err && (
          <div className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700 mb-3">
            {t(err.key)}
            <span className="block text-xs opacity-70 mt-1">{err.detail}</span>
          </div>
        )}
        <label className="block text-sm font-medium mb-1" htmlFor="email">{t("app.email")}</label>
        <input id="email" type="email" required autoComplete="username" value={email}
               onChange={(e) => setEmail(e.target.value)}
               className="w-full border border-slate-300 rounded-lg px-3 mb-3" />
        <label className="block text-sm font-medium mb-1" htmlFor="password">{t("app.password")}</label>
        <input id="password" type="password" required autoComplete="current-password" value={password}
               onChange={(e) => setPassword(e.target.value)}
               className="w-full border border-slate-300 rounded-lg px-3 mb-5" />
        <button type="submit" disabled={busy}
                className="w-full bg-green-600 disabled:bg-green-300 text-white rounded-lg font-medium">
          {busy ? t("app.signingIn") : t("app.signIn")}
        </button>
      </form>
      <LangSwitch />
    </div>
  );
}
```

- [ ] **Step 3: Create `web/src/components/Shell.tsx`**

```tsx
import { useEffect, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { NavLink } from "react-router-dom";
import { supabase } from "../supabase";
import { routesForRole } from "../routes";
import { LANGS, type Lang } from "../i18n/locales";
import { setLang } from "../i18n";
import type { Role } from "../config";

export function LangSwitch() {
  const { i18n, t } = useTranslation();
  return (
    <label className="text-sm flex items-center gap-2">
      <span className="sr-only">{t("app.language")}</span>
      <select value={i18n.language as Lang} onChange={(e) => setLang(e.target.value as Lang)}
              className="border border-slate-300 rounded-lg px-2 bg-white">
        {LANGS.map((l) => <option key={l} value={l}>{l.toUpperCase()}</option>)}
      </select>
    </label>
  );
}

/** Online-only by design: tokens are issued atomically server-side and cannot be
 *  generated offline, so the app says so plainly rather than queueing work it cannot
 *  complete. */
function OfflineBanner() {
  const { t } = useTranslation();
  const [offline, setOffline] = useState(!navigator.onLine);
  useEffect(() => {
    const on = () => setOffline(false);
    const off = () => setOffline(true);
    window.addEventListener("online", on);
    window.addEventListener("offline", off);
    return () => {
      window.removeEventListener("online", on);
      window.removeEventListener("offline", off);
    };
  }, []);
  if (!offline) return null;
  return <div className="bg-amber-100 text-amber-900 text-sm px-4 py-2 text-center">{t("offline.banner")}</div>;
}

export function Shell({ role, vendorName, name, children }:
  { role: Role; vendorName: string; name: string; children: ReactNode }) {
  const { t } = useTranslation();
  return (
    <div className="min-h-screen">
      <OfflineBanner />
      <header className="bg-white border-b border-slate-200 px-4 py-3">
        <div className="max-w-3xl mx-auto flex items-center justify-between gap-3">
          <div className="min-w-0">
            <p className="font-semibold text-slate-800 truncate">{vendorName || t("app.name")}</p>
            <p className="text-xs text-slate-500 truncate">{name} · {role}</p>
          </div>
          <div className="flex items-center gap-2">
            <LangSwitch />
            <button onClick={() => void supabase.auth.signOut()}
                    className="border border-slate-300 rounded-lg px-3 text-sm bg-white">
              {t("app.signOut")}
            </button>
          </div>
        </div>
      </header>
      <nav className="bg-white border-b border-slate-200 px-4 overflow-x-auto">
        <div className="max-w-3xl mx-auto flex gap-1">
          {routesForRole(role).map((r) => (
            <NavLink key={r.path} to={r.path}
                     className={({ isActive }) =>
                       `px-3 py-2 text-sm whitespace-nowrap border-b-2 ${
                         isActive ? "border-green-600 text-green-700 font-medium" : "border-transparent text-slate-600"}`}>
              {t(r.labelKey)}
            </NavLink>
          ))}
        </div>
      </nav>
      <main className="max-w-3xl mx-auto p-4">{children}</main>
    </div>
  );
}
```

- [ ] **Step 4: Create `web/src/screens/Placeholder.tsx` and `web/src/components/Guard.tsx`**

`web/src/screens/Placeholder.tsx`:

```tsx
import { useTranslation } from "react-i18next";

/** Named stubs so routing is real in stage 1 and each screen has a home to grow into. */
export function Placeholder({ titleKey }: { titleKey: string }) {
  const { t } = useTranslation();
  return (
    <div className="bg-white border border-slate-200 rounded-xl p-6">
      <h2 className="font-semibold text-slate-800 mb-1">{t(titleKey)}</h2>
      <p className="text-sm text-slate-500">{t("soon.body")}</p>
    </div>
  );
}
```

`web/src/components/Guard.tsx`:

```tsx
import { Navigate, useLocation } from "react-router-dom";
import { canAccess, homeFor } from "../routes";
import type { Role } from "../config";
import type { ReactNode } from "react";

/**
 * UX only. A biller who types /items into the address bar is redirected as a courtesy;
 * what actually stops them changing a price is items_admin_write in the database. Do not
 * add an authorization decision here that the policies do not already make.
 */
export function Guard({ role, children }: { role: Role; children: ReactNode }) {
  const { pathname } = useLocation();
  if (!canAccess(role, pathname)) return <Navigate to={homeFor(role)} replace />;
  return <>{children}</>;
}
```

- [ ] **Step 5: Rewrite `web/src/App.tsx`**

```tsx
import { useTranslation } from "react-i18next";
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import { SessionProvider, useSession } from "./components/SessionProvider";
import { Login } from "./components/Login";
import { Shell } from "./components/Shell";
import { Guard } from "./components/Guard";
import { Placeholder } from "./screens/Placeholder";
import { homeFor } from "./routes";

function Unmapped({ email }: { email: string }) {
  const { t } = useTranslation();
  return (
    <div className="min-h-screen flex items-center justify-center p-4">
      <div className="bg-white border border-amber-200 rounded-xl p-6 max-w-md">
        <h1 className="font-semibold text-slate-800 mb-2">{t("session.unmappedTitle")}</h1>
        <p className="text-sm text-slate-600">{t("session.unmapped", { email })}</p>
      </div>
    </div>
  );
}

function Inner() {
  const s = useSession();
  if (s.kind === "loading") return <div className="p-8 text-slate-400">…</div>;
  if (s.kind === "signedOut") return <Login />;
  if (s.kind === "unmapped") return <Unmapped email={s.email} />;

  return (
    <Shell role={s.role} vendorName={s.vendorName} name={s.name}>
      <Guard role={s.role}>
        <Routes>
          <Route path="/bill" element={<Placeholder titleKey="nav.bill" />} />
          <Route path="/pending" element={<Placeholder titleKey="nav.pending" />} />
          <Route path="/items" element={<Placeholder titleKey="nav.items" />} />
          <Route path="/customers" element={<Placeholder titleKey="nav.customers" />} />
          <Route path="/staff" element={<Placeholder titleKey="nav.staff" />} />
          <Route path="/dashboards" element={<Placeholder titleKey="nav.dashboards" />} />
          <Route path="*" element={<Navigate to={homeFor(s.role)} replace />} />
        </Routes>
      </Guard>
    </Shell>
  );
}

export default function App() {
  // basename: the app is served from /vendor-app/ on GitHub Pages, not from the root.
  return (
    <BrowserRouter basename={import.meta.env.BASE_URL}>
      <SessionProvider>
        <Inner />
      </SessionProvider>
    </BrowserRouter>
  );
}
```

- [ ] **Step 6: Import i18n in `web/src/main.tsx`**

Add `import "./i18n";` above `import "./index.css";` — i18next must be initialised
before the first component renders, or `t()` returns raw keys on the first paint.

- [ ] **Step 7: Verify build and tests**

```bash
npm --prefix web test
npm --prefix web run build
```

Expected: all tests pass; build exits 0 with no TypeScript errors.

- [ ] **Step 8: Verify against the real project by hand**

```bash
npm --prefix web run dev
```

Open the printed URL and check, signed in as `manshw@gmail.com`:
1. the login form appears, and the language switch changes its labels;
2. after sign-in the header reads **My Kirana · Manish Wadhwani · admin**;
3. all six admin nav entries appear, and each routes to its placeholder;
4. typing `/items` while signed in works; there is no console error;
5. sign out returns to the login form.

Record what you saw. If the header shows an empty vendor name, the `vendors(name)` embed
is failing — check the browser network tab for the `app_users` request rather than
patching around it.

- [ ] **Step 9: Commit**

```bash
git add web/
git commit -m "feat(web): session, login, role routing and the app shell"
```

---

## Task 8: Publish the SPA at `/`, keep the console at `/console.html`

**Files:**
- Modify: `.github/workflows/pages.yml`
- Modify: `README.md`

**Interfaces:**
- Consumes: `npm --prefix web run build` producing `web/dist/`.
- Produces: the live site.

- [ ] **Step 1: Add a `web` job to the workflow**

Insert after the existing `test` job, at the same indentation:

```yaml
  # The SPA's own gate. Separate from `test` so a frontend failure reads as a frontend
  # failure, not as a mystery in the database suite.
  web:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v5
      - uses: actions/setup-node@v4
        with:
          node-version: 24
          cache: npm
          cache-dependency-path: web/package-lock.json
      - run: npm ci
        working-directory: web
      - run: npm test
        working-directory: web
      - run: npm run build
        working-directory: web
      - uses: actions/upload-artifact@v4
        with:
          name: web-dist
          path: web/dist/
          retention-days: 1
```

- [ ] **Step 2: Rewrite the deploy job's needs and publish step**

Change `needs: [test]` to `needs: [test, web]`, and replace the `mkdir -p _site` run step
with:

```yaml
      # Publish the TESTED build, not a rebuild: never let the bytes that ship differ
      # from the bytes the gate approved.
      - uses: actions/download-artifact@v4
        with:
          name: web-dist
          path: _site
      # The console keeps its own URL. It still has dashboards the SPA does not, so it
      # stays reachable until stage 4 lands.
      - run: cp console.html _site/console.html
```

Delete the old `cp console.html _site/index.html` line — the SPA now owns `/`.

Also add `actions: read` to the workflow's `permissions:` block; `download-artifact@v4`
reads the run's artifacts through the API and fails without it.

- [ ] **Step 3: Generate the lockfile the workflow caches on**

```bash
npm --prefix web install --package-lock-only
git add web/package-lock.json
```

`npm ci` in the workflow requires it, and `cache-dependency-path` points at it.

- [ ] **Step 4: Update `README.md`**

Under "What is here", add a row noting `web/` is the SPA and `console.html` is the older
single-file console, and record both URLs:

- `https://manshw-pixel.github.io/vendor-app/` — the SPA
- `https://manshw-pixel.github.io/vendor-app/console.html` — the console

State plainly that stage 1 ships the shell only: sign-in, role routing and language
switching, with every screen a placeholder, and the console remains the way to see
dashboards until stage 4.

- [ ] **Step 5: Commit and push**

```bash
git add .github/workflows/pages.yml README.md web/package-lock.json
git commit -m "ci(web): gate and publish the SPA, keeping the console at /console.html"
git push
```

- [ ] **Step 6: Verify the deployment**

```bash
gh run watch "$(gh run list --limit 1 --json databaseId -q '.[0].databaseId')" --exit-status
curl -s -o /dev/null -w "%{http_code}\n" https://manshw-pixel.github.io/vendor-app/
curl -s -o /dev/null -w "%{http_code}\n" https://manshw-pixel.github.io/vendor-app/console.html
```

Expected: the run succeeds; both URLs return 200. Then open the site and sign in, to
confirm the deployed build behaves as the dev server did.

**Known limitation to expect, not to fix here:** GitHub Pages has no SPA rewrite, so
reloading a deep link such as `/vendor-app/items` returns a 404 from Pages before React
Router sees it. In-app navigation works. The usual fix is a `404.html` copy of
`index.html`; leave it to stage 2 unless a reviewer asks, and do not switch to hash
routing to dodge it.

---

## Stages 2–4 (outline — each gets its own plan)

Written here so the sequence is visible, not to be executed from this document.

**Stage 2 — the billing flow.** Customer pick/create (all three fields mandatory,
duplicate mobile reported as an existing customer); bill creation with
`status='recording'`; line editing while recording; **Done** → `rpc('issue_token')` with a
confirm step, since the basket freezes; the token displayed large. Biller: `status='billed'`
queue → `rpc('complete_bill')` → points awarded and stock movement shown. `vendor_id` sent
explicitly on every insert. The client's `total` is display only.

**Stage 3 — admin.** Items and stock with all three name columns; customers; the staff
screen that *maps* roles rather than creating accounts (§6 of the spec); loyalty config
written to the `vendors` row.

**Stage 4 — dashboards and the bell.** The eight views, the low-stock bell reading
`v_low_stock`, refreshed on navigation and after stock writes. Then drop `console.html`
and its workflow line.

---

## Self-review notes

Checked against the spec:

- §1 online-only → Task 7 `OfflineBanner`. **Note:** the spec also requires Done disabled
  while offline — that belongs to stage 2, which owns the Done button.
- §2 stack → Task 1, with React 19 substituted for 18 and recorded in Global Constraints.
- §3 session and the unmapped case → Tasks 3 and 7.
- §4 screens → Task 4 routes; the screens themselves are stages 2–4.
- §5 billing → stage 2, not this plan.
- §6 staff creation → stage 3.
- §7 bell → stage 4.
- §8 i18n → Task 6, including the item-name fallback ahead of the screen that needs it,
  because it is pure and cheap to test now.
- §9 errors → Task 5.
- §10 testing → Vitest throughout; E2E remains out of reach without PostgREST and GoTrue,
  as the spec records.
- §11 delivery → Task 8 publishes stage 1 and preserves the console.
