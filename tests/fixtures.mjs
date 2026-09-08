// NOTHING here is mocked. This talks to the machine's real, native PostgreSQL server --
// no Docker, no PostgREST, no GoTrue -- with the real migrations applied, unmodified.
//
// PostgREST and GoTrue are stood in for by tests/shim.sql and tests/client.mjs. That is a
// real limitation, written down in README.md ("What the local suite does not cover"), and
// the reason a Cloud test project remains the eventual target. What it does NOT
// compromise is RLS: sessions connect as the owner and then `set role authenticated`, so
// every policy applies exactly as it does in production.
//
// Production is a Supabase Cloud project and is never a test target -- see the guard.
// See docs/superpowers/specs/2026-09-07-vegetable-vendor-app-design.md
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { newClient as makeClient, newServiceClient, closeAllClients } from "./client.mjs";

// The one database this suite may touch. Named, not defaulted from the URL: the native
// server also hosts other projects' databases, and `drop schema public cascade` does not
// care which one it is pointed at.
export const TEST_DB_NAME = "vendor_app_test";

export const DB_URL = process.env.SUPABASE_DB_URL
  || `postgresql://postgres:postgres@127.0.0.1:5432/${TEST_DB_NAME}`;
export const PASSWORD = "test-password-123";

// The ref of the production Cloud project, so the guard can refuse it by name rather than
// incidentally. Optional -- loopback plus the database name are what authorise a reset --
// but a much better error when a deploy shell's variables leak into a test run.
export const PROD_PROJECT_REF = process.env.SUPABASE_PROD_PROJECT_REF;

const MIGRATIONS_DIR = fileURLToPath(new URL("../supabase/migrations/", import.meta.url));
const SHIM = fileURLToPath(new URL("./shim.sql", import.meta.url));

// pg_cron does not exist on a native Windows PostgreSQL build, so this one statement
// cannot run. Everything else in 0005_cron.sql does: shim.sql supplies a cron schema and
// a cron.schedule() that records the job, so expire_points() and the schedule call are
// both still exercised. Recorded here rather than hidden, and reported by run.mjs.
const PG_CRON_STATEMENT = /create\s+extension\s+if\s+not\s+exists\s+pg_cron\s*;/i;
export const SKIPPED = [];

export const newClient = () => makeClient(DB_URL);
export const serviceClient = () => newServiceClient(DB_URL);
export { closeAllClients };

// ---------------------------------------------------------------------------
// The reset guard.
//
// resetStack() drops the entire public schema and empties auth.users, and DB_URL above is
// whatever $SUPABASE_DB_URL says. Two things must hold, and neither implies the other:
//
//   * the server is loopback -- never Cloud, never a LAN box;
//   * the database is vendor_app_test -- because onevio-crm's `crm_test` lives on this
//     same server, and the reset would drop its schema just as happily.
//
// Fails closed: anything it cannot positively identify as both is refused.
// ---------------------------------------------------------------------------

const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

// Supabase refs are a fixed-length lowercase slug. Anchored, so a ref-shaped fragment of
// some longer label cannot pass for one.
const REF = String.raw`[a-z0-9]{20}`;

// WHATWG URL gets the credential/host split right; hand-rolled splitting does not, and a
// password containing "@127.0.0.1" is exactly the case that would fool it.
function safeUrl(url) {
  if (typeof url !== "string" || url === "") return null;
  try { return new URL(url); } catch { return null; }
}

// Authorises nothing -- loopback and the database name do that. This exists so a refusal
// can name WHICH project was about to be wiped, which is the difference between a warning
// someone reads and one they skim.
export function projectRefFromDbUrl(url) {
  const parsed = safeUrl(url);
  if (!parsed) return null;
  const host = parsed.hostname.match(new RegExp(String.raw`^db\.(${REF})\.supabase\.co$`));
  if (host) return host[1];
  if (/\.pooler\.supabase\.com$/.test(parsed.hostname)) {
    const user = decodeURIComponent(parsed.username)
      .match(new RegExp(String.raw`^postgres\.(${REF})$`));
    if (user) return user[1];
  }
  return null;
}

const REFUSAL = `
This drops the public schema and deletes every auth user. It may only ever run against
the local \`${TEST_DB_NAME}\` database. If you are trying to deploy, that is
\`supabase db push\` -- never this suite.
Unset SUPABASE_DB_URL (or point it back at ${TEST_DB_NAME} on 127.0.0.1) and run again.`;

export function assertLocalDb({ dbUrl, prodRef } = {}) {
  const db = safeUrl(dbUrl);
  if (!db) {
    throw new Error(
      `Refusing to reset: could not parse SUPABASE_DB_URL (${JSON.stringify(dbUrl)}).${REFUSAL}`
    );
  }

  if (!LOOPBACK.has(db.hostname)) {
    const ref = projectRefFromDbUrl(dbUrl);
    const what = ref && prodRef && ref === prodRef ? `the PRODUCTION project (${ref})`
      : ref ? `Supabase Cloud project ${ref}`
      : `remote host ${db.hostname}`;
    throw new Error(`Refusing to reset a NON-LOCAL database: ${what}.${REFUSAL}`);
  }

  // pathname is "/dbname"; an empty or absent one means the driver would fall back to a
  // default database, which is exactly the accident this check exists to catch.
  const name = db.pathname.replace(/^\//, "");
  if (name !== TEST_DB_NAME) {
    throw new Error(
      `Refusing to reset the database "${name || "(none named)"}": this suite may only
touch "${TEST_DB_NAME}". Other projects keep their databases on this same server --
onevio-crm's crm_test among them -- and this reset would drop their schema too.${REFUSAL}`
    );
  }
}

let pool = null;

// Direct SQL as the owner. Used to seed fixtures and to assert what is REALLY in a table,
// independent of whatever the policies let a given session see. Note this connection
// keeps the owner's rights and so bypasses RLS -- never make a policy assertion through
// it; that is what the role-switched clients in client.mjs are for.
export async function sql(text, params = []) {
  if (!pool) pool = new pg.Pool({ connectionString: DB_URL });
  return pool.query(text, params);
}

// Drop and rebuild public from the migrations, in filename order.
export async function resetStack() {
  assertLocalDb({ dbUrl: DB_URL, prodRef: PROD_PROJECT_REF });
  await closeAllClients();
  const client = new pg.Client({ connectionString: DB_URL });
  await client.connect();
  try {
    // The `alter default privileges` lines are not ceremony. Supabase grants those
    // defaults against the schema named `public`; dropping the schema drops them with it,
    // so newly created tables would have no grants for anon/authenticated at all and
    // every request would fail with "permission denied for table" — which looks exactly
    // like a policy bug but is a missing GRANT.
    await client.query(`
      drop schema if exists public cascade;
      create schema public;
    `);
    // The shim must come first: the migrations reference auth.uid() and grant to roles
    // that do not exist on a plain server.
    await client.query(readFileSync(SHIM, "utf8"));
    await client.query(`
      grant usage, create on schema public to anon, authenticated, service_role;
      alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
      alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
      alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
      delete from auth.users;
    `);
    SKIPPED.length = 0;
    const files = readdirSync(MIGRATIONS_DIR).filter(f => f.endsWith(".sql")).sort();
    for (const f of files) {
      let text = readFileSync(MIGRATIONS_DIR + f, "utf8");
      if (PG_CRON_STATEMENT.test(text)) {
        text = text.replace(PG_CRON_STATEMENT, "");
        SKIPPED.push(`${f}: "create extension pg_cron" (unavailable on native Windows; ` +
                     `cron.schedule is shimmed, so the rest of the file still ran)`);
      }
      await client.query(text);
    }
  } finally {
    await client.end();
  }
}

export async function bootstrap() {
  await resetStack();
}
