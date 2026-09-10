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
staff** does step 3 for you: `users_admin_write` already authorises an admin to insert
`app_users` rows for their own vendor, so no SQL and no database access is needed.

What the form still cannot do is step 1. Creating the `auth.users` row needs
`auth.admin.createUser` and therefore the `service_role` key, which `web/src/config.ts`
forbids in the browser bundle — that is the unbuilt Edge Function slice. So the sequence
per person is:

1. **They sign up through the app themselves** (or you add them under Authentication →
   Users, as in step 1 above).
2. **They read their user id off their own sign-in screen** and send it to the admin.
   After signing up they land on **"Account not linked to a shop"**, which shows their
   uuid with a **Copy user id** button — that panel exists for this step and is the only
   place in the app the id appears.
3. **The admin pastes it into Add staff** with a name and a role.

The id is the whole point of the paste, and it is unchecked by any foreign key —
`app_users.id` has no reference to `auth.users` (`0001_schema.sql:34`), only a comment
saying they are equal. The form validates the *shape* of the uuid, which is all a client
can do; a well-formed id belonging to nobody inserts cleanly and produces a person who
signs in fine and resolves to no tenant. Verify with the query in step 4.

## Onboarding vendor #2

Every additional vendor needs this same manual step, because the same policy applies. If
onboarding stops being a rare event, that is a product decision to make deliberately —
an admin-only onboarding flow, or a `SECURITY DEFINER` signup function with its own
guards. Repeating this runbook by hand is fine for a handful of vendors and a bad answer
for fifty.
