// The reset in fixtures.mjs drops the whole public schema and empties auth.users. Its
// connection string comes from $SUPABASE_DB_URL, so a stray export is all that stands
// between `npm test` and a wiped database.
//
// Two things have to be true, and loopback alone no longer covers it. The suite runs on
// the machine's native PostgreSQL, which also hosts other projects' databases -- notably
// onevio-crm's `crm_test`. So the guard checks the DATABASE as well as the host: only
// `vendor_app_test` may be reset, however local the server is.
//
// These cases are pure -- no database, no environment -- so they run without a server up.
import { test, assert } from "./framework.mjs";
import { assertLocalDb, TEST_DB_NAME, projectRefFromDbUrl } from "./fixtures.mjs";

const PROD_REF = "cnnqidkmcxkgwxnulvig";
const LOCAL = `postgresql://postgres:postgres@127.0.0.1:5432/${TEST_DB_NAME}`;

const ok = (over = {}) => ({ dbUrl: LOCAL, prodRef: PROD_REF, ...over });

const refuses = (over, why) => {
  let threw = false;
  try { assertLocalDb(ok(over)); } catch { threw = true; }
  assert(threw, `expected a refusal for ${why}: ${JSON.stringify(over)}`);
};

const allows = (over = {}) => assertLocalDb(ok(over));

test("the reset guard allows the local test database", () => {
  allows();
  allows({ dbUrl: `postgresql://postgres:postgres@localhost:5432/${TEST_DB_NAME}` });
  allows({ dbUrl: `postgresql://postgres:postgres@[::1]:5432/${TEST_DB_NAME}` });
  // Not naming a production project is normal; loopback plus the database name authorise.
  allows({ prodRef: undefined });
});

test("the reset guard refuses another project's database on the same server", () => {
  // The whole reason this check exists: onevio-crm lives on this very server, and its
  // test database is dropped and rebuilt by the same pattern.
  refuses({ dbUrl: "postgresql://postgres:postgres@127.0.0.1:5432/crm_test" },
          "onevio-crm's test database");
  refuses({ dbUrl: "postgresql://postgres:postgres@127.0.0.1:5432/crm" },
          "onevio-crm's development database");
  refuses({ dbUrl: "postgresql://postgres:postgres@127.0.0.1:5432/postgres" },
          "the maintenance database");
  refuses({ dbUrl: "postgresql://postgres:postgres@127.0.0.1:5432/" },
          "no database named at all");
});

test("the reset guard refuses the production project", () => {
  refuses({ dbUrl: `postgresql://postgres:pw@db.${PROD_REF}.supabase.co:5432/${TEST_DB_NAME}` },
          "the production database");
  refuses({ dbUrl: `postgresql://postgres.${PROD_REF}:pw@aws-0-ap-northeast-1.pooler.supabase.com:5432/postgres` },
          "production through the pooler");
});

test("the reset guard refuses any remote host, even with the right database name", () => {
  refuses({ dbUrl: `postgresql://postgres:pw@10.0.0.5:5432/${TEST_DB_NAME}` }, "a LAN address");
  refuses({ dbUrl: `postgresql://postgres:pw@db.internal:5432/${TEST_DB_NAME}` }, "an internal hostname");
  refuses({ dbUrl: `postgresql://postgres:pw@bbbbbbbbbbbbbbbbbbbb.supabase.co:5432/${TEST_DB_NAME}` },
          "a cloud host");
});

test("the reset guard fails closed on input it cannot parse", () => {
  refuses({ dbUrl: "not a url at all" }, "unparseable input");
  refuses({ dbUrl: "" }, "an empty string");
  refuses({ dbUrl: undefined }, "undefined");
  // Credentials may contain an @, which naive splitting gets wrong. The real host here
  // is production; the loopback address is sitting in the password.
  refuses({ dbUrl: `postgresql://postgres:p@127.0.0.1@db.${PROD_REF}.supabase.co:5432/${TEST_DB_NAME}` },
          "a loopback string hiding in the password");
});

test("the ref reader recognises Cloud URLs, so a refusal can name the project", () => {
  assert(projectRefFromDbUrl(`postgresql://postgres:pw@db.${PROD_REF}.supabase.co:5432/postgres`) === PROD_REF,
         "direct connection host");
  assert(projectRefFromDbUrl(`postgresql://postgres.${PROD_REF}:pw@aws-0-ap-northeast-1.pooler.supabase.com:5432/postgres`) === PROD_REF,
         "pooler username");
  assert(projectRefFromDbUrl(LOCAL) === null, "loopback carries no ref");
});
