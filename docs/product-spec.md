---
name: vegetable-vendor-app
description: >-
  Build the vendor-side vegetable & fruit shop management app — a private
  per-vendor tool for pricing, stock, billing, loyalty points, dashboards, and
  WhatsApp customer messaging, on a self-hosted Supabase backend. Use this skill
  whenever the user asks to build, extend, schema, or scope this app, or mentions
  any of its pieces (vendor billing app, produce shop app, points/loyalty for a
  grocery vendor, WhatsApp order tokens, bought-together dashboard, low-stock
  bell). Trigger it even when the user names only one feature (e.g. "add the
  points expiry job" or "write the bought-together query") — the whole spec and
  the locked stack decisions live here, so consult it before designing any part.
---

# Vegetable & Fruit Vendor App

A management app used **privately by each vendor** (not a buyer-facing
marketplace). Every vendor runs the same app; their data is isolated. Staff log
in by role, record sales, bill customers, and customers receive order tokens and
loyalty points over WhatsApp.

Follow the locked decisions below — they were settled with the product owner.
Do not re-open them unless the user explicitly asks to change one.

## Locked architecture decisions

- **Backend:** Supabase, **self-hosted by the app owner** (not per-vendor hosting).
- **Multi-tenancy:** **one** Supabase project, tenanted by `vendor_id` (+ vendor
  name), with **Row-Level Security on every table**. RLS is the security
  boundary that keeps vendor A from ever seeing vendor B — test it hard.
- **Auth & roles:** Supabase Auth. Three roles: `admin`, `recorder`, `biller`.
- **No n8n / no Make.** Scheduling and automation live inside Supabase:
  - **pg_cron** for scheduled jobs (points-expiry sweep, daily rollups).
  - **Edge Functions** for the WhatsApp webhook (inbound bot) and outbound sends.
- **WhatsApp:** required. Needs WhatsApp **Business API via a BSP** —
  **Meta Cloud API** is the default (cheapest, called directly from an Edge
  Function). Gupshup/Twilio are acceptable alternatives. One central sender
  number for the app owner; vendors do **not** each need a number.
- **Frontend:** a web app. Framework is the builder's choice (not fixed here).
  App languages: **Marathi, Hindi, English** — a frontend i18n concern,
  backend-agnostic.
- **Google Drive:** used only for produce **images** and generated **bill PDFs**
  (and optionally a human-readable catalogue mirror). Drive is **not** the
  database — that idea was evaluated and rejected because concurrent billing,
  the WhatsApp bot, and cross-query analytics need a real transactional store.

## The dependency to start first

Meta business verification + WhatsApp **message-template approval** takes
days-to-weeks and is the long pole. Kick it off before writing code. Templates
are needed only for messages the app *initiates* (bill notification, points
confirmation). Bot *replies* within the 24-hour customer session window need no
template. If the user wants to build before WhatsApp is live, build every
message as an event so the BSP is a later wiring job, not a redesign — but the
product owner has confirmed WhatsApp is in scope.

## Requirements (authoritative spec)

Numbered as the owner listed them. **#19 was dropped** and is intentionally
absent. Two thresholds are fixed: see #8 and #15.

**Languages & access**
1. App language switch: Marathi, English, Hindi (frontend i18n).
2. **Admin login** maintains the pricing and item list.
3. Admin updates total quantity (stock, in kg) of items.
4. Admin creates multiple **recorder** users (record purchases) and one
   **biller** user. Role separation is enforced by auth + RLS.
5. Admin configures loyalty rules: points awarded above the two spend
   thresholds, and the **number of days** within which points can be redeemed.
   Store these on the vendor row so admin can tune them.

**Dashboard**
6. Total payments collected — daily, weekly, monthly.
7. Most items sold.
8. **Most bought-together product pairs.** Threshold is **3**: a pair counts
   only after it co-occurs in **3 or more** completed bills.
9. Bell **notification** when any item has **less than 10 kg** stock left.
10. Count of **requests for out-of-stock items**.

**Customers & billing**
11. Users create customers with **Name, Flat no, Mobile — all mandatory**.
12. A recorder builds a bill for the biller, with **edit** before confirming.
    On **Done**, a **bill/token number is generated** for the customer to pay at
    the billing counter. Token numbers must be generated atomically
    (Postgres sequence / counter under lock) — never "max + 1" in app code, or
    concurrent recorders collide.
13. Customer receives a **WhatsApp** message with the order/token number and
    total to pay.
14. Biller completes billing; **customer history is stored**.
15. **Points:** spend **above 600 → 50 points**; spend **1000 or above →
    100 points**. Thresholds/rewards are read from vendor config (#5). Compute
    inside the same DB transaction as the bill and write to an append-only
    points ledger with an `expires_at` = now + redeem-days.
16. Customer gets a WhatsApp message (via bot) once billing is done and points
    are allotted.
17. Customer can ask the bot their **total points** and **days left to redeem**.
18. Notify customers which items are **in stock** (qualifies when stock **> 0 kg**).
20. Customers can **suggest items** the vendor doesn't stock (feeds #10).

> #18 as an unsolicited broadcast to all customers is a **marketing-category**
> WhatsApp template under Meta's rules: rate-limited and opt-in only. Decide per
> deployment whether it goes over WhatsApp or stays in-app.

## Data model (first pass)

Every table carries `vendor_id`. Denormalise `vendor_id` onto child tables
(e.g. `bill_items`) so each RLS policy is a plain column check rather than a join.

- `vendors` — id, name, `points_threshold_1` (600), `points_reward_1` (50),
  `points_threshold_2` (1000), `points_reward_2` (100), `redeem_days`.
- `vendor_counters` — vendor_id, `last_token` (atomic token source for #12).
- `app_users` — id (= auth uid), vendor_id, role, name.
- `items` — id, vendor_id, `name_en`/`name_hi`/`name_mr`, price (per kg),
  `stock_kg`, is_active.
- `customers` — id, vendor_id, name, flat_no, mobile (all NOT NULL, #11).
- `bills` — id, vendor_id, token_no, customer_id, recorder_id, biller_id,
  total, status (`recording` → `billed` → `done`), created_at, completed_at.
- `bill_items` — id, bill_id, vendor_id, item_id, qty_kg, unit_price,
  line_total. Powers #7 and #8.
- `points_ledger` — id, vendor_id, customer_id, bill_id, points, earned_at,
  expires_at. **Append-only ledger**, not a running total — auditable;
  redemptions are negative rows.
- `stock_requests` — id, vendor_id, customer_id, item_name, created_at. (#10, #20)

## How the tricky requirements resolve

- **#12 token / concurrency:** increment `vendor_counters.last_token` with
  `UPDATE … RETURNING` inside the billing function — atomic, no race.
- **#15 points:** compute in the same transaction that finalises the bill;
  insert a ledger row with `expires_at = now() + redeem_days`.
- **#17 balance:** `sum(points) where expires_at > now()`; earliest future
  `expires_at` gives days-to-redeem. Bot reads it via service role.
- **#8 bought-together (threshold 3):** self-join `bill_items` on `bill_id`
  with `item_a < item_b`, restrict to `status='done'`, group by the pair,
  `HAVING count(distinct bill_id) >= 3`. Ship as a view.
- **#9 low-stock bell:** Supabase Realtime subscription on `items` where
  `stock_kg < 10`.
- **#6/#7/#10 dashboards:** SQL views over `bills` / `bill_items` /
  `stock_requests`, scoped by RLS (`security_invoker = true` on the views).
- **Billing lifecycle:** recorder finishes → `issue_token()` assigns token,
  sets `billed`, triggers #13. Biller completes → `complete_bill()` decrements
  stock, writes points, sets `done`, triggers #16. Keep both as
  `SECURITY DEFINER` functions so points/stock can't be forged from the client.

## Build order (suggested)

1. Start Meta business verification + template approval (parallel, blocking).
2. Migrations: schema → RLS → functions (`issue_token`, `complete_bill`,
   `customer_points_balance`) → dashboard views.
3. Verify RLS with two vendors and each role before anything else.
4. Edge Functions: `whatsapp-webhook` (inbound #17/#20), `send-notification`
   (outbound #13/#16). pg_cron for points expiry.
5. Frontend: auth + roles, i18n (mr/hi/en), item/stock admin, customer create,
   bill flow, dashboards, low-stock bell.
6. Drive integration for images + bill PDFs.

## Open items the owner must supply

- **BSP choice:** Meta Cloud API (default) vs Gupshup/Twilio.
- **WhatsApp opt-in policy** for #18 broadcasts.

Everything else in this spec is settled.
