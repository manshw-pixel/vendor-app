# Runbook: creating the first vendor and admin

**When you need this:** a freshly deployed production project. The schema is complete and
correct, and nobody can log in.

## Why it cannot be done through the app

This is a consequence of the security model, not a gap in it. From `0002_rls.sql`:

```sql
create policy users_admin_write on app_users for all to authenticated
  using (vendor_id = current_vendor_id() and current_user_role() = 'admin')
  with check (vendor_id = current_vendor_id() and current_user_role() = 'admin');
```

Writing `app_users` requires already being an **admin of that vendor**. And
`current_vendor_id()` resolves the caller's tenant by reading `app_users`. On an empty
database there is no admin, so nothing authorises the first insert — the API cannot
create it, by design.

There is no application server to hold a privileged path, so the first row is placed by
hand, once per vendor, by someone with database access.

## Steps

**1. The person signs up through Auth.**

Either they register through the app normally, or you add them in the dashboard:
Authentication → Users → **Add user**. Production keeps email confirmations on, so a
self-registration must be confirmed before their `auth.users` row is usable.

**2. Create the vendor.** In the SQL editor:

```sql
insert into vendors (name) values ('<vendor name>') returning id;
```

Note the returned `id`. The `vendors_counter_ai` trigger creates the matching
`vendor_counters` row automatically, so `issue_token` never meets a missing counter.

The loyalty columns (`points_threshold_1`, `points_reward_1`, `points_threshold_2`,
`points_reward_2`, `redeem_days`) take the spec's defaults — 600/50, 1000/100, 30 days.
Override them here if this vendor's rules differ; the billing functions read them from
this row and never hardcode.

**3. Promote that person to admin of that vendor.**

```sql
insert into app_users (id, vendor_id, role, name)
values (
  (select id from auth.users where email = '<their email>'),
  '<the vendor id from step 2>',
  'admin',
  '<their name>'
);
```

`app_users.id` is not generated — it **equals** `auth.users.id`. That equality is what
`current_vendor_id()` and `current_user_role()` depend on; get it wrong and the person
authenticates fine but resolves to no tenant and sees nothing.

**4. Verify.**

```sql
select u.name, u.role, v.name as vendor
  from app_users u join vendors v on v.id = u.vendor_id;
```

From here that admin adds the rest of their staff — recorders and billers — through the
app. See below.

## Adding staff after the first admin

Steps 2 and 3 are the bootstrap only. Once one admin exists, Settings → Staff → **Add
staff** creates the account directly: the admin fills in an email, a first password, a
name and a role. The `admin-create-user` Edge Function creates the `auth.users` row with
`auth.admin.createUser` and inserts the linked `app_users` row in one step, using the
`service_role` key that `web/src/config.ts` forbids in the browser bundle — which is why
this has to go through a function rather than the client.

The person then signs in with the email and password the admin set, and is immediately
asked to choose their own password before doing anything else in the app.

This in-app path depends on `admin-create-user` being deployed. If it is not, the SQL
insert in step 3 above remains the recovery route — sign the person up (or add them under
Authentication → Users) and promote them by hand the same way the first admin was made.

## Onboarding vendor #2

Every additional vendor needs this same manual step, because the same policy applies. If
onboarding stops being a rare event, that is a product decision to make deliberately —
an admin-only onboarding flow, or a `SECURITY DEFINER` signup function with its own
guards. Repeating this runbook by hand is fine for a handful of vendors and a bad answer
for fifty.

## Removing staff

Settings -> Staff -> **Remove** now deletes the person's `auth.users` account as well as
their `app_users` row, via the `admin-delete-user` Edge Function. Their email is free to
use again immediately -- which it was not before, and that was the reason a removed person
could never be re-added.

Two failures are worth recognising:

- **"has recorded or completed bills"** -- `bills.recorder_id`/`biller_id` reference
  `app_users` with no `ON DELETE` clause, so the unlink is refused. Nothing is deleted,
  including the account. Change their role instead of removing them.
- **"off your staff list, but their sign-in account could not be deleted"** -- the roster
  row went and the account survived, so their email is still taken. Delete the account by
  hand under Authentication -> Users in the dashboard.

## Clearing a shop's data

Settings -> Danger zone -> **Clear all data** wipes this vendor's bills, bill items, points
ledger, customers, stock requests and outbound queue, and resets the token counter to 0 so
numbering restarts at 1. Items, staff and the vendor row survive.

It runs `clear_vendor_data()` (migration `0009`), a `SECURITY DEFINER` function scoped
entirely to `current_vendor_id()`. That is not a convenience: `0002_rls.sql` grants no write
policy at all on `points_ledger`, `vendor_counters` or `outbound_messages`, so a client
cannot perform these deletes under its own rights however it is authorised.

**There is no undo and no backup taken.** The UI requires typing the shop's name before the
button enables. If you need the data afterwards, take a dump first -- from the Supabase
dashboard, or `supabase db dump`.
