// The exit code IS the gate. Never pipe this.
import { CASES } from "./framework.mjs";
import { bootstrap, SKIPPED } from "./fixtures.mjs";

import "./guard.test.mjs";
import "./smoke.test.mjs";
import "./schema.test.mjs";
import "./rls.test.mjs";
import "./issue_token.test.mjs";
import "./complete_bill.test.mjs";
import "./points_balance.test.mjs";
import "./views.test.mjs";
import "./analytics.test.mjs";
import "./expiry.test.mjs";
import "./must_change_password.test.mjs";

try {
  await bootstrap();
} catch (e) {
  console.error("\nBootstrap failed, so no test ran.\n");
  console.error(e.stack || e.message);
  console.error(
    "\nThis suite runs against the machine's NATIVE PostgreSQL -- no Docker, no Supabase\n" +
    "CLI stack. If that reads as a connection failure, check:\n" +
    "  - the postgresql-x64-17 service is running;\n" +
    "  - the vendor_app_test database exists;\n" +
    "  - SUPABASE_DB_URL points at it, if you set it at all.\n" +
    "If it reads as a refusal instead, the guard is doing its job: it resets\n" +
    "vendor_app_test on a loopback server, and nothing else."
  );
  process.exit(2);
}

// Printed before the results, not after: a green run must not be read as covering more
// than it did.
if (SKIPPED.length) {
  console.log("Not applied on this stack:");
  for (const line of SKIPPED) console.log("  -", line);
  console.log();
}

let pass = 0, fail = 0;
for (const c of CASES) {
  try { await c.fn(); console.log("PASS", c.name); pass++; }
  catch (e) { console.error("FAIL", c.name, "\n  ", e.message); fail++; }
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
