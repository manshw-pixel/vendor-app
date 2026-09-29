# UI slice 1: design tokens, shared components, bottom nav, sticky checkout

Date: 2026-09-29. Status: approved in conversation, awaiting written-spec review.

## Goal

Make the web app faster and safer to use one-handed on a phone, and lay a shared component
layer that later UI slices build on. No behaviour change: every screen does what it does today,
offline / error / unclosed-day states included.

## Decisions (from the owner)

- Primary colour: **emerald** (already the Done / token colour).
- Migration scope: **Shell + Bill flow only**. Other screens migrate in later slices.
- Navigation: **bottom tab bar + More sheet**. Admin tabs: Bill, Pending, Completed, Dues.

## Success criteria

- Existing web tests pass; any test edited because it asserted deliberately changed markup is
  listed in the PR.
- `npm run build` (tsc + vite) passes locally and on Linux CI.
- No horizontal page scroll at 360px width; EN / HI / MR nav labels fully visible (wrap, never clip).

## 1. Tokens

In `web/src/index.css`, via Tailwind v4 `@theme`:

| Token | Value |
|---|---|
| `brand` | emerald-600 |
| `brand-strong` | emerald-700 (pressed state, brand text) |
| `danger` | red-600 |
| `warn` | amber-600 |
| `surface` | white |
| `canvas` | #f6f8fb (current body background) |
| `ink` | slate-800 |
| `muted` | slate-500 |

Radius convention: `rounded-xl` for cards / dialogs, `rounded-lg` for controls.

## 2. Shared components (`web/src/ui/`, one file each)

- **Button**: `variant` = `primary | secondary | danger | ghost`; `size` = `md` (min 44px) | `lg`.
  Spreads all native button props (so `data-testid`, `disabled`, `type`, `aria-*` pass through).
- **Field**: label + control (children) + optional `hint` / `error`, wired with `htmlFor` and
  `aria-describedby`.
- **Card**: bordered surface panel with optional `title`.
- **Banner**: `tone` = `error | warn | info | success`, optional `action` node.
- **Dialog**: keeps today's markup contract (`role="dialog"`, `aria-modal="true"`, `aria-label`,
  bottom sheet on mobile, centred at `sm:`). Adds focus trap, Escape calls `onClose`, and focus
  returns to the previously focused element on unmount. Native `<dialog>` is deliberately not
  used: jsdom's support for it is partial.

## 3. Navigation

**`routes.ts`**: `RouteDef` gains optional `group: "setup" | "reports" | "endOfDay"`. Admin order
becomes Bill, Pending, Completed, Dues, then Items, Customers, Stock, Requests, Settings (setup),
Dashboards, Sync issues (reports), Close day (endOfDay). New pure helper
`splitNav(routes) -> { tabs: first 4, more: rest }`. `routesForRole`, `UNLISTED` and the offline
list are unchanged.

**`components/BottomNav.tsx`**
- Below `sm`: fixed bottom bar with `env(safe-area-inset-bottom)` padding.
- Tabs are `NavLink`s, min 56px tall, inline-SVG icon (decorative, `aria-hidden`) above an always-
  visible label that may wrap to two lines.
- **More** appears only when `more` is non-empty (admin). It opens `MoreSheet`, a `Dialog`
  listing overflow routes under group headings; tapping one navigates and closes the sheet.
- More shows as active when the current path belongs to a More route.
- Low-stock badge: on Items inside the sheet, and as a dot on More. Where Items is a tab, on the tab.
- At `sm:` and up: the same tabs + More render as a strip under the header (no sideways scroll).

**Shell**: renders `BottomNav` in place of the current `<nav>`; `main` gets bottom padding below
`sm` so the bar never covers content. Header and banners unchanged.

**i18n**: new keys `nav.more`, `nav.group.setup`, `nav.group.reports`, `nav.group.endOfDay` in
en / hi / mr. hi / mr are AI-written and join the native-review backlog.

## 4. Sticky checkout

**`screens/bill/CheckoutBar.tsx`**: shown in the items phase only. Sticky above the bottom nav on
phones, at the bottom at `sm:` and up. Left: `₹total · N items` (`data-testid="checkout-total"`).
Right: large primary **Done** button, same label (`bill.done`), same `canFinish` disabled rule,
same onClick as today. The old full-width Done button is removed, so exactly one Done exists.
`running-total` stays in Basket, unchanged. `main` gets extra bottom padding on the Bill items phase.

## 5. Migration within scope

Shell, Bill, ItemGrid, Basket, TokenResult, OfflineCheckout, OfflineResult move to the `ui/`
components and tokens. Bill's failure banner, save-offline button, stale / no-cache messages
become `Banner` / `Button` with identical text and conditions. The confirm dialogs in Bill and
OfflineCheckout become `Dialog`. All existing `data-testid`s are kept.

## 6. Testing

- `ui/` unit tests: Button variant classes + prop pass-through; Dialog Escape and focus return;
  Field `aria-describedby` wiring.
- `splitNav` / `BottomNav`: tabs per role; More only for admin; More active on an overflow route;
  sheet navigates and closes; badge placement; offline shows Bill + Outbox.
- `CheckoutBar`: total and count update; Done disabled when the basket is empty.
- Full web suite, `npm run build`, Linux CI; manual 360px check in EN / HI / MR.

## Out of scope

Other screens' migration; basket-line undo; customer chip; moving language switch / sign-out;
banner priority / collapsing; dark mode.
