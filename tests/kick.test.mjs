import { test, assert, assertEqual } from "./framework.mjs";
import { sql } from "./fixtures.mjs";

// Vault and pg_net are shimmed (tests/shim.sql): these cases pin which secrets the
// function reads and what it does with their values. Whether pg_net then delivers
// anything is Cloud's business, not this suite's.

async function setSecrets(url, secret) {
  await sql(`delete from vault.decrypted_secrets`);
  await sql(`delete from net.sent`);
  if (url !== null) {
    await sql(`insert into vault.decrypted_secrets (name, decrypted_secret)
               values ('send_notification_url', $1)`, [url]);
  }
  if (secret !== null) {
    await sql(`insert into vault.decrypted_secrets (name, decrypted_secret)
               values ('send_notification_secret', $1)`, [secret]);
  }
}

const URL = "https://cnnqidkmcxkgwxnulvig.supabase.co/functions/v1/send-notification";

async function sent() {
  const { rows } = await sql(`select url, headers from net.sent order by id`);
  return rows;
}

test("kick posts to the configured URL with the shared secret", async () => {
  await setSecrets(URL, "s3cret");
  await sql(`select kick_send_notification()`);
  const calls = await sent();
  assertEqual(calls.length, 1, "expected exactly one request");
  assertEqual(calls[0].url, URL, "posted to the wrong URL");
  assertEqual(calls[0].headers["x-send-secret"], "s3cret", "shared secret not sent");
});

test("kick trims a padded URL rather than posting it", async () => {
  // The production failure, exactly: a value pasted with a leading space made pg_net
  // raise "invalid URL" every minute for twenty minutes.
  await setSecrets(` ${URL} `, "s3cret");
  await sql(`select kick_send_notification()`);
  const calls = await sent();
  assertEqual(calls.length, 1, "a padded URL stopped the request entirely");
  assertEqual(calls[0].url, URL, "the URL was posted with its padding intact");
});

test("kick trims a padded secret, so the function is not sent a broken password", async () => {
  await setSecrets(URL, "  s3cret\n");
  await sql(`select kick_send_notification()`);
  const calls = await sent();
  assertEqual(calls[0].headers["x-send-secret"], "s3cret", "padded secret was sent as-is");
});

test("kick strips tabs and CRLF, not just spaces", async () => {
  // A first attempt at this used plain trim(), which strips spaces alone, and passed every
  // other case in this file. A value pasted out of Notepad ends CRLF and would have gone
  // out as a password the function could never match.
  await setSecrets("\t" + URL + "\r\n", "\r\n s3cret \t");
  await sql(`select kick_send_notification()`);
  const calls = await sent();
  assertEqual(calls.length, 1, "a tab/CRLF-padded URL stopped the request");
  assertEqual(calls[0].url, URL, "tab/CRLF survived in the URL");
  assertEqual(calls[0].headers["x-send-secret"], "s3cret", "tab/CRLF survived in the secret");
});

test("kick finds secrets whose NAMES were pasted with padding", async () => {
  // The first half of the same production failure: padded names meant both lookups
  // missed, the function returned early, and every cron run still reported success.
  await sql(`delete from vault.decrypted_secrets`);
  await sql(`delete from net.sent`);
  await sql(`insert into vault.decrypted_secrets (name, decrypted_secret)
             values (' send_notification_url', $1), (' send_notification_secret', 's3cret')`, [URL]);
  await sql(`select kick_send_notification()`);
  assertEqual((await sent()).length, 1, "padded secret NAMES still hide the configuration");
});

test("kick does nothing, quietly, when no secrets are set", async () => {
  // The sender ships dark. Unset is a legitimate state and must not raise.
  await setSecrets(null, null);
  await sql(`select kick_send_notification()`);
  assertEqual((await sent()).length, 0, "posted without a URL or a secret");
});

test("kick does nothing when only one of the two is set", async () => {
  await setSecrets(URL, null);
  await sql(`select kick_send_notification()`);
  assertEqual((await sent()).length, 0, "posted with no shared secret to send");

  await setSecrets(null, "s3cret");
  await sql(`select kick_send_notification()`);
  assertEqual((await sent()).length, 0, "posted with no URL");
});

test("kick treats an empty-string secret as unset", async () => {
  await setSecrets(URL, "   ");
  await sql(`select kick_send_notification()`);
  assertEqual((await sent()).length, 0, "whitespace counted as a password");
});

test("kick refuses a URL that is not https, and says so", async () => {
  // Set-but-unusable is the state that hid: distinct from unset, and worth a warning in
  // the Postgres log rather than a pg_net stack trace in cron.job_run_details.
  for (const bad of ["http://example.test/hook", "cnnqidkmcxkgwxnulvig.supabase.co", "not a url"]) {
    await setSecrets(bad, "s3cret");
    await sql(`select kick_send_notification()`);
    assertEqual((await sent()).length, 0, `posted to a bad URL: ${bad}`);
  }
});

test("a bad URL does not raise, so the cron job still succeeds", async () => {
  // A raised exception here would fail the job every minute; the warning is deliberate.
  await setSecrets("ftp://nope", "s3cret");
  let threw = false;
  try { await sql(`select kick_send_notification()`); } catch { threw = true; }
  assert(!threw, "a misconfigured URL aborted the cron run");
});

test("no browser session may fire the tick", async () => {
  const { rows } = await sql(
    `select has_function_privilege('authenticated', 'kick_send_notification()', 'execute') as ok`);
  assertEqual(rows[0].ok, false, "an end-user role can invoke the sender tick");
});
