import { test, assert, assertEqual, assertDenied, once } from "./framework.mjs";
import { sql, DB_URL } from "./fixtures.mjs";
import { seedTwoVendors } from "./seed.mjs";
import pg from "pg";

const getWorld = once(seedTwoVendors);

// The claim is the only part of the WhatsApp drain that a database can test. Everything
// past it -- Twilio, the Edge Function -- has no runtime here; see README.

// Other test files leave their own rows in this queue (issue_token queues one on every
// bill). A claim is global by design -- the service role drains every tenant at once --
// so each case below starts from an empty queue or it would be asserting about their
// rows as much as its own.
async function clearQueue() {
  await sql(`update outbound_messages set status = 'sent' where status in ('pending','sending')`);
}

async function freshVendor() {
  const { rows: [v] } = await sql(`insert into vendors (name) values ('Drain Co') returning id`);
  const { rows: [c] } = await sql(
    `insert into customers (vendor_id, name, flat_no, mobile)
     values ($1,'Dee','D-1','9876543210') returning id`, [v.id]);
  await clearQueue();
  return { vendorId: v.id, customerId: c.id };
}

async function queue(vendorId, customerId, n) {
  const ids = [];
  for (let i = 0; i < n; i++) {
    const { rows: [m] } = await sql(
      `insert into outbound_messages (vendor_id, customer_id, template_key, payload)
       values ($1,$2,'token_issued', jsonb_build_object('token_no', $3::int, 'total', 100))
       returning id`, [vendorId, customerId, i + 1]);
    ids.push(m.id);
  }
  return ids;
}

test("claim_outbound_messages returns queued rows with the customer's mobile", async () => {
  const w = await freshVendor();
  await queue(w.vendorId, w.customerId, 1);
  const { rows } = await sql(`select * from claim_outbound_messages(20)`);
  const mine = rows.filter(r => r.template_key === "token_issued" && r.mobile === "9876543210");
  assertEqual(mine.length, 1, "expected the queued row back with its mobile");
  assert(mine[0].payload.token_no === 1, "payload did not come back intact");
});

test("claiming marks the row sending and increments attempts", async () => {
  const w = await freshVendor();
  const [id] = await queue(w.vendorId, w.customerId, 1);
  await sql(`select * from claim_outbound_messages(20)`);
  const { rows: [m] } = await sql(`select status, attempts from outbound_messages where id = $1`, [id]);
  assertEqual(m.status, "sending", "row was not marked sending");
  assertEqual(m.attempts, 1, "attempts was not incremented before the send");
});

test("a second claim does not return an already-claimed row", async () => {
  // The whole point: two overlapping invocations must not both message the customer.
  const w = await freshVendor();
  const [id] = await queue(w.vendorId, w.customerId, 1);
  await sql(`select * from claim_outbound_messages(20)`);
  const { rows } = await sql(`select * from claim_outbound_messages(20)`);
  assert(!rows.some(r => r.id === id), "the same row was claimed twice");
});

test("two concurrent claims take disjoint rows and lose none", async () => {
  // `for update skip locked` proved by mutation, not assumed: without it one of these
  // two transactions blocks and then re-reads the other's rows.
  const w = await freshVendor();
  const ids = await queue(w.vendorId, w.customerId, 6);
  const a = new pg.Client({ connectionString: DB_URL });
  const b = new pg.Client({ connectionString: DB_URL });
  await a.connect(); await b.connect();
  try {
    await a.query("begin"); await b.query("begin");
    const [ra, rb] = await Promise.all([
      a.query(`select id from claim_outbound_messages(3)`),
      b.query(`select id from claim_outbound_messages(3)`),
    ]);
    await a.query("commit"); await b.query("commit");
    const got = [...ra.rows, ...rb.rows].map(r => r.id).filter(id => ids.includes(id));
    assertEqual(new Set(got).size, got.length, "the two claims overlapped");
    assertEqual(got.length, 6, "some rows were lost between the two claims");
  } finally {
    await a.end(); await b.end();
  }
});

test("claim respects its limit", async () => {
  const w = await freshVendor();
  await queue(w.vendorId, w.customerId, 5);
  const { rows } = await sql(`select * from claim_outbound_messages(2)`);
  assertEqual(rows.length, 2, "limit was not honoured");
});

test("claim takes the oldest message first", async () => {
  // A customer's token must not sit behind a newer one; the queue is a queue.
  const w = await freshVendor();
  const { rows: [old] } = await sql(
    `insert into outbound_messages (vendor_id, customer_id, template_key, created_at)
     values ($1,$2,'token_issued', now() - interval '1 hour') returning id`,
    [w.vendorId, w.customerId]);
  await queue(w.vendorId, w.customerId, 1);
  const { rows } = await sql(`select * from claim_outbound_messages(1)`);
  assertEqual(rows[0].id, old.id, "the newer message was claimed first");
});

test("a sent message is never claimed again", async () => {
  const w = await freshVendor();
  const [id] = await queue(w.vendorId, w.customerId, 1);
  await sql(`update outbound_messages set status = 'sent' where id = $1`, [id]);
  const { rows } = await sql(`select * from claim_outbound_messages(20)`);
  assert(!rows.some(r => r.id === id), "a sent message was re-claimed");
});

test("a message that has used up its attempts is left alone", async () => {
  // Five failures is the point at which retrying stops and a human is meant to look.
  const w = await freshVendor();
  const [id] = await queue(w.vendorId, w.customerId, 1);
  await sql(`update outbound_messages set attempts = 5 where id = $1`, [id]);
  const { rows } = await sql(`select * from claim_outbound_messages(20)`);
  assert(!rows.some(r => r.id === id), "an exhausted message was claimed again");
});

test("a row stranded in sending is reclaimed after five minutes", async () => {
  // An invocation that dies mid-send leaves the row owned by nobody. Without this the
  // customer's token would never be sent and nothing would say so.
  const w = await freshVendor();
  const { rows: [m] } = await sql(
    `insert into outbound_messages (vendor_id, customer_id, template_key, status, created_at)
     values ($1,$2,'token_issued','sending', now() - interval '10 minutes') returning id`,
    [w.vendorId, w.customerId]);
  const { rows } = await sql(`select * from claim_outbound_messages(20)`);
  assert(rows.some(r => r.id === m.id), "a stranded row was never reclaimed");
});

test("a row still being sent is not stolen from the live invocation", async () => {
  const w = await freshVendor();
  const { rows: [m] } = await sql(
    `insert into outbound_messages (vendor_id, customer_id, template_key, status)
     values ($1,$2,'token_issued','sending') returning id`, [w.vendorId, w.customerId]);
  const { rows } = await sql(`select * from claim_outbound_messages(20)`);
  assert(!rows.some(r => r.id === m.id), "an in-flight send was claimed by a second run");
});

test("a message whose customer is gone still comes back to be failed", async () => {
  // customer_id is `on delete set null`. An inner join would drop this row, and the
  // claim would pick it up forever without anyone able to resolve it.
  const w = await freshVendor();
  const { rows: [m] } = await sql(
    `insert into outbound_messages (vendor_id, customer_id, template_key)
     values ($1, null, 'token_issued') returning id`, [w.vendorId]);
  const { rows } = await sql(`select * from claim_outbound_messages(20)`);
  const got = rows.find(r => r.id === m.id);
  assert(got, "a customerless message was dropped by the claim");
  assertEqual(got.mobile, null, "expected a null mobile, not a fabricated one");
});

test("no browser session may claim messages", async () => {
  // Same posture as expire_points: the queue is the service role's business. An admin
  // running this would mark their own shop's messages sending and never send them.
  const world = await getWorld();
  await clearQueue();
  for (const role of ["admin", "recorder", "biller"]) {
    const { error } = await world.a.clients[role].rpc("claim_outbound_messages", { p_limit: 5 });
    assertDenied(error, `${role} was able to claim outbound messages`);
  }
});

test("status still refuses a value that is not one of the four", async () => {
  const w = await freshVendor();
  let threw = false;
  try {
    await sql(`insert into outbound_messages (vendor_id, customer_id, template_key, status)
               values ($1,$2,'token_issued','posted')`, [w.vendorId, w.customerId]);
  } catch { threw = true; }
  assert(threw, "the widened check constraint now accepts anything");
});
