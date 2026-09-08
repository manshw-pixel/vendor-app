// NOTHING here is mocked. This talks to the real local Postgres + GoTrue brought up by
// `supabase start` inside vendor-app/, with the real migrations applied.
//
// Tests are the ONLY thing that runs locally. Production is a Supabase Cloud project and
// is never a test target -- see the reset guard below, and README.md ("Deploying").
// See docs/superpowers/specs/2026-09-07-vegetable-vendor-app-design.md
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import pg from "pg";

export const API_URL = process.env.SUPABASE_API_URL || "http://127.0.0.1:55321";
export const DB_URL = process.env.SUPABASE_DB_URL
  || "postgresql://postgres:postgres@127.0.0.1:55322/postgres";
export const PASSWORD = "test-password-123";

// The ref of the production project, so the guard can refuse it by name rather than
// incidentally. Optional -- loopback is what authorises a reset -- but a much better
// error when a deploy shell's variables leak into a test run.
export const PROD_PROJECT_REF = process.env.SUPABASE_PROD_PROJECT_REF;

// The CLI's local anon key is public, but NOT fixed across CLI versions. Always export it
// from `supabase status -o json` rather than trusting a literal.
export const ANON_KEY = process.env.SUPABASE_ANON_KEY;
export const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const MIGRATIONS_DIR = fileURLToPath(new URL("../supabase/migrations/", import.meta.url));

export const newClient = () => createClient(API_URL, ANON_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

// ---------------------------------------------------------------------------
// The reset guard.
//
// resetStack() drops the entire public schema and empties auth.users, and DB_URL above is
// whatever $SUPABASE_DB_URL says. That is fine pointed at the disposable local stack and
// catastrophic pointed anywhere else, so the destination is checked rather than trusted:
// deploys go to Supabase Cloud, tests never do. Fails closed -- anything this cannot
// positively identify as loopback is treated as remote.
//
// The API url is checked too. A local database with a Cloud API would reset the local
// stack, assert against production, report green having tested nothing, and sign real
// users up in the production auth store on the way.
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

// These authorise nothing -- loopback does that. They exist so a refusal can name WHICH
// project was about to be wiped, which is the difference between a warning someone reads
// and one they skim.
//   direct:  postgresql://postgres:pw@db.<ref>.supabase.co:5432/postgres
//   pooler:  postgresql://postgres.<ref>:pw@aws-0-<region>.pooler.supabase.com:5432/postgres
export function projectRefFromDbUrl(url) {
  const parsed = safeUrl(url);
  if (!parsed) return null;
  const host = parsed.hostname.match(new RegExp(String.raw`^db\.(${REF})\.supabase\.co$`));
  if (host) return host[1];
  if (/\.pooler\.supabase\.com$/.test(parsed.hostname)) {
    // decodeURIComponent: the username arrives percent-encoded from some dashboards.
    const user = decodeURIComponent(parsed.username)
      .match(new RegExp(String.raw`^postgres\.(${REF})$`));
    if (user) return user[1];
  }
  return null;
}

export function projectRefFromApiUrl(url) {
  const parsed = safeUrl(url);
  if (!parsed) return null;
  const host = parsed.hostname.match(new RegExp(String.raw`^(${REF})\.supabase\.(co|in)$`));
  return host ? host[1] : null;
}

const REFUSAL = `
This drops the public schema and deletes every auth user. It may only ever run against
the local \`supabase start\` stack. If you are trying to deploy, that is
\`supabase db push\` -- never this suite.
Unset SUPABASE_DB_URL and SUPABASE_API_URL (or point them back at 127.0.0.1) and run again.`;

// Describes a remote target as specifically as it can: the production project by name,
// then any Cloud project by ref, then whatever host it managed to parse.
function describe(url, ref, prodRef) {
  if (ref && prodRef && ref === prodRef) return `the PRODUCTION project (${ref})`;
  if (ref) return `Supabase Cloud project ${ref}`;
  const parsed = safeUrl(url);
  return parsed ? `remote host ${parsed.hostname}` : "an unparseable target";
}

export function assertLocalDb({ dbUrl, apiUrl, prodRef } = {}) {
  const db = safeUrl(dbUrl);
  if (!db) {
    throw new Error(
      `Refusing to reset: could not parse a host out of SUPABASE_DB_URL (${JSON.stringify(dbUrl)}).${REFUSAL}`
    );
  }
  if (!LOOPBACK.has(db.hostname)) {
    throw new Error(
      `Refusing to reset a NON-LOCAL database: ${describe(dbUrl, projectRefFromDbUrl(dbUrl), prodRef)}.${REFUSAL}`
    );
  }

  const api = safeUrl(apiUrl);
  if (!api) {
    throw new Error(
      `Refusing to run: could not parse a host out of SUPABASE_API_URL (${JSON.stringify(apiUrl)}).${REFUSAL}`
    );
  }
  if (!LOOPBACK.has(api.hostname)) {
    throw new Error(
      `Refusing to run against a NON-LOCAL API: ${describe(apiUrl, projectRefFromApiUrl(apiUrl), prodRef)}.
The database is local but the API is not, so this would reset the local stack, assert
against a remote project, and sign test users up in its auth store.${REFUSAL}`
    );
  }
}

let pool = null;

// Direct SQL as superuser. Used to seed fixtures and to assert what is REALLY in a table,
// independent of whatever the policies let a given session see.
export async function sql(text, params = []) {
  if (!pool) pool = new pg.Pool({ connectionString: DB_URL });
  return pool.query(text, params);
}

// Drop and rebuild public from the migrations, in filename order.
export async function resetStack() {
  assertLocalDb({ dbUrl: DB_URL, apiUrl: API_URL, prodRef: PROD_PROJECT_REF });
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
  if (!ANON_KEY || !SERVICE_KEY) {
    throw new Error(
      "Export SUPABASE_ANON_KEY and SUPABASE_SERVICE_ROLE_KEY first:\n" +
      "  cd vendor-app && supabase status -o json"
    );
  }
  await resetStack();
}
