# Update prices from a rate-list photo — design

Date: 2026-09-27. Migration: `0026_rate_list_import.sql`. Edge Function: `read-rate-list`.

## Problem

The vendor gets a daily rate list as an image (printed, handwritten, WhatsApp forward or screenshot — format varies). It gives each item's **selling price** and "sold by". 50+ prices can change per day; new items can appear. Typing them into the Items page is the chore to remove.

## Decisions (owner-confirmed)

- Image formats vary → vision LLM (Claude) + mandatory human review before anything is saved.
- The list's figure is the **selling price** (`items.price`). Existing items' cost is not touched.
- Unmatched list lines become **proposed new items** (not only link/skip).
- New items: cost = stored price; stock 30 and low-stock threshold 10, in the item's unit.
- "Sold by" conversion rules (below) apply to new items **and** existing items; anything outside the rules on an existing item is flagged, never guessed.
- Items absent from today's list are left unchanged.
- Admin only (same as editing items).

## Sold-by rules

App units: `kg`, `piece`, `bunch`, `dozen`.

| List "sold by" | Unit | Price stored |
|---|---|---|
| 12 pc / 12 pcs / dozen / दर्जन | dozen | as written |
| 1 box / 1 packet / 1 pc / piece | piece | as written |
| N grams (e.g. 250 g, 500 g, 100 g) | kg | price × 1000 ÷ N, rounded to 2 dp |
| 1 kg / kilo / blank / anything else | kg | as written |
| bunch / जुडी / गड्डी | bunch | as written |

The LLM reports "sold by" as written; the rules run in our code (pure TS module, unit-tested), not in the prompt. The review row shows any conversion ("250 g ₹20 → ₹80/kg").

For an **existing item**: if the normalised unit equals the item's unit → price update. If it differs → row flagged "unit mismatch": the admin types the price in the item's unit or skips.

## Flow

1. Items page → **Update prices from photo** (admin). Take or pick one or more images (multi-page lists).
2. Client downscales each image (longest side ≤ 1600 px, JPEG) and calls Edge Function `read-rate-list`.
3. Function checks the caller is an authenticated admin of an active shop, sends the images to Claude (`claude-sonnet-5`) with a tool/JSON schema, returns rows. Images are not stored. Nothing is written to the DB.
4. Client loads items + aliases, normalises units, matches rows, and shows the review screen.
5. Admin adjusts rows, taps **Apply** → RPC `apply_price_list(p_rows jsonb)` → **result screen** (below).

## Extraction (Edge Function `read-rate-list`)

- Input: `{ images: [{ media_type, data(base64) }] }` (≤ 5 images, each ≤ 1.5 MB after downscale).
- Secret: `ANTHROPIC_API_KEY` (Supabase function secret).
- Output rows: `{ name_as_written, sold_by_as_written, price, name_en, name_hi, name_mr, confidence: "high"|"low" }`. `name_*` are Claude's transliteration/translation for creating new items. `price` is the number exactly as written (no conversion).
- Errors: non-admin → 403; Claude failure/timeout → 502 with a message key; zero rows → 200 with `[]` (UI says "No prices found in this image").

## Matching (client, pure module)

For each row, in order:
1. Case/space-insensitive exact match of `name_as_written` against the shop's items' `name_en`/`name_hi`/`name_mr`, then against `item_aliases.alias`.
2. Same using the LLM's `name_en`/`name_hi`/`name_mr`.
3. No match → **new item**, unless a close name exists (normalised Levenshtein ≤ 2, or one name contains the other) → still "new item" but with a "Did you mean <item>?" link suggestion shown.

Duplicate rows for the same matched item: last one wins, the earlier shown as "duplicate — ignored".

## Review screen states

| State | Default | Admin can |
|---|---|---|
| Price changed | ticked | edit price, untick |
| Unchanged | hidden (expandable) | — |
| Unit mismatch (existing) | unticked, ⚠️ | type price in item's unit (ticks it), skip |
| New item | ticked | edit en/hi/mr names, unit, price; switch to "link to item" (picker) ; skip |
| Low confidence | as its state, highlighted | same |

Apply is disabled while any ticked row is invalid (price ≤ 0 or not a number, a new item missing a name). Linking a row to an item saves `name_as_written` as an alias on Apply.

## Result screen (after Apply)

- Header: "32 prices changed · 3 items added".
- **Prices changed** list: item name (UI language), unit, old → new price, up/down marker.
- **Items added** list: item name, unit, price, "stock 30 · cost = price" note.
- Counts of unchanged and skipped rows.
- Buttons: **Done** (back to Items, list refreshed) and **Update another list**.
- Built from the RPC's return value, so it shows what the database saved, not what was sent.

## Database (0026)

- `item_aliases (id, vendor_id, item_id → items on delete cascade, alias text, created_at, unique (vendor_id, lower(alias)))`, RLS: read by the shop's staff; writes only via the RPC.
- `price_changes (id, vendor_id, item_id, old_price, new_price, source text check (source in ('rate_list')), changed_by, changed_at)` — audit log, read by admin.
- `apply_price_list(p_rows jsonb) returns jsonb`, security definer, admin of `current_vendor_id()` only (42501 otherwise). Rows:
  - `{ kind: "update", item_id, price, alias? }` → item must be in the shop; `update items set price` (the 0025 trigger reprices pending bills); log `price_changes` when the price differs; upsert alias if given.
  - `{ kind: "create", names: {en,hi,mr}, unit, price, alias }` → create via the same rules as `create_item_with_cost` with cost = price, stock 30, low_stock_at 10 (whole-unit check from 0018 passes for 30/10); save `alias` (the name as written) for the new item.
  - One transaction; any invalid row raises (22023) and nothing is applied.
  - Returns `{ updated: [{item_id, name_en, old_price, new_price, unit}], created: [{item_id, name_en, price, unit}], unchanged: n }` — built from what was actually written, not echoed from the input.

## Out of scope

- Storing images or a history of lists.
- Updating cost for existing items.
- Deactivating items missing from the list.
- Offline use (needs network for the LLM).

## Testing

- DB: `apply_price_list` — updates + log, unchanged not logged, create with defaults and cost = price, alias saved and unique, cross-shop item refused, non-admin refused, bad row rolls back everything, pending bill repriced via trigger.
- Unit (web): sold-by normaliser (every rule row, grams maths, unknown → kg), matcher (names, aliases, LLM names, near-match suggestion, duplicates).
- Edge Function: auth refusal, schema-shaped response from a mocked Claude reply, zero rows.
- UI: review states, Apply disabled on invalid rows; result screen lists changed (old → new) and added items from the RPC response.
- Manual: one real run on 2–3 owner sample images before merge.

## Rollout

Needs from owner: Anthropic API key (set as function secret), 2–3 sample images. Deploy order: set secret → deploy function → hand-apply 0026 + tracking row → merge.
