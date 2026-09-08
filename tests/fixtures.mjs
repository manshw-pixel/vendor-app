// NOTHING here is mocked. This talks to a real Supabase Cloud project -- Postgres,
// PostgREST and GoTrue -- with the real migrations applied. There is no local stack:
// this project runs entirely on Supabase Cloud, and every URL below must be a Cloud one.
// See docs/superpowers/specs/2026-09-07-vegetable-vendor-app-design.md
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import pg from "pg";

// No defaults. A default is how a suite ends up pointed somewhere nobody chose; every one
// of these must be exported deliberately. bootstrap() reports the missing ones.
export const API_URL = process.env.SUPABASE_API_URL;
export const DB_URL = process.env.SUPABASE_DB_URL;
export const TEST_PROJECT_REF = process.env.SUPABASE_TEST_PROJECT_REF;
export const PROD_PROJECT_REF = process.env.SUPABASE_PROD_PROJECT_REF;
export const PASSWORD = "test-password-123";

// Project keys are per-project and rotate. Take them from the dashboard, or from
// `supabase projects api-keys --project-ref <ref>` -- never from a literal in here.
export const ANON_KEY = process.env.SUPABASE_ANON_KEY;
export const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const MIGRATIONS_DIR = fileURLToPath(new URL("../supabase/migrations/", import.meta.url));

export const newClient = () => createClient(API_URL, ANON_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

// ---------------------------------------------------------------------------
// The reset guard.
//
// resetStack() drops the entire public schema and empties auth.users, against whatever
// $SUPABASE_DB_URL names. With no local stack left there is no "safe by construction"
// host to allow, so the target is identified instead: only the project named by
// $SUPABASE_TEST_PROJECT_REF may be reset. Deploys go elsewhere via `supabase db push`;
// the suite never touches them. Fails closed -- anything this cannot positively identify
// as the test project is refused.
// ---------------------------------------------------------------------------

// Supabase refs are a fixed-length lowercase slug. Anchored, so a ref-shaped fragment of
// some longer label cannot pass for one.
const REF = "[a-z0-9]{20}";

// WHATWG URL gets the credential/host split right; hand-rolled splitting does not, and a
// password containing "@db.<test ref>.supabase.co" is exactly the case that would fool it.
function safeUrl(url) {
  if (typeof url !== "string" || url === "") return null;
  try { return new URL(url); } catch { return null; }
}

// The two Cloud connection shapes carry the ref in different places:
//   direct:  postgresql://postgres:pw@db.<ref>.supabase.co:5432/postgres
//   pooler:  postgresql://postgres.<ref>:pw@aws-0-<region>.pooler.supabase.com:5432/postgres
export function projectRefFromDbUrl(url) {
  const parsed = safeUrl(url);
  if (!parsed) return null;
  const host = parsed.hostname.match(new RegExp(`^db\\.(${REF})\\.supabase\\.co$`));
  if (host) return host[1];
  if (/\.pooler\.supabase\.com$/.test(parsed.hostname)) {
    // decodeURIComponent: the username arrives percent-encoded from some dashboards.
    const user = decodeURIComponent(parsed.username).match(new RegExp(`^postgres\\.(${REF})$`));
    if (user) return user[1];
  }
  return null;
}

export function projectRefFromApiUrl(url) {
  const parsed = safeUrl(url);
  if (!parsed) return null;
  const host = parsed.hostname.match(new RegExp(`^(${REF})\\.supabase\\.(co|in)$`));
  return host ? host[1] : null;
}

const REFUSAL = `
This drops the public schema and deletes every auth user, so it may only ever run against
the disposable Supabase Cloud project set aside for tests. If you are trying to deploy,
that is \`supabase db push\` -- never this suite.
See README.md ("Running the suite") for the variables to export.`;

export function assertTestProject({ dbUrl, apiUrl, testRef, prodRef } = {}) {
  if (!testRef) {
    throw new Error(
      `Refusing to reset: SUPABASE_TEST_PROJECT_REF is not set, so there is no project this
suite is allowed to touch.${REFUSAL}`
    );
  }
  if (prodRef && testRef === prodRef) {
    throw new Error(
      `Refusing to reset: SUPABASE_TEST_PROJECT_REF and SUPABASE_PROD_PROJECT_REF name the
same project (${testRef}). The test project must be a separate, disposable one.${REFUSAL}`
    );
  }

  const dbRef = projectRefFromDbUrl(dbUrl);
  if (!dbRef) {
    throw new Error(
      `Refusing to reset: could not read a Supabase project ref out of SUPABASE_DB_URL
(${JSON.stringify(dbUrl)}). Expected a Cloud connection string -- db.<ref>.supabase.co,
or the pooler with a postgres.<ref> username. There is no local stack any more, so a
127.0.0.1 URL is a leftover export, not a valid target.${REFUSAL}`
    );
  }

  const apiRef = projectRefFromApiUrl(apiUrl);
  if (!apiRef) {
    throw new Error(
      `Refusing to reset: could not read a Supabase project ref out of SUPABASE_API_URL
(${JSON.stringify(apiUrl)}). Expected https://<ref>.supabase.co.${REFUSAL}`
    );
  }

  if (dbRef !== apiRef) {
    throw new Error(
      `Refusing to reset: SUPABASE_DB_URL is project ${dbRef} but SUPABASE_API_URL is
project ${apiRef}. Resetting one project while asserting against another would report
green having wiped something nobody was looking at.${REFUSAL}`
    );
  }

  if (dbRef !== testRef) {
    throw new Error(
      `Refusing to reset project ${dbRef}: it is not SUPABASE_TEST_PROJECT_REF (${testRef}).${REFUSAL}`
    );
  }

  if (prodRef && dbRef === prodRef) {
    throw new Error(
      `Refusing to reset project ${dbRef}: it is SUPABASE_PROD_PROJECT_REF.${REFUSAL}`
    );
  }

  // 6543 is the pooler in transaction mode. It cannot run the multi-statement DDL below,
  // and fails partway through -- leaving a half-dropped schema that reads like a
  // migration bug. Demand a session-mode connection (5432) instead.
  if (safeUrl(dbUrl).port === "6543") {
    throw new Error(
      `Refusing to reset over port 6543 (the transaction-mode pooler): it cannot run the
multi-statement DDL this reset sends, and would fail halfway through. Use the direct
connection on 5432 -- db.${dbRef}.supabase.co:5432 -- or the session pooler on 5432.`
    );
  }
}

let pool = null;

// Direct SQL as the database owner. Used to seed fixtures and to assert what is REALLY in
// a table, independent of whatever the policies let a given session see.
export async function sql(text, params = []) {
  if (!pool) pool = new pg.Pool({ connectionString: DB_URL });
  return pool.query(text, params);
}

// Drop and rebuild public from the migrations, in filename order.
export async function resetStack() {
  assertTestProject({
    dbUrl: DB_URL, apiUrl: API_URL,
    testRef: TEST_PROJECT_REF, prodRef: PROD_PROJECT_REF,
  });
  const client = new pg.Client({ connectionString: DB_URL });
  await client.connect();
  try {
    // The `alter default privileges` lines are not ceremony. Supabase grants those
    // defaults against the schema named `public`; dropping the schema drops them with it,
    // so newly created tables would have no grants for anon/authenticated at all and
    // PostgREST would answer every request with "permission denied for table" — which
    // looks exactly like a policy bug but is a missing GRANT.
    await client.query(`
      drop schema if exists public cascade;
      create schema public;
      grant usage, create on schema public to postgres, anon, authenticated, service_role;
      alter default privileges in schema public grant all on tables to postgres, anon, authenticated, service_role;
      alter default privileges in schema public grant all on functions to postgres, anon, authenticated, service_role;
      alter default privileges in schema public grant all on sequences to postgres, anon, authenticated, service_role;
      delete from auth.users;
    `);
    const files = readdirSync(MIGRATIONS_DIR).filter(f => f.endsWith(".sql")).sort();
    for (const f of files) {
      await client.query(readFileSync(MIGRATIONS_DIR + f, "utf8"));
    }
    // PostgREST caches the schema; without this the tables we just recreated come back as
    // PGRST205 "Could not find the table in the schema cache" on the first request.
    await client.query(`notify pgrst, 'reload schema';`);
  } finally {
    await client.end();
  }
}

export async function bootstrap() {
  const missing = [
    ["SUPABASE_API_URL", API_URL],
    ["SUPABASE_DB_URL", DB_URL],
    ["SUPABASE_TEST_PROJECT_REF", TEST_PROJECT_REF],
    ["SUPABASE_ANON_KEY", ANON_KEY],
    ["SUPABASE_SERVICE_ROLE_KEY", SERVICE_KEY],
  ].filter(([, v]) => !v).map(([k]) => k);

  if (missing.length) {
    throw new Error(
      `Not set: ${missing.join(", ")}.\n` +
      "This suite runs against a Supabase Cloud project set aside for tests -- there is\n" +
      'no local stack. See .env.example, and README.md ("Running the suite").'
    );
  }
  await resetStack();
}
