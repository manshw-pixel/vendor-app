// The reset in fixtures.mjs drops the whole public schema and empties auth.users. Its
// connection string comes from $SUPABASE_DB_URL, so a stray export left over from a
// deploy shell is all that stands between `npm test` and a wiped production project.
//
// Tests run against the local `supabase start` stack; production lives on Supabase
// Cloud and is never a test target. So the guard allows loopback and refuses everything
// else -- and refuses the production project BY NAME when it can recognise it, because
// "postgresql://...@db.cnnqidkmcxkgwxnulvig.supabase.co" deserves a better error than
// "not a loopback host".
//
// These cases are pure -- no database, no environment -- so they can also be run on
// their own, without a stack up.
import { test, assert } from "./framework.mjs";
import { assertLocalDb, projectRefFromDbUrl, projectRefFromApiUrl } from "./fixtures.mjs";

const PROD_REF = "cnnqidkmcxkgwxnulvig";
const OTHER_REF = "bbbbbbbbbbbbbbbbbbbb";

const LOCAL_DB = "postgresql://postgres:postgres@127.0.0.1:55322/postgres";
const LOCAL_API = "http://127.0.0.1:55321";

const ok = (over = {}) => ({ dbUrl: LOCAL_DB, apiUrl: LOCAL_API, prodRef: PROD_REF, ...over });

const refuses = (over, why) => {
  let threw = false;
  try { assertLocalDb(ok(over)); } catch { threw = true; }
  assert(threw, `expected a refusal for ${why}: ${JSON.stringify(over)}`);
};

const allows = (over = {}) => assertLocalDb(ok(over));

test("the reset guard allows the local stack", () => {
  allows();
  allows({ dbUrl: "postgresql://postgres:postgres@localhost:55322/postgres" });
  allows({ dbUrl: "postgresql://postgres:postgres@[::1]:55322/postgres" });
  allows({ apiUrl: "http://localhost:55321" });
  // Not naming a production project is normal; loopback is what authorises.
  allows({ prodRef: undefined });
});

test("the reset guard refuses the production project", () => {
  refuses({ dbUrl: `postgresql://postgres:pw@db.${PROD_REF}.supabase.co:5432/postgres` },
          "the production database");
  refuses({ dbUrl: `postgresql://postgres.${PROD_REF}:pw@aws-0-ap-northeast-1.pooler.supabase.com:5432/postgres` },
          "production through the pooler");
});

test("the reset guard refuses any Supabase Cloud project, named or not", () => {
  // Refusing only the known prod ref would let a second Cloud project through.
  refuses({ dbUrl: `postgresql://postgres:pw@db.${OTHER_REF}.supabase.co:5432/postgres` },
          "some other cloud project");
  refuses({ prodRef: undefined, dbUrl: `postgresql://postgres:pw@db.${OTHER_REF}.supabase.co:5432/postgres` },
          "a cloud project with no prod ref configured");
});

test("the reset guard refuses any other remote host", () => {
  refuses({ dbUrl: "postgresql://postgres:pw@10.0.0.5:5432/postgres" }, "a LAN address");
  refuses({ dbUrl: "postgresql://postgres:pw@db.internal:5432/postgres" }, "an internal hostname");
});

test("the reset guard refuses a remote API even with a local database", () => {
  // Resetting the local stack while asserting against Cloud would report green having
  // tested nothing, and would sign real users up in production.
  refuses({ apiUrl: `https://${PROD_REF}.supabase.co` }, "the production API");
  refuses({ apiUrl: `https://${OTHER_REF}.supabase.co` }, "a remote API");
});

test("the reset guard fails closed on input it cannot parse", () => {
  refuses({ dbUrl: "not a url at all" }, "unparseable input");
  refuses({ dbUrl: "" }, "an empty string");
  refuses({ dbUrl: undefined }, "undefined");
  refuses({ apiUrl: undefined }, "an undefined API url");
  // Credentials may contain an @, which naive splitting gets wrong. The real host here
  // is production; the loopback address is sitting in the password.
  refuses({ dbUrl: `postgresql://postgres:p@127.0.0.1@db.${PROD_REF}.supabase.co:5432/postgres` },
          "a loopback string hiding in the password");
});

test("the ref readers recognise every Cloud URL shape", () => {
  // These exist so the refusal above can name the project rather than just its host.
  assert(projectRefFromDbUrl(`postgresql://postgres:pw@db.${PROD_REF}.supabase.co:5432/postgres`) === PROD_REF,
         "direct connection host");
  assert(projectRefFromDbUrl(`postgresql://postgres.${PROD_REF}:pw@aws-0-ap-northeast-1.pooler.supabase.com:5432/postgres`) === PROD_REF,
         "pooler username");
  assert(projectRefFromApiUrl(`https://${PROD_REF}.supabase.co`) === PROD_REF, "api host");
  assert(projectRefFromDbUrl(LOCAL_DB) === null, "loopback carries no ref");
});
