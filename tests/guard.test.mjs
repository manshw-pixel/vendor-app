// The reset in fixtures.mjs drops the whole public schema and empties auth.users. Its
// connection string comes from $SUPABASE_DB_URL, so a stray export left over from a
// deploy shell is all that stands between `npm test` and a wiped production project.
// These cases pin the refusal. They touch no database, so they run before bootstrap.
import { test, assert } from "./framework.mjs";
import { assertLocalDb } from "./fixtures.mjs";

const refuses = (url, why) => {
  let threw = false;
  try { assertLocalDb(url); } catch { threw = true; }
  assert(threw, `expected a refusal for ${why}: ${url}`);
};

const allows = (url) => assertLocalDb(url);

test("the reset guard allows loopback hosts", () => {
  allows("postgresql://postgres:postgres@127.0.0.1:55322/postgres");
  allows("postgresql://postgres:postgres@localhost:55322/postgres");
  allows("postgresql://postgres:postgres@[::1]:55322/postgres");
});

test("the reset guard refuses a Supabase Cloud host", () => {
  refuses("postgresql://postgres:pw@db.abcdefghijklm.supabase.co:5432/postgres", "a cloud project");
  refuses("postgresql://postgres:pw@aws-0-ap-south-1.pooler.supabase.com:6543/postgres", "the cloud pooler");
});

test("the reset guard refuses any other remote host", () => {
  refuses("postgresql://postgres:pw@10.0.0.5:5432/postgres", "a LAN address");
  refuses("postgresql://postgres:pw@db.internal:5432/postgres", "an internal hostname");
});

test("the reset guard fails closed on input it cannot parse", () => {
  refuses("not a url at all", "unparseable input");
  refuses("", "an empty string");
  refuses(undefined, "undefined");
  // Credentials may contain an @, which naive splitting gets wrong. The host here is
  // the cloud one, not the 127.0.0.1 sitting in the password.
  refuses("postgresql://postgres:p@127.0.0.1@db.abcdefghijklm.supabase.co:5432/postgres",
          "a loopback string hiding in the password");
});
