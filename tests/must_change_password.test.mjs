import { test, assert, assertEqual, assertInvisible, once } from "./framework.mjs";
import { sql } from "./fixtures.mjs";
import { seedTwoVendors } from "./seed.mjs";

const getWorld = once(seedTwoVendors);

test("must_change_password defaults to false for existing staff", async () => {
  const world = await getWorld();
  const { rows } = await sql(
    `select must_change_password from app_users where id = $1`, [world.a.recorderId]);
  assertEqual(rows[0].must_change_password, false,
    "an existing row must not be forced to change a password nobody set for them");
});

test("complete_password_change clears the caller's own flag", async () => {
  const world = await getWorld();
  await sql(`update app_users set must_change_password = true where id = $1`,
    [world.a.recorderId]);

  const { error } = await world.a.clients.recorder.rpc("complete_password_change");
  assert(!error, `rpc failed: ${error && error.message}`);

  const { rows } = await sql(
    `select must_change_password from app_users where id = $1`, [world.a.recorderId]);
  assertEqual(rows[0].must_change_password, false, "the caller's own flag should be clear");
});

test("complete_password_change touches nobody else's row", async () => {
  // The function takes no arguments precisely so there is no id to forge. This proves
  // the body really does key on auth.uid() rather than clearing broadly.
  const world = await getWorld();
  await sql(`update app_users set must_change_password = true where id in ($1, $2)`,
    [world.a.billerId, world.b.recorderId]);

  await world.a.clients.biller.rpc("complete_password_change");

  const { rows } = await sql(
    `select must_change_password from app_users where id = $1`, [world.b.recorderId]);
  assertEqual(rows[0].must_change_password, true,
    "another vendor's flag must be untouched");
});

test("complete_password_change changes nothing without a session", async () => {
  // auth.uid() is null for anon. The update must match zero rows rather than every row.
  const world = await getWorld();
  await sql(`update app_users set must_change_password = true where id = $1`,
    [world.a.adminId]);

  const anon = world.a.clients.admin;
  await anon.auth.signOut();
  await anon.rpc("complete_password_change");

  const { rows } = await sql(
    `select must_change_password from app_users where id = $1`, [world.a.adminId]);
  assertEqual(rows[0].must_change_password, true,
    "an anonymous call must not clear anyone's flag");
});

test("a recorder still cannot update app_users directly", async () => {
  // The function exists BECAUSE users_admin_write is admin-only. If a recorder could
  // write the row themselves the function would be pointless -- and they could also
  // promote themselves to admin.
  const world = await getWorld();
  // users_admin_write's USING clause (not a WITH CHECK violation) is what stops this --
  // the row is filtered out of the update's target set entirely, so PostgREST reports
  // success with zero rows affected rather than an error. That is the silent-filter case
  // assertInvisible exists for (see framework.mjs), not assertDenied's explicit-error case.
  const { data } = await world.a.clients.recorder
    .from("app_users").update({ role: "admin" }).eq("id", world.a.recorderId).select();
  assertInvisible(data, "a recorder must not be able to write app_users");
});
