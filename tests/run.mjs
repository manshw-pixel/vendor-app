// The exit code IS the gate. Never pipe this.
import { CASES } from "./framework.mjs";
import { bootstrap } from "./fixtures.mjs";

import "./guard.test.mjs";
import "./smoke.test.mjs";
import "./schema.test.mjs";
import "./rls.test.mjs";
import "./issue_token.test.mjs";
import "./complete_bill.test.mjs";
import "./points_balance.test.mjs";
import "./views.test.mjs";
import "./expiry.test.mjs";

try {
  await bootstrap();
} catch (e) {
  console.error("\nBootstrap failed, so no test ran.\n");
  console.error(e.stack || e.message);
  console.error(
    "\nThis suite runs against a Supabase Cloud project set aside for tests -- there is\n" +
    "no local stack. If that reads as a connection failure, check:\n" +
    "  - the five variables in .env.example are exported (SUPABASE_DB_URL, SUPABASE_API_URL,\n" +
    "    SUPABASE_TEST_PROJECT_REF, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY);\n" +
    "  - SUPABASE_DB_URL is a session-mode connection on port 5432, not the transaction\n" +
    "    pooler on 6543 -- the reset sends multi-statement DDL;\n" +
    "  - the test project is not paused (free-tier projects pause after inactivity).\n" +
    "If it reads as a refusal instead, the guard is doing its job: it will only reset the\n" +
    "project named by SUPABASE_TEST_PROJECT_REF."
  );
  process.exit(2);
}

let pass = 0, fail = 0;
for (const c of CASES) {
  try { await c.fn(); console.log("PASS", c.name); pass++; }
  catch (e) { console.error("FAIL", c.name, "\n  ", e.message); fail++; }
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
