import { test, assert, assertDenied, assertEqual, once } from "./framework.mjs";
import { sql } from "./fixtures.mjs";
import { seedTwoVendors } from "./seed.mjs";

const getWorld = once(seedTwoVendors);

async function item(v, { name = "RL Tomato", price = 40, unit = "kg" } = {}) {
  const { rows: [i] } = await sql(
    `insert into items (vendor_id, name_en, name_hi, name_mr, price, stock_kg, unit, last_cost)
     values ($1,$2,'टमाटर','टोमॅटो',$3,50,$4,20) returning id`, [v.vendorId, name, price, unit]);
  return i.id;
}
const priceOf = async (id) => Number((await sql(`select price from items where id=$1`, [id])).rows[0].price);
const apply = (client, rows) => client.rpc("apply_price_list", { p_rows: rows });

test("an admin updates prices; changes are logged and returned", async () => {
  const w = await getWorld();
  const a = await item(w.a, { name: "RL Onion A", price: 40 });
  const b = await item(w.a, { name: "RL Onion B", price: 30 });
  const { data, error } = await apply(w.a.clients.admin, [
    { kind: "update", item_id: a, price: 44 },
    { kind: "update", item_id: b, price: 30 },
  ]);
  assert(!error, error?.message);
  assertEqual(await priceOf(a), 44, "a repriced");
  assertEqual(data.updated.length, 1, "one updated");
  assertEqual(Number(data.updated[0].old_price), 40, "old price");
  assertEqual(Number(data.updated[0].new_price), 44, "new price");
  assertEqual(data.unchanged, 1, "one unchanged");
  const { rows } = await sql(`select old_price::float8 o, new_price::float8 n, source, changed_by from price_changes where item_id=$1`, [a]);
  assertEqual(rows.length, 1, "logged once");
  assertEqual(rows[0].source, "rate_list", "source");
  assertEqual(rows[0].changed_by, w.a.adminId, "changed_by");
  assertEqual((await sql(`select count(*)::int n from price_changes where item_id=$1`, [b])).rows[0].n, 0, "unchanged not logged");
});

test("a new item is created with cost = price, stock 30 and low stock 10", async () => {
  const w = await getWorld();
  const { data, error } = await apply(w.a.clients.admin, [{
    kind: "create", names: { name_en: "RL Kiwi", name_hi: "कीवी", name_mr: "किवी" },
    unit: "piece", price: 25, alias: "Kiwi (imported)",
  }]);
  assert(!error, error?.message);
  const id = data.created[0].item_id;
  const { rows: [i] } = await sql(
    `select price::float8 p, last_cost::float8 c, stock_kg::float8 s, low_stock_at::float8 l, unit from items where id=$1`, [id]);
  assertEqual(i.p, 25, "price"); assertEqual(i.c, 25, "cost = price");
  assertEqual(i.s, 30, "stock 30"); assertEqual(i.l, 10, "low 10"); assertEqual(i.unit, "piece", "unit");
  const { rows: al } = await sql(`select item_id from item_aliases where vendor_id=$1 and lower(alias)=lower('kiwi (IMPORTED)')`, [w.a.vendorId]);
  assertEqual(al[0].item_id, id, "alias saved");
});

test("an alias is saved on update and re-pointed if reused", async () => {
  const w = await getWorld();
  const a = await item(w.a, { name: "RL Brinjal A" });
  const b = await item(w.a, { name: "RL Brinjal B" });
  await apply(w.a.clients.admin, [{ kind: "update", item_id: a, price: 41, alias: "Baingan" }]);
  await apply(w.a.clients.admin, [{ kind: "update", item_id: b, price: 41, alias: "baingan" }]);
  const { rows } = await sql(`select item_id from item_aliases where vendor_id=$1 and lower(alias)='baingan'`, [w.a.vendorId]);
  assertEqual(rows.length, 1, "one alias row");
  assertEqual(rows[0].item_id, b, "re-pointed");
});

test("staff can read their shop's aliases, not another shop's", async () => {
  const w = await getWorld();
  const b = await item(w.b, { name: "RL Other" });
  await sql(`insert into item_aliases (vendor_id, item_id, alias) values ($1,$2,'RL other alias')`, [w.b.vendorId, b]);
  const { data } = await w.a.clients.recorder.from("item_aliases").select("alias");
  assert(!(data ?? []).some((r) => r.alias === "RL other alias"), "saw another shop's alias");
});

test("a pending bill is repriced through the 0025 trigger", async () => {
  const w = await getWorld();
  const a = await item(w.a, { name: "RL Pending", price: 40 });
  const { rows: [bill] } = await sql(
    `insert into bills (vendor_id, customer_id, recorder_id, total, status) values ($1,$2,$3,0,'recording') returning id`,
    [w.a.vendorId, w.a.customerId, w.a.recorderId]);
  await sql(`insert into bill_items (bill_id, vendor_id, item_id, qty_kg, unit_price, line_total) values ($1,$2,$3,2,40,80)`,
    [bill.id, w.a.vendorId, a]);
  await sql(`select issue_token($1)`, [bill.id]);
  await apply(w.a.clients.admin, [{ kind: "update", item_id: a, price: 50 }]);
  assertEqual(Number((await sql(`select total from bills where id=$1`, [bill.id])).rows[0].total), 100, "bill total");
});

test("a biller or recorder may not apply", async () => {
  const w = await getWorld();
  const a = await item(w.a, { name: "RL Guard", price: 40 });
  assertDenied((await apply(w.a.clients.biller, [{ kind: "update", item_id: a, price: 1 }])).error, "biller applied");
  assertDenied((await apply(w.a.clients.recorder, [{ kind: "update", item_id: a, price: 1 }])).error, "recorder applied");
  assertEqual(await priceOf(a), 40, "price changed");
});

test("another shop's item id refuses the whole list", async () => {
  const w = await getWorld();
  const mine = await item(w.a, { name: "RL Mine", price: 40 });
  const theirs = await item(w.b, { name: "RL Theirs", price: 40 });
  const { error } = await apply(w.a.clients.admin, [
    { kind: "update", item_id: mine, price: 45 },
    { kind: "update", item_id: theirs, price: 45 },
  ]);
  assertDenied(error, "cross-shop update");
  assertEqual(await priceOf(mine), 40, "partial apply");
  assertEqual(await priceOf(theirs), 40, "other shop changed");
});

test("an invalid row (zero price, missing name, bad unit) rolls back everything", async () => {
  const w = await getWorld();
  const a = await item(w.a, { name: "RL Rollback", price: 40 });
  for (const bad of [
    { kind: "update", item_id: a, price: 0 },
    { kind: "create", names: { name_en: "RL X", name_hi: "", name_mr: "एक्स" }, unit: "kg", price: 10 },
    { kind: "create", names: { name_en: "RL Y", name_hi: "वाई", name_mr: "वाय" }, unit: "box", price: 10 },
    { kind: "delete", item_id: a },
  ]) {
    const { error } = await apply(w.a.clients.admin, [{ kind: "update", item_id: a, price: 41 }, bad]);
    assertDenied(error, `accepted ${JSON.stringify(bad)}`);
    assertEqual(await priceOf(a), 40, "partial apply");
  }
  assertEqual((await sql(`select count(*)::int n from items where name_en in ('RL X','RL Y')`)).rows[0].n, 0, "item created");
});
