// Drains outbound_messages to WhatsApp via Twilio.
//
// THIS FUNCTION IS OUTSIDE RLS. It holds the service_role key, so no policy in
// 0002_rls.sql constrains it -- and unlike admin-create-user there is no end-user JWT to
// check, because the caller is pg_cron. The shared secret below is the whole door.
//
// Untestable locally: no Deno runtime in tests/run.mjs and no Twilio to call. Every
// decision therefore lives in ./sender.ts, which web/src/__tests__/sender.test.ts
// exercises, and the atomic claim lives in claim_outbound_messages() (0011), which the
// database suite exercises. This file is wiring, and should stay that way.
import { createClient } from "jsr:@supabase/supabase-js@2";
import { buildMessage, classifyFailure, normaliseMobile } from "./sender.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const SEND_SECRET = Deno.env.get("SEND_NOTIFICATION_SECRET") ?? "";

const TWILIO_SID = Deno.env.get("TWILIO_ACCOUNT_SID") ?? "";
const TWILIO_TOKEN = Deno.env.get("TWILIO_AUTH_TOKEN") ?? "";
const TWILIO_FROM = Deno.env.get("TWILIO_WHATSAPP_FROM") ?? "";

// { "token_issued": "HX...", "points_awarded": "HX..." } -- set once each template clears
// Twilio/Meta approval. Kept as config so approval never waits on a deploy.
const CONTENT_SIDS: Record<string, string> = (() => {
  try {
    return JSON.parse(Deno.env.get("TWILIO_CONTENT_SIDS") ?? "{}");
  } catch {
    console.error("send-notification: TWILIO_CONTENT_SIDS is not valid JSON");
    return {};
  }
})();

// No CORS block, unlike admin-create-user: no browser ever calls this. The only caller is
// kick_send_notification() over pg_net, which does not preflight.
function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** Length-independent compare, so a wrong secret cannot be found one byte at a time. */
function secretMatches(given: string): boolean {
  if (SEND_SECRET.length === 0) return false;
  const a = new TextEncoder().encode(given);
  const b = new TextEncoder().encode(SEND_SECRET);
  let diff = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  }
  return diff === 0;
}

type Claimed = { id: string; template_key: string; payload: unknown; mobile: string | null };

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ error: "bad_request" }, 405);
  if (!secretMatches(req.headers.get("x-send-secret") ?? "")) {
    return json({ error: "forbidden" }, 403);
  }

  const db = createClient(SUPABASE_URL, SERVICE, { auth: { persistSession: false } });

  const { data, error } = await db.rpc("claim_outbound_messages", { p_limit: 20 });
  if (error) {
    console.error("send-notification: claim failed", error);
    return json({ error: "claim_failed" }, 500);
  }

  const rows = (data ?? []) as Claimed[];
  let sent = 0, failed = 0, retry = 0;

  for (const row of rows) {
    // Both checks are permanent by nature, and both happen before any HTTP: a number
    // that will not parse and a template with no SID are states the next tick would
    // reproduce exactly, so spending an attempt on Twilio proves nothing.
    const to = normaliseMobile(row.mobile);
    if (!to.ok) {
      await markFailed(db, row.id, to.reason);
      failed++;
      continue;
    }

    const message = buildMessage(row.template_key, row.payload, CONTENT_SIDS);
    if (!message.ok) {
      await markFailed(db, row.id, message.reason);
      failed++;
      continue;
    }

    const form = new URLSearchParams({
      To: to.value,
      From: TWILIO_FROM,
      ContentSid: message.value.contentSid,
      ContentVariables: JSON.stringify(message.value.variables),
    });

    let status: number | null = null;
    let body = "";
    try {
      const res = await fetch(
        `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_SID}/Messages.json`,
        {
          method: "POST",
          headers: {
            Authorization: `Basic ${btoa(`${TWILIO_SID}:${TWILIO_TOKEN}`)}`,
            "Content-Type": "application/x-www-form-urlencoded",
          },
          body: form,
        },
      );
      status = res.status;
      body = await res.text();
    } catch (e) {
      // fetch threw: the request never reached Twilio. Retryable, and `status` stays null
      // so classifyFailure says so.
      body = String(e);
    }

    if (status !== null && status >= 200 && status < 300) {
      let sid: string | null = null;
      try {
        sid = JSON.parse(body).sid ?? null;
      } catch { /* delivered either way; the SID is for support, not correctness */ }
      await db.from("outbound_messages")
        .update({ status: "sent", sent_at: new Date().toISOString(), provider_message_id: sid })
        .eq("id", row.id);
      sent++;
      continue;
    }

    // Twilio error bodies carry the customer's phone number. Truncated, and logged to the
    // row rather than to console, so it stays inside the tenant's own data.
    const reason = `twilio_${status ?? "throw"}: ${body.slice(0, 300)}`;
    if (classifyFailure(status) === "retry") {
      // Back to pending. The attempts increment already happened in the claim, so this
      // row gets at most MAX_ATTEMPTS goes however many invocations touch it.
      await db.from("outbound_messages")
        .update({ status: "pending", last_error: reason })
        .eq("id", row.id);
      retry++;
    } else {
      await markFailed(db, row.id, reason);
      failed++;
    }
  }

  return json({ claimed: rows.length, sent, failed, retry }, 200);
});

async function markFailed(
  db: ReturnType<typeof createClient>,
  id: string,
  reason: string,
): Promise<void> {
  const { error } = await db.from("outbound_messages")
    .update({ status: "failed", last_error: reason })
    .eq("id", id);
  // A row left in 'sending' is reclaimed after five minutes by 0011, so a lost update
  // here costs a retry, not a stuck queue -- but it should still be visible.
  if (error) console.error("send-notification: could not mark failed", { id, error });
}
