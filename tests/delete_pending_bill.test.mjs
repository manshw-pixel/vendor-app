import { test, assert, assertDenied, assertEqual, once } from "./framework.mjs";
import { sql } from "./fixtures.mjs";
import { seedTwoVendors } from "./seed.mjs";

const getWorld = once(seedTwoVendors);

async function billed(v, { status = "billed" } = {}) {
  const { rows: [b] } = await sql(
    `insert into bills (vendor_id, customer_id, recorder_id, total, status)
     values ($1,$2,$3,0,'recording') returning id`, [v.vendorId, v.customerId, v.recorderId]);
  await sql(`insert into bill_items (bill_id, vendor_id, item_id, qty_kg, unit_price, line_total)
             values ($1,$2,$3,1,40,40)`, [b.id, v.vendorId, v.itemId]);
  if (status !== "recording") await sql(`select issue_token($1)`, [b.id]);
  if (status === "done") await sql(`select complete_bill($1, null, 0, 'cash')`, [b.id]);
  return b.id;
}
const lastToken = async (v) => Number((await sql(
  `select last_token from vendor_counters where vendor_id=$1`, [v.vendorId])).rows[0].last_token);
const tokenOf = async (id) => (await sql(`select token_no from bills where id=$1`, [id])).rows[0]?.token_no;
const exists = async (id) => (await sql(`select 1 from bills where id=$1`, [id])).rows.length === 1;
const del = (client, id) => client.rpc("delete_pending_bill", { p_bill_id: id });

test("a biller deletes the latest pending bill and the token is reused", async () => {
  const w = await getWorld();
  const id = await billed(w.a);
  const t = await tokenOf(id);
  const { error } = await del(w.a.clients.biller, id);
  assert(!error, error?.message);
  assert(!(await exists(id)), "bill still there");
  assertEqual(await lastToken(w.a), t - 1, "counter rolled back");
  const next = await billed(w.a);
  assertEqual(await tokenOf(next), t, "token reused");
});

test("an admin may delete; lines and pending message go with the bill", async () => {
  const w = await getWorld();
  const id = await billed(w.a);
  const { error } = await del(w.a.clients.admin, id);
  assert(!error, error?.message);
  assertEqual((await sql(`select count(*)::int n from bill_items where bill_id=$1`, [id])).rows[0].n, 0, "lines");
  assertEqual((await sql(`select count(*)::int n from outbound_messages where bill_id=$1`, [id])).rows[0].n, 0, "messages");
});

test("deleting an older token leaves a gap", async () => {
  const w = await getWorld();
  const older = await billed(w.a);
  const newer = await billed(w.a);
  const before = await lastToken(w.a);
  const { error } = await del(w.a.clients.biller, older);
  assert(!error, error?.message);
  assert(!(await exists(older)), "older bill still there");
  assertEqual(await lastToken(w.a), before, "counter unchanged");
  assert(await exists(newer), "newer bill kept");
});

test("two latest deletes in a row roll back to the highest surviving token", async () => {
  const w = await getWorld();
  const keep = await billed(w.a);
  const mid = await billed(w.a);
  const top = await billed(w.a);
  await del(w.a.clients.biller, mid);   // gap; counter stays at top
  await del(w.a.clients.biller, top);   // latest; counter drops past the gap
  assertEqual(await lastToken(w.a), await tokenOf(keep), "counter at highest surviving token");
});

test("a recording bill (no token) may be deleted without touching the counter", async () => {
  const w = await getWorld();
  await billed(w.a);
  const before = await lastToken(w.a);
  const id = await billed(w.a, { status: "recording" });
  const { error } = await del(w.a.clients.biller, id);
  assert(!error, error?.message);
  assertEqual(await lastToken(w.a), before, "counter");
});

test("a recorder may not delete", async () => {
  const w = await getWorld();
  const id = await billed(w.a);
  assertDenied((await del(w.a.clients.recorder, id)).error, "recorder deleted");
  assert(await exists(id), "bill gone");
});

test("another shop's bill may not be deleted", async () => {
  const w = await getWorld();
  const id = await billed(w.b);
  assertDenied((await del(w.a.clients.biller, id)).error, "cross-vendor delete");
  assert(await exists(id), "bill gone");
});

test("a done bill may not be deleted", async () => {
  const w = await getWorld();
  const id = await billed(w.a, { status: "done" });
  assertDenied((await del(w.a.clients.biller, id)).error, "done bill deleted");
  assert(await exists(id), "bill gone");
});
