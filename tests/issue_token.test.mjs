import { test, assert, assertEqual, once } from "./framework.mjs";
import { sql, DB_URL } from "./fixtures.mjs";
import { seedTwoVendors } from "./seed.mjs";
import pg from "pg";

const getWorld = once(seedTwoVendors);

async function freshVendorWithBills(n) {
  const { rows: [v] } = await sql(`insert into vendors (name) values ('Token Co') returning id`);
  const { rows: [c] } = await sql(
    `insert into customers (vendor_id, name, flat_no, mobile)
     values ($1,'Tok','C-1','+919777700001') returning id`, [v.id]);
  const ids = [];
  for (let i = 0; i < n; i++) {
    const { rows: [b] } = await sql(
      `insert into bills (vendor_id, customer_id, total, status)
       values ($1,$2,100,'recording') returning id`, [v.id, c.id]);
    ids.push(b.id);
  }
  return { vendorId: v.id, customerId: c.id, billIds: ids };
}

test("issue_token assigns sequential tokens starting at 1", async () => {
  const w = await freshVendorWithBills(3);
  const got = [];
  for (const id of w.billIds) {
    const { rows } = await sql(`select issue_token($1) as t`, [id]);
    got.push(rows[0].t);
  }
  assertEqual(got, [1, 2, 3], "tokens were not sequential from 1");
});

test("issue_token moves the bill to billed and stamps the token", async () => {
  const w = await freshVendorWithBills(1);
  const { rows: [{ t }] } = await sql(`select issue_token($1) as t`, [w.billIds[0]]);
  const { rows: [b] } = await sql(`select status, token_no from bills where id = $1`, [w.billIds[0]]);
  assertEqual(b.status, "billed", "status did not advance");
  assertEqual(b.token_no, t, "token_no does not match the returned token");
});

test("issue_token queues exactly one token_issued message", async () => {
  const w = await freshVendorWithBills(1);
  await sql(`select issue_token($1)`, [w.billIds[0]]);
  const { rows } = await sql(
    `select template_key, status, payload from outbound_messages
      where vendor_id = $1 and template_key = 'token_issued'`, [w.vendorId]);
  assertEqual(rows.length, 1, "expected one queued message");
  assertEqual(rows[0].status, "pending", "message should start pending");
  assert(rows[0].payload.token_no != null, "payload is missing token_no");
  assert(rows[0].payload.total != null, "payload is missing total");
});

test("issue_token refuses a bill that is not recording", async () => {
  const w = await freshVendorWithBills(1);
  await sql(`select issue_token($1)`, [w.billIds[0]]);
  let threw = false;
  try { await sql(`select issue_token($1)`, [w.billIds[0]]); } catch { threw = true; }
  assert(threw, "issue_token ran twice on the same bill");
});

test("concurrent issue_token calls never collide", async () => {
  // The whole point of UPDATE ... RETURNING over max(token_no)+1: N recorders pressing
  // Done at the same instant must get N distinct tokens.
  const N = 20;
  const w = await freshVendorWithBills(N);
  const clients = [];
  try {
    const results = await Promise.all(w.billIds.map(async (billId) => {
      const c = new pg.Client({ connectionString: DB_URL });
      clients.push(c);
      await c.connect();
      const { rows } = await c.query(`select issue_token($1) as t`, [billId]);
      return rows[0].t;
    }));
    const unique = new Set(results);
    assertEqual(unique.size, N, `expected ${N} distinct tokens, got ${unique.size}`);
    assertEqual([...unique].sort((x, y) => x - y), Array.from({ length: N }, (_, i) => i + 1),
      "tokens are not 1..N");
  } finally {
    await Promise.all(clients.map(c => c.end().catch(() => {})));
  }
});

test("issue_token refuses a bill belonging to another vendor", async () => {
  const world = await getWorld();
  const { rows: [b] } = await sql(
    `insert into bills (vendor_id, customer_id, total, status)
     values ($1,$2,100,'recording') returning id`, [world.b.vendorId, world.b.customerId]);
  // world.a's recorder holds a valid role, but the bill is vendor B's.
  const { error } = await world.a.clients.recorder.rpc("issue_token", { p_bill_id: b.id });
  assert(error, "a recorder issued a token for another vendor's bill");
});

test("issue_token refuses a biller (wrong role)", async () => {
  const world = await getWorld();
  const { rows: [b] } = await sql(
    `insert into bills (vendor_id, customer_id, total, status)
     values ($1,$2,100,'recording') returning id`, [world.a.vendorId, world.a.customerId]);
  const { error } = await world.a.clients.biller.rpc("issue_token", { p_bill_id: b.id });
  assert(error, "a biller issued a token");
});
