// NOTHING here is mocked. This talks to the real local Postgres + GoTrue brought up by
// `supabase start` inside vendor-app/, with the real migrations applied.
// See docs/superpowers/specs/2026-09-07-vegetable-vendor-app-design.md
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import pg from "pg";

export const API_URL = process.env.SUPABASE_API_URL || "http://127.0.0.1:55321";
export const DB_URL = process.env.SUPABASE_DB_URL
  || "postgresql://postgres:postgres@127.0.0.1:55322/postgres";
export const PASSWORD = "test-password-123";

// The CLI's local anon key is public, but NOT fixed across CLI versions. Always export it
// from `supabase status -o json` rather than trusting a literal.
export const ANON_KEY = process.env.SUPABASE_ANON_KEY;
export const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const MIGRATIONS_DIR = fileURLToPath(new URL("../supabase/migrations/", import.meta.url));

export const newClient = () => createClient(API_URL, ANON_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

// resetStack() drops the entire public schema and empties auth.users, and DB_URL above is
// whatever $SUPABASE_DB_URL says. That is fine pointed at the disposable local stack and
// catastrophic pointed anywhere else, so the destination is checked rather than trusted:
// deploys go to Supabase Cloud, tests never do. Fails closed -- anything this cannot
// positively identify as loopback is treated as remote.
const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

export function assertLocalDb(url) {
  let host;
  try {
    // WHATWG URL gets the credential/host split right; hand-rolled splitting does not,
    // and a password containing "@127.0.0.1" is exactly the case that would fool it.
    host = new URL(url).hostname;
  } catch {
    throw new Error(
      `Refusing to reset: could not parse a host out of SUPABASE_DB_URL (${JSON.stringify(url)}).`
    );
  }
  if (!LOOPBACK.has(host)) {
    throw new Error(
      `Refusing to reset a NON-LOCAL database: ${host}
This drops the public schema and deletes every auth user. It may only ever run
against the local \`supabase start\` stack. If you are trying to deploy, that is
\`supabase db push\` -- never this suite.
Unset SUPABASE_DB_URL (or point it back at 127.0.0.1) and run again.`
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
  assertLocalDb(DB_URL);
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
