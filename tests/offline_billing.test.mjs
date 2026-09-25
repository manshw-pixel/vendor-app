import { test, assert, assertEqual } from "./framework.mjs";
import { sql } from "./fixtures.mjs";
import { seedTwoVendors } from "./seed.mjs";

test("_complete_bill_core is not callable by a signed-in user", async () => {
  const { rows } = await sql(`select count(*)::int n from pg_proc where proname = '_complete_bill_core'`);
  assertEqual(rows[0].n, 1, "core exists");

  const w = await seedTwoVendors();
  const { error } = await w.a.clients.admin.rpc("_complete_bill_core", {
    p_bill_id: "00000000-0000-0000-0000-000000000000", p_biller_id: null, p_redeem_points: 0,
    p_payment_mode: "cash", p_collect_due: 0, p_at: new Date().toISOString(), p_notify: false,
  });
  assert(error, "must be refused");
  assert(/permission denied|not find|does not exist/i.test(error.message), error.message);
});
