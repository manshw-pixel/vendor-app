import { test, assert, assertDenied, assertEqual, assertInvisible, once } from "./framework.mjs";
import { sql } from "./fixtures.mjs";
import { seedTwoVendors } from "./seed.mjs";

const getWorld = once(seedTwoVendors);

// A bill in `billed` status (token issued), for vendor v's seeded item. qty x price is
// the payable total when nothing is redeemed.
async function billedBill(v, { qty = 5, price = 40 } = {}) {
  const { rows: [b] } = await sql(
    `insert into bills (vendor_id, customer_id, recorder_id, total, status)
     values ($1,$2,$3,0,'recording') returning id`, [v.vendorId, v.customerId, v.recorderId]);
  await sql(`insert into bill_items (bill_id, vendor_id, item_id, qty_kg, unit_price, line_total)
             values ($1,$2,$3,$4,$5,$6)`, [b.id, v.vendorId, v.itemId, qty, price, qty * price]);
  await sql(`select issue_token($1)`, [b.id]);
  return b.id;
}
const payments = async (billId) => (await sql(
  `select mode, amount, created_by from bill_payments where bill_id = $1`, [billId])).rows;
const status = async (billId) => (await sql(`select status from bills where id = $1`, [billId])).rows[0].status;

test("completing with a mode writes one payment row for the amount collected", async () => {
  const w = await getWorld();
  const id = await billedBill(w.a);   // 5 x 40 = 200
  const { error } = await w.a.clients.biller.rpc("complete_bill", { p_bill_id: id, p_payment_mode: "upi" });
  assert(!error, `refused: ${error?.message}`);
  const rows = await payments(id);
  assertEqual(rows.length, 1, "one payment row");
  assertEqual(rows[0].mode, "upi", "mode");
  assertEqual(Number(rows[0].amount), 200, "amount");
  assertEqual(rows[0].created_by, w.a.billerId, "created_by is the caller");
});

test("a missing mode is refused and nothing moves", async () => {
  const w = await getWorld();
  const id = await billedBill(w.a);
  const { error } = await w.a.clients.biller.rpc("complete_bill", { p_bill_id: id });
  assert(error && /payment mode is required/.test(error.message), `expected a refusal, got ${error?.message ?? "success"}`);
  assertEqual(await status(id), "billed", "bill must stay pending");
  assertEqual((await payments(id)).length, 0, "no payment row");
});

test("an unknown mode is refused", async () => {
  const w = await getWorld();
  const id = await billedBill(w.a);
  const { error } = await w.a.clients.biller.rpc("complete_bill", { p_bill_id: id, p_payment_mode: "cheque" });
  assert(error && /payment mode is required/.test(error.message), `expected a refusal, got ${error?.message ?? "success"}`);
  assertEqual(await status(id), "billed", "bill must stay pending");
});

test("the amount is what was collected after points, including zero", async () => {
  const w = await getWorld();
  await sql(`insert into points_ledger (vendor_id, customer_id, points, expires_at)
             values ($1,$2,500, now() + interval '30 days')`, [w.a.vendorId, w.a.customerId]);
  const partly = await billedBill(w.a);            // 200, redeem 50
  await sql(`select complete_bill($1, null, 50, 'cash')`, [partly]);
  assertEqual(Number((await payments(partly))[0].amount), 150, "200 - 50 points");
  const wholly = await billedBill(w.a, { qty: 1 }); // 40, redeem 40
  await sql(`select complete_bill($1, null, 40, 'cash')`, [wholly]);
  const rows = await payments(wholly);
  assertEqual(rows.length, 1, "a fully-redeemed bill still records its mode");
  assertEqual(Number(rows[0].amount), 0, "amount 0");
});

test("a retried completion writes no second payment row", async () => {
  const w = await getWorld();
  const id = await billedBill(w.a);
  await sql(`select complete_bill($1, p_payment_mode => 'cash')`, [id]);
  await sql(`select complete_bill($1, p_payment_mode => 'upi')`, [id]);
  const rows = await payments(id);
  assertEqual(rows.length, 1, "still one row");
  assertEqual(rows[0].mode, "cash", "the first completion's mode stands");
});

test("nobody may write a payment directly", async () => {
  const w = await getWorld();
  const id = await billedBill(w.a);
  for (const role of ["admin", "biller", "recorder"]) {
    const { error } = await w.a.clients[role].from("bill_payments").insert({
      vendor_id: w.a.vendorId, bill_id: id, mode: "cash", amount: 1,
    });
    assertDenied(error, `${role} inserted a payment`);
  }
});

test("payments are invisible across vendors", async () => {
  const w = await getWorld();
  const id = await billedBill(w.b);
  await sql(`select complete_bill($1, p_payment_mode => 'cash')`, [id]);
  const { data } = await w.a.clients.admin.from("bill_payments").select("*").eq("bill_id", id);
  assertInvisible(data, "A saw B's payment");
});

test("a voided bill keeps its payment row", async () => {
  const w = await getWorld();
  const id = await billedBill(w.a);
  await sql(`select complete_bill($1, p_payment_mode => 'cash')`, [id]);
  const { error } = await w.a.clients.biller.rpc("void_bill", { p_bill_id: id, p_reason: "wrong customer" });
  assert(!error, error?.message);
  assertEqual((await payments(id)).length, 1, "payment row kept");
});

test("payment_split_between groups by mode, skips voided bills and reports unrecorded", async () => {
  // Its own world: the split sums the whole shop's window.
  const w = await seedTwoVendors();
  const done = async (mode, qty) => {
    const id = await billedBill(w.a, { qty });
    await sql(`select complete_bill($1, p_payment_mode => $2)`, [id, mode]);
    return id;
  };
  await done("cash", 5);                       // 200
  await done("cash", 1);                       // 40
  await done("upi", 2);                        // 80
  const voided = await done("cash", 3);        // 120, voided below
  await w.a.clients.biller.rpc("void_bill", { p_bill_id: voided, p_reason: "test" });
  const old = await done("card", 4);           // 160, then its payment removed: a pre-0021 bill
  await sql(`delete from bill_payments where bill_id = $1`, [old]);

  const { data, error } = await w.a.clients.admin.rpc("payment_split_between", {
    p_from: new Date(Date.now() - 3600e3).toISOString(),
    p_to: new Date(Date.now() + 3600e3).toISOString(),
  });
  assert(!error, error?.message);
  assertEqual(
    data.map((r) => [r.mode, Number(r.total), Number(r.bill_count)]),
    [["cash", 240, 2], ["unrecorded", 160, 1], ["upi", 80, 1]],
    "split",
  );
  const { data: other } = await w.b.clients.admin.rpc("payment_split_between", {
    p_from: new Date(Date.now() - 3600e3).toISOString(),
    p_to: new Date(Date.now() + 3600e3).toISOString(),
  });
  assertEqual(other, [], "B sees none of A's split");
});
