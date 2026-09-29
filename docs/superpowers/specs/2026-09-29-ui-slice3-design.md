# UI slice 3: account sheet, loading/empty states, all screens on shared components

Date: 2026-09-29. Status: approved in conversation. Builds on slice 1 (`web/src/ui/`, tokens) and slice 2.

## Goal

Finish the move to one visual system. Every screen uses the shared `ui/` components and tokens; the
header is decluttered; loading and empty states look intentional. **No behaviour change**: every
condition, handler, label text and `data-testid` stays.

## Owner decisions

- Scope: everything at once (one PR, reviewed in batches).
- Language + Sign out move into an **account sheet** opened from the header, for every role.

## 1. Shell and account sheet

- Header: shop name (left); a button showing the person's name (right), `aria-haspopup="dialog"`.
- `components/AccountSheet.tsx`: a `Dialog` with name · role, a language `SegmentedControl`
  (English / हिंदी / मराठी, current one selected), and a `danger` **Sign out** button.
- `LangSwitch` (still exported from `Shell.tsx`, used by Login, ChangePassword, OwnerConsole) is
  re-implemented on `SegmentedControl`. Same `setLang` call.
- `App.tsx` session-loading `…` becomes `Spinner`.

## 2. New ui components

- `Spinner({ label })`: animated ring + visible text label; `role="status"`. Extra props (e.g.
  `data-testid`) pass through to the wrapper.
- `EmptyState({ children, action? })`: centred muted message, optional action node.
- `SegmentedControl<T>({ label, options: {value, label}[], value, onChange })`: a
  `role="radiogroup"` of `role="radio"` buttons, `aria-checked`, min 44px.

## 3. Loading and empty states

- Existing loading texts (`dash.loading`, `stock.loading`, `req.loading`, `owner.loading`,
  `receipt.loading`, CloseDay's loading) render through `Spinner`, same text, same test ids.
- Existing empty texts (`*.empty`) render through `EmptyState`, same text.
- Items empty state gets an action: a link to `/items/rate-list` using the existing
  `rateList.open` label. No other new actions (YAGNI).

## 4. Screen migration

Screens: Pending, Completed, Dues, CustomerDues, CloseDay, Outbox, Customers, Items, RateList,
Stock, Requests, Settings, Staff, Dashboards, SyncIssues, Receipt, OwnerConsole, AmendBill, plus
components ChangePassword, Login, UnclosedBanner, OfflineChip where they have raw buttons.

Rules:
- Raw `<button>` -> `Button` (variant by role: main action `primary`; other `secondary`;
  destructive `danger`; inline text-like `ghost`). Keep every prop.
- Error / warning / info paragraphs -> `Banner` with the matching tone; same text.
- Bordered white panels -> `Card`.
- Hand-rolled `role="dialog"` overlays -> `Dialog`. Irreversible confirms (close the day, discard
  outbox sale, delete/remove staff, void/delete in Pending) pass `initialFocusRef` to Cancel;
  their `onClose` is a no-op while a write is in flight.
- Colours: `emerald-600/green-600` primary -> `brand`; `bg-white` panels -> `bg-surface`.
- Receipt: the 58mm print slip is untouched; only on-screen (`receipt-noprint`) controls migrate.
- Dashboards: chart/figure internals untouched; wrappers and controls migrate.
- `Field` is used where it drops in without changing label text or test queries; otherwise inputs
  keep their markup and just get the standard input classes.

## Testing

- Existing tests pass unchanged, except selector-only edits forced by deliberate markup changes,
  listed in the PR.
- New: ui components; AccountSheet (open, change language, sign out); Cancel focus in each
  irreversible dialog; Items empty state link.
- `npm test`, `npm run build`, Linux CI; manual 360px EN/HI/MR.

## Out of scope

Dark mode; new features; changing any copy other than the new account-sheet keys.
