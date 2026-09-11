/**
 * Pure decisions for send-notification.
 *
 * Imports NOTHING -- not Deno, not supabase-js -- so web/src/__tests__/sender.test.ts can
 * import it directly and these rules are genuinely exercised. The function around it
 * cannot be run locally at all (no Deno runtime in tests/run.mjs, no Twilio), so anything
 * that can be decided here should be decided here. Same split, same reason, as
 * admin-create-user/guards.ts.
 */

/**
 * The claim query filters on `attempts < MAX_ATTEMPTS`, so this is the number of times a
 * retryable failure gets another go before the row is left for a human. Five one-minute
 * cron ticks is a five-minute Twilio outage absorbed silently; longer than that is not a
 * blip and someone should see the `failed` rows.
 */
export const MAX_ATTEMPTS = 5;

export type Ok<T> = { ok: true; value: T };
export type Err = { ok: false; reason: string };
export type Result<T> = Ok<T> | Err;

/**
 * Which payload fields each template's variables are built from, in order. The ContentSid
 * itself comes from TWILIO_CONTENT_SIDS at runtime -- template approval happens in the
 * Twilio console long after this ships, and must not need a code change.
 *
 * The payload shapes are fixed by the two enqueue sites and are not ours to vary:
 * issue_token() (0003_functions.sql:54) and complete_bill() (0010_points_redemption.sql:143).
 */
const TEMPLATES: Record<string, { field: string; kind: "int" | "money" }[]> = {
  token_issued: [
    { field: "token_no", kind: "int" },
    { field: "total", kind: "money" },
  ],
  points_awarded: [
    { field: "points", kind: "int" },
    // The NET collected, which is what complete_bill writes to bills.total once points
    // are redeemed. Telling the customer the gross would contradict their receipt.
    { field: "total", kind: "money" },
    { field: "expires_in_days", kind: "int" },
  ],
};

/**
 * A mobile as Twilio needs it: `whatsapp:+91XXXXXXXXXX`.
 *
 * customers.mobile is free text and always has been, so every shape below is already
 * sitting in production rows. A number this cannot parse is a PERMANENT failure -- no
 * quantity of retries turns nine digits into ten.
 */
export function normaliseMobile(raw: string | null | undefined): Result<string> {
  if (typeof raw !== "string") return { ok: false, reason: "no_mobile" };

  let digits = raw.replace(/\D/g, "");
  if (digits.length === 12 && digits.startsWith("91")) digits = digits.slice(2);
  else if (digits.length === 11 && digits.startsWith("0")) digits = digits.slice(1);

  // Indian mobile numbers are ten digits opening 6-9. Anything else -- a landline, a
  // half-typed number, a foreign number this app has no template approved for -- is
  // rejected here rather than at Twilio, one wasted attempt later.
  if (!/^[6-9]\d{9}$/.test(digits)) return { ok: false, reason: "bad_mobile" };

  return { ok: true, value: `whatsapp:+91${digits}` };
}

function asInt(v: unknown): string | null {
  return typeof v === "number" && Number.isFinite(v) ? String(Math.trunc(v)) : null;
}

function asMoney(v: unknown): string | null {
  // numeric(10,2) arrives as a JS number over PostgREST. toFixed(2) both pads 640 to
  // "640.00" and clips any float tail, so the message matches the printed total.
  return typeof v === "number" && Number.isFinite(v) ? v.toFixed(2) : null;
}

/**
 * Turn a queued row into the two things Twilio's content API needs.
 *
 * Every failure here is permanent by construction: an unknown key, a missing SID and a
 * malformed payload are all states that the next cron tick would reproduce exactly.
 */
export function buildMessage(
  templateKey: string,
  payload: unknown,
  contentSids: Record<string, string>,
): Result<{ contentSid: string; variables: Record<string, string> }> {
  const spec = TEMPLATES[templateKey];
  if (!spec) return { ok: false, reason: `unknown_template_${templateKey}` };

  const contentSid = contentSids[templateKey];
  if (!contentSid) return { ok: false, reason: `no_content_sid_for_${templateKey}` };

  const fields = (payload ?? {}) as Record<string, unknown>;
  const variables: Record<string, string> = {};

  for (let i = 0; i < spec.length; i++) {
    const { field, kind } = spec[i]!;
    const rendered = kind === "int" ? asInt(fields[field]) : asMoney(fields[field]);
    // A template sent with a hole in it is worse than one not sent: the customer reads a
    // bill message with a blank where their token number belongs.
    if (rendered === null) return { ok: false, reason: `bad_payload_${templateKey}_${field}` };
    variables[String(i + 1)] = rendered;
  }

  return { ok: true, value: { contentSid, variables } };
}

/**
 * Whether a failed send is worth trying again.
 *
 * `null` means fetch threw -- DNS, TLS, a dropped connection -- and never reached Twilio.
 */
export function classifyFailure(status: number | null): "retry" | "permanent" {
  if (status === null) return "retry";
  if (status === 429) return "retry";
  // A rotated or mistyped TWILIO_AUTH_TOKEN is an operator error someone will fix. Failing
  // the queue permanently in the minutes before they notice would lose real customers'
  // bill messages with nothing left to replay them from.
  if (status === 401) return "retry";
  if (status >= 500) return "retry";
  return "permanent";
}
