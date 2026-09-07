// The exit code IS the gate. Never pipe this.
import { CASES } from "./framework.mjs";
import { bootstrap } from "./fixtures.mjs";

import "./smoke.test.mjs";
import "./schema.test.mjs";
import "./rls.test.mjs";
import "./issue_token.test.mjs";
import "./complete_bill.test.mjs";
import "./points_balance.test.mjs";
import "./views.test.mjs";

try {
  await bootstrap();
} catch (e) {
  console.error("\nBootstrap failed, so no test ran.\n");
  console.error(e.stack || e.message);
  console.error("\nIf that reads as a connection failure: is Docker running, and did you run `supabase start` inside vendor-app/?");
  process.exit(2);
}

let pass = 0, fail = 0;
for (const c of CASES) {
  try { await c.fn(); console.log("PASS", c.name); pass++; }
  catch (e) { console.error("FAIL", c.name, "\n  ", e.message); fail++; }
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
