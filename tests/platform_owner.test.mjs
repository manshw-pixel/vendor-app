import { test, assert, assertDenied, assertInvisible, assertEqual, once } from "./framework.mjs";
import { sql, newClient } from "./fixtures.mjs";
import { seedTwoVendors, makeAuthUser } from "./seed.mjs";

let seq = 0;
async function world() {
  const w = await seedTwoVendors();
  const n = ++seq;
  const owner = await makeAuthUser(`owner-${n}@example.test`, "Owner");
  await sql(`insert into platform_owners (user_id, name) values ($1,'Owner')`, [owner.id]);
  const outsider = await makeAuthUser(`outsider-${n}@example.test`, "Nobody");
  return { ...w, owner, outsider };
}
const getW = once(world);
// The local harness (tests/client.mjs) unwraps a non-setof function's single row to an
// object keyed by the return column (real PostgREST returns the bare scalar for a
// scalar-returning function); pull the value out either way.
const scalarOf = (data) =>
  data !== null && typeof data === "object" ? data[Object.keys(data)[0]] : data;
const roleOf = async (client) => scalarOf((await client.rpc("current_user_role")).data);

test("an owner reads only their own platform_owners row; staff and outsiders see none", async () => {
  const w = await getW();
  const { data } = await w.owner.client.from("platform_owners").select("user_id");
  assertEqual(data.length, 1, "owner sees own row");
  assertEqual(data[0].user_id, w.owner.id, "own row");
  assertInvisible((await w.a.clients.admin.from("platform_owners").select("user_id")).data, "admin read owners");
  assertInvisible((await w.outsider.client.from("platform_owners").select("user_id")).data, "outsider read owners");
  const anon = await newClient();
  assertInvisible((await anon.from("platform_owners").select("user_id")).data, "anon read owners");
});

test("nobody can insert into platform_owners from a client", async () => {
  const w = await getW();
  for (const c of [w.owner.client, w.a.clients.admin, w.outsider.client]) {
    const { error } = await c.from("platform_owners").insert({ user_id: w.outsider.id, name: "X" });
    assertDenied(error, "client inserted an owner");
  }
});

test("is_platform_owner answers for the caller", async () => {
  const w = await getW();
  assertEqual(scalarOf((await w.owner.client.rpc("is_platform_owner")).data), true, "owner");
  assertEqual(scalarOf((await w.a.clients.admin.rpc("is_platform_owner")).data), false, "admin");
  assertEqual(scalarOf((await w.outsider.client.rpc("is_platform_owner")).data), false, "outsider");
});

test("a shop admin cannot suspend or reinstate their own shop", async () => {
  const w = await getW();
  const { error } = await w.a.clients.admin.from("vendors").update({ suspended_at: new Date().toISOString() }).eq("id", w.a.vendorId).select("id");
  const { rows: [v] } = await sql(`select suspended_at from vendors where id=$1`, [w.a.vendorId]);
  assertEqual(v.suspended_at, null, "admin set suspended_at");
  if (error) assert(/only the platform owner/.test(error.message) || error.code === "42501", error.message);
});

test("suspension flips current_user_role to the sentinel and blocks every write path; the other shop is untouched", async () => {
  const w = await getW();
  assertEqual(await roleOf(w.a.clients.recorder), "recorder", "before");
  await sql(`update vendors set suspended_at = now() where id=$1`, [w.a.vendorId]);   // owner-role SQL stands in for the Edge Function
  try {
    assertEqual(await roleOf(w.a.clients.recorder), "suspended", "sentinel");
    assertEqual(await roleOf(w.a.clients.admin), "suspended", "admin sentinel");
    // Reads still work until the token lapses; the spec accepts this window.
    const { data: items } = await w.a.clients.recorder.from("items").select("id");
    assert(items.length >= 1, "reads should still return the shop's rows");
    // Writes refused.
    const cust = await w.a.clients.recorder.from("customers").insert({ vendor_id: w.a.vendorId, name: "S", flat_no: "1", mobile: "+919000000001" });
    assertDenied(cust.error, "suspended recorder created a customer");
    const bill = await w.a.clients.recorder.from("bills").insert({ vendor_id: w.a.vendorId, customer_id: w.a.customerId, recorder_id: w.a.recorderId, status: "recording" });
    assertDenied(bill.error, "suspended recorder opened a bill");
    const item = await w.a.clients.admin.from("items").update({ price: 1 }).eq("id", w.a.itemId).select("id");
    assert(item.error || item.data.length === 0, "suspended admin changed a price");
    // A bill created BEFORE suspension cannot move through the lifecycle.
    const { rows: [b] } = await sql(`insert into bills (vendor_id, customer_id, recorder_id, total, status) values ($1,$2,$3,0,'recording') returning id`, [w.a.vendorId, w.a.customerId, w.a.recorderId]);
    const lines = await w.a.clients.recorder.rpc("replace_bill_lines", { p_bill_id: b.id, p_lines: [{ item_id: w.a.itemId, qty_kg: 1, unit_price: 40 }] });
    assertDenied(lines.error, "suspended recorder wrote lines");
    await sql(`insert into bill_items (bill_id, vendor_id, item_id, qty_kg, unit_price, line_total) values ($1,$2,$3,1,40,40)`, [b.id, w.a.vendorId, w.a.itemId]);
    const tok = await w.a.clients.recorder.rpc("issue_token", { p_bill_id: b.id });
    assertDenied(tok.error, "suspended recorder issued a token");
    await sql(`select issue_token($1)`, [b.id]);
    const done = await w.a.clients.biller.rpc("complete_bill", { p_bill_id: b.id });
    assertDenied(done.error, "suspended biller completed a bill");
    const mv = await w.a.clients.recorder.rpc("log_stock_movement", { p_item_id: w.a.itemId, p_kind: "purchase", p_qty_kg: 1, p_unit_cost: 1 });
    assertDenied(mv.error, "suspended recorder logged stock");
    // Vendor B carries on.
    const ok = await w.b.clients.recorder.from("customers").insert({ vendor_id: w.b.vendorId, name: "Fine", flat_no: "2", mobile: "+919000000002" });
    assert(!ok.error, `vendor B blocked: ${ok.error?.message}`);
  } finally {
    await sql(`update vendors set suspended_at = null where id=$1`, [w.a.vendorId]);
  }
  assertEqual(await roleOf(w.a.clients.recorder), "recorder", "reinstated");
  const again = await w.a.clients.recorder.from("customers").insert({ vendor_id: w.a.vendorId, name: "Back", flat_no: "3", mobile: "+919000000003" });
  assert(!again.error, `reinstated recorder still blocked: ${again.error?.message}`);
});

test("void_bill is refused for a suspended shop", async () => {
  const w = await getW();
  const { rows: [b] } = await sql(`insert into bills (vendor_id, customer_id, total, status) values ($1,$2,0,'recording') returning id`, [w.a.vendorId, w.a.customerId]);
  await sql(`insert into bill_items (bill_id, vendor_id, item_id, qty_kg, unit_price, line_total) values ($1,$2,$3,1,40,40)`, [b.id, w.a.vendorId, w.a.itemId]);
  await sql(`select issue_token($1)`, [b.id]); await sql(`select complete_bill($1)`, [b.id]);
  await sql(`update vendors set suspended_at = now() where id=$1`, [w.a.vendorId]);
  try {
    const { error } = await w.a.clients.admin.rpc("void_bill", { p_bill_id: b.id, p_reason: "x" });
    assertDenied(error, "suspended admin voided a bill");
  } finally { await sql(`update vendors set suspended_at = null where id=$1`, [w.a.vendorId]); }
});

test("owner_vendor_summary refuses staff and outsiders", async () => {
  const w = await getW();
  assertDenied((await w.a.clients.admin.rpc("owner_vendor_summary")).error, "admin read the summary");
  assertDenied((await w.outsider.client.rpc("owner_vendor_summary")).error, "outsider read the summary");
});

test("owner_vendor_summary lists every vendor with staff, this-month bills and sales", async () => {
  const w = await getW();
  // One done bill in vendor A this month: 2 x 40 = 80.
  const { rows: [b] } = await sql(`insert into bills (vendor_id, customer_id, total, status) values ($1,$2,0,'recording') returning id`, [w.a.vendorId, w.a.customerId]);
  await sql(`insert into bill_items (bill_id, vendor_id, item_id, qty_kg, unit_price, line_total) values ($1,$2,$3,2,40,80)`, [b.id, w.a.vendorId, w.a.itemId]);
  await sql(`select issue_token($1)`, [b.id]); await sql(`select complete_bill($1)`, [b.id]);
  // An old bill last month must not count.
  await sql(`insert into bills (vendor_id, customer_id, total, status, completed_at) values ($1,$2,999,'done', (date_trunc('month', now() at time zone 'Asia/Kolkata') - interval '1 day') at time zone 'Asia/Kolkata')`, [w.a.vendorId, w.a.customerId]);
  const { data, error } = await w.owner.client.rpc("owner_vendor_summary");
  assert(!error, error?.message);
  const a = data.find((r) => r.id === w.a.vendorId);
  const bRow = data.find((r) => r.id === w.b.vendorId);
  assert(a && bRow, "both seeded vendors listed");
  assertEqual(Number(a.staff_count), 3, "A has admin, recorder, biller");
  assert(Number(a.bills_month) >= 1, "this month's bill counted");
  assert(Number(a.sales_month) >= 80 && Number(a.sales_month) < 999, "sales exclude last month's 999");
  assert(a.last_bill_at !== null, "last_bill_at");
  assertEqual(a.suspended_at, null, "not suspended");
  assertEqual(Number(bRow.staff_count), 3, "B has admin, recorder, biller");
});
