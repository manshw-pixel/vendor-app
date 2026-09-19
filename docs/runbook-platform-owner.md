# Runbook: the platform owner

**When you need this:** a freshly deployed production project (nobody above the shops
exists yet), or day-to-day owner tasks — onboarding a new vendor, or suspending one.

## Why the first owner row is placed by hand

Same reasoning as every admin bootstrap used to be, one level up. From
`0019_platform_owner.sql`:

```sql
alter table platform_owners enable row level security;
create policy owners_read_self on platform_owners for select to authenticated
  using (user_id = auth.uid());
```

`platform_owners` has a read policy for a row's own owner and **no insert policy at
all** — nothing authorises a client to make itself an owner, by design. There is no
application server to hold a privileged path either, so the very first owner is inserted
by hand, once, by someone with database access. Every later owner (if the product ever
needs more than one) is added the same way; there is no in-app "make this person an
owner" flow, and there does not need to be.

This replaces the old per-vendor bootstrap. Before this slice, every new vendor and its
first admin were inserted by hand in the SQL editor, one vendor at a time — that no
longer scales, and it no longer happens for the shop level. Nothing changes about the
owner level: it is still a rare, one-time act instead.

## Bootstrap steps

**1. Add the owner's login in Auth.** Authentication → Users → **Add user**. Production
keeps email confirmations on, so a self-registration would need confirming first — adding
the user directly from the dashboard skips that.

**2. Insert their `platform_owners` row.** In the SQL editor:

```sql
insert into platform_owners (user_id, name)
values (
  (select id from auth.users where email = '<owner email>'),
  '<owner name>'
);
```

`platform_owners.user_id` is not generated — it **equals** `auth.users.id`, the same
convention `app_users.id` uses for shop staff. `is_platform_owner()` is
`exists (select 1 from platform_owners where user_id = auth.uid())`; get the id wrong and
the person signs in fine but never resolves to an owner.

**3. Sign in and see the console.** `SessionProvider` looks for an `app_users` row first;
finding none, it looks for a `platform_owners` row instead. A match renders the owner
console in place of the shop UI — no shop, no staff role, nothing else to configure.

## Creating a vendor from the console

The owner console's **Create vendor** form calls the `owner-create-vendor` Edge Function
with the new shop's name (and optional address/phone) plus its first admin's name, email
and password. In one step, the function verifies the caller is a platform owner, then —
with the service-role key — inserts the `vendors` row, creates the admin's `auth.users`
account (`email_confirm: true`), and links `app_users` with `must_change_password: true`.
If any step after the vendor insert fails, it is undone (auth user and/or vendor row
deleted) rather than left half-created.

That admin signs in with the password the owner set and is immediately asked to choose
their own, exactly like a shop admin creating staff through Settings today. From there
the vendor is on its own: its admin adds its own staff, sets its own items and loyalty
rules, and never sees another shop or the owner console.

This is a one-step replacement for the old "insert a vendor, then insert an admin"
SQL-editor dance. If `owner-create-vendor` is ever not deployed, that SQL-editor path
(insert into `vendors`, then into `app_users` with the admin's `auth.users.id`) remains
the fallback, the same way it always worked — it is just no longer the normal route.

## Suspending and reinstating a shop

The console's Suspend / Reinstate button (behind a confirm) calls
`owner-suspend-vendor` with the vendor id and the action. The function checks the caller
is a platform owner, then sets or clears `vendors.suspended_at` and bans or unbans every
`app_users` account on that shop (`auth.admin.updateUserById`, a ~100-year ban to
suspend, `ban_duration: "none"` to reinstate).

**Two mechanisms, two speeds.** The ban stops *new* sign-ins immediately, and it also
stops the silent renewal that would otherwise keep a session alive indefinitely: a banned
account's refresh token is rejected, so once its current access token expires it cannot
be swapped for a new one. That refresh-token block is what caps the read window at about
an hour, not just the token's own lifetime — without it, a client that refreshes in the
background could keep reading as that vendor well past an hour. A staff member already
signed in is holding a JWT that is still valid for up to its own lifetime — **up to about
an hour** — and `current_vendor_id()` (which the ban does not touch) still resolves it to
the same vendor, so read policies still return that vendor's rows until the token
expires. What stops the damage immediately is
`current_user_role()`: as soon as `suspended_at` is set, it starts returning
`'suspended'` for anyone on that vendor, session or no session, and **every** write
policy and billing function (`issue_token`, `complete_bill`, `replace_bill_lines`,
`log_stock_movement`, `void_bill`, the customer and stock-request inserts, all of it)
keys on the role and refuses with `42501` at once. So: a suspended shop can go on reading
its own stale session for up to an hour, but cannot write a single row from the moment
`suspended_at` is set. A shop admin cannot change `suspended_at` themselves — only the
platform owner's function can, enforced by the `vendors_suspension_guard` trigger.

Reinstating clears `suspended_at` and lifts the bans; the shop's staff are back to normal
sign-in and normal writes, and no data was touched either way — suspension never deletes
or hides anything, it only refuses writes.

## Deploying the two Edge Functions

```bash
supabase functions deploy owner-create-vendor
supabase functions deploy owner-suspend-vendor
```

**The CLI has 401'd against this project before.** If `deploy` fails that way, paste each
function's code into the Supabase dashboard's function editor instead (Edge Functions →
the function → Edit) — that is the standing fallback for this project, not a new
workaround. Either way, confirm `verify_jwt = true` is set for both functions in
`supabase/config.toml` (already committed) and actually took effect on Cloud before
relying on them.

## Adding staff after the first admin

Once a shop has an admin (created either by the owner console above, or by hand), that
admin adds the rest of their staff through the app: Settings → Staff → **Add staff**
takes an email, a first password, a name and a role. The `admin-create-user` Edge
Function creates the `auth.users` row with `auth.admin.createUser` and inserts the linked
`app_users` row in one step, using the `service_role` key that `web/src/config.ts`
forbids in the browser bundle — which is why this has to go through a function rather
than the client.

The person then signs in with the email and password the admin set, and is immediately
asked to choose their own password before doing anything else in the app.

This in-app path depends on `admin-create-user` being deployed. If it is not, the same
SQL-insert fallback the old bootstrap used still works: sign the person up (or add them
under Authentication → Users) and link them by hand —

```sql
insert into app_users (id, vendor_id, role, name)
values (
  (select id from auth.users where email = '<their email>'),
  '<the vendor id>',
  '<role>',
  '<their name>'
);
```

## Removing staff

Settings → Staff → **Remove** deletes the person's `auth.users` account as well as their
`app_users` row, via the `admin-delete-user` Edge Function. Their email is free to use
again immediately.

Two failures are worth recognising:

- **"has recorded or completed bills"** — `bills.recorder_id`/`biller_id` reference
  `app_users` with no `ON DELETE` clause, so the unlink is refused. Nothing is deleted,
  including the account. Change their role instead of removing them.
- **"off your staff list, but their sign-in account could not be deleted"** — the roster
  row went and the account survived, so their email is still taken. Delete the account by
  hand under Authentication → Users in the dashboard.

## Clearing a shop's data

Settings → Danger zone → **Clear all data** wipes this vendor's bills, bill items, points
ledger, customers, stock requests and outbound queue, and resets the token counter to 0 so
numbering restarts at 1. Items, staff and the vendor row survive.

It runs `clear_vendor_data()` (migration `0009`), a `SECURITY DEFINER` function scoped
entirely to `current_vendor_id()`. That is not a convenience: `0002_rls.sql` grants no
write policy at all on `points_ledger`, `vendor_counters` or `outbound_messages`, so a
client cannot perform these deletes under its own rights however it is authorised.

**There is no undo and no backup taken.** The UI requires typing the shop's name before
the button enables. If you need the data afterwards, take a dump first — from the
Supabase dashboard, or `supabase db dump`.

## Redeeming points at the counter

1 point = ₹1. The biller applies redemption while completing a bill, not as a separate
step.

**The cap is clamped, not refused.** `complete_bill()` applies
`least(requested, balance, floor(bill total))` itself — it never rejects a request that
overshoots. A customer who misremembers their balance, or asks to redeem more than the
bill comes to, still gets a completed sale: the function just applies as much as it can
and moves on. Only whole points are ever applied, so a part-rupee bill absorbs one fewer
point than its exact total.

**Points are earned on what the customer actually paid.** Redeeming first lowers the
amount the bill earns points on — a bill that clears the earning threshold before
redemption but not after earns nothing; one that clears it either way earns on the net.

**`bills.total` is the net collected, not the sticker total.** `bills.redeemed_points`
records what was applied on top of it, so the pre-redemption ("gross") amount is
`total + redeemed_points`, not `total` alone. Anyone reading the `bills` table directly,
or reconciling it against a till, needs both columns — `total` by itself understates what
the sale was worth.

This also means the `points_awarded` outbound message payload's `total` field is now the
net figure, since it is built from `bills.total`. Worth flagging to whoever writes the
WhatsApp template for that message, since that copy lives outside this repo.

**Known limit: `days_left` can be pessimistic.** `customer_points_balance()` derives
consumption from a running sum rather than tracking which batch a redemption came out of.
So the expiry date it names can belong to a batch that has, in reality, already been fully
spent by an earlier redemption — the function has no per-batch ledger to check against.
The balance itself is always correct; only the date attached to it can undersell how much
time is actually left.

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
