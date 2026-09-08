// The reset in fixtures.mjs drops the whole public schema and empties auth.users. Its
// connection string comes from $SUPABASE_DB_URL, so a stray export left over from a
// deploy shell is all that stands between `npm test` and a wiped production project.
// Nothing local exists any more -- both the suite and the deploy target are Supabase
// Cloud projects -- so the guard can no longer lean on "is it loopback". It pins the
// target by project ref instead: only the project named by $SUPABASE_TEST_PROJECT_REF
// may be reset, and $SUPABASE_PROD_PROJECT_REF may never be, whatever else matches.
// These cases pin the refusal. They are pure -- no database, no environment -- so they
// can also be run on their own, without a project to point at.
import { test, assert } from "./framework.mjs";
import { assertTestProject, projectRefFromDbUrl, projectRefFromApiUrl } from "./fixtures.mjs";

const TEST_REF = "aaaaaaaaaaaaaaaaaaaa";
const PROD_REF = "bbbbbbbbbbbbbbbbbbbb";

const DIRECT = `postgresql://postgres:pw@db.${TEST_REF}.supabase.co:5432/postgres`;
const POOLER = `postgresql://postgres.${TEST_REF}:pw@aws-0-ap-south-1.pooler.supabase.com:5432/postgres`;
const API = `https://${TEST_REF}.supabase.co`;

const ok = (over = {}) => ({ dbUrl: DIRECT, apiUrl: API, testRef: TEST_REF, prodRef: PROD_REF, ...over });

const refuses = (over, why) => {
  let threw = false;
  try { assertTestProject(ok(over)); } catch { threw = true; }
  assert(threw, `expected a refusal for ${why}: ${JSON.stringify(over)}`);
};

const allows = (over = {}) => assertTestProject(ok(over));

test("the reset guard reads a project ref out of every Cloud URL shape", () => {
  assert(projectRefFromDbUrl(DIRECT) === TEST_REF, "direct connection host");
  assert(projectRefFromDbUrl(POOLER) === TEST_REF, "pooler username");
  assert(projectRefFromApiUrl(API) === TEST_REF, "api host");
});

test("the reset guard allows the designated test project", () => {
  allows();
  allows({ dbUrl: POOLER });
  // The prod ref being unset is normal -- the ref match alone is what authorises.
  allows({ prodRef: undefined });
});

test("the reset guard refuses a database that is not the test project", () => {
  refuses({ dbUrl: `postgresql://postgres:pw@db.${PROD_REF}.supabase.co:5432/postgres` },
          "a database belonging to another project");
  refuses({ dbUrl: `postgresql://postgres.${PROD_REF}:pw@aws-0-ap-south-1.pooler.supabase.com:5432/postgres` },
          "another project reached through the pooler");
});

test("the reset guard refuses when the API and the database are different projects", () => {
  // Resetting one project while asserting against another would report green having
  // wiped something nobody was looking at.
  refuses({ apiUrl: `https://${PROD_REF}.supabase.co` }, "an API pointed at another project");
});

test("the reset guard refuses the production project by name", () => {
  // Belt and braces: even if SUPABASE_TEST_PROJECT_REF is mistyped to equal prod.
  refuses({ testRef: PROD_REF, dbUrl: `postgresql://postgres:pw@db.${PROD_REF}.supabase.co:5432/postgres`,
            apiUrl: `https://${PROD_REF}.supabase.co` },
          "the production ref, even when named as the test ref");
});

test("the reset guard refuses when no test project is named", () => {
  refuses({ testRef: undefined }, "an unset SUPABASE_TEST_PROJECT_REF");
  refuses({ testRef: "" }, "an empty SUPABASE_TEST_PROJECT_REF");
});

test("the reset guard refuses the transaction pooler port", () => {
  // 6543 is transaction mode: it cannot run the multi-statement DDL resetStack() sends,
  // and fails in the middle rather than up front. Refuse it with a real explanation.
  refuses({ dbUrl: `postgresql://postgres.${TEST_REF}:pw@aws-0-ap-south-1.pooler.supabase.com:6543/postgres` },
          "the transaction pooler port");
});

test("the reset guard refuses anything local", () => {
  // Nothing local exists any more. A leftover `supabase start` export is a mistake now,
  // not a happy path.
  refuses({ dbUrl: "postgresql://postgres:postgres@127.0.0.1:55322/postgres" }, "loopback");
  refuses({ dbUrl: "postgresql://postgres:postgres@localhost:55322/postgres" }, "localhost");
  refuses({ apiUrl: "http://127.0.0.1:55321" }, "a loopback API");
});

test("the reset guard fails closed on input it cannot parse", () => {
  refuses({ dbUrl: "not a url at all" }, "unparseable input");
  refuses({ dbUrl: "" }, "an empty string");
  refuses({ dbUrl: undefined }, "undefined");
  refuses({ apiUrl: undefined }, "an undefined API url");
  refuses({ dbUrl: "postgresql://postgres:pw@10.0.0.5:5432/postgres" }, "a host carrying no ref");
  // Credentials may contain an @, which naive splitting gets wrong. The real host here
  // is prod; the test ref is sitting in the password.
  refuses({ dbUrl: `postgresql://postgres:p@db.${TEST_REF}.supabase.co@db.${PROD_REF}.supabase.co:5432/postgres` },
          "a test ref hiding in the password");
});
