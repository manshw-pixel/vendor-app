import { test, assertEqual } from "./framework.mjs";
import { sql } from "./fixtures.mjs";

test("the harness can reach the database", async () => {
  const { rows } = await sql("select 1 as one");
  assertEqual(rows[0].one, 1, "expected a live connection");
});
