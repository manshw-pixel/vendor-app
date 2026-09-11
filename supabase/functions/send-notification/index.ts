// Drains outbound_messages to WhatsApp via Gupshup.
//
// THIS FUNCTION IS OUTSIDE RLS. It holds the service_role key, so no policy in
// 0002_rls.sql constrains it -- and unlike admin-create-user there is no end-user JWT to
// check, because the caller is pg_cron. The shared secret below is the whole door.
//
// Untestable locally: no Deno runtime in tests/run.mjs and no Gupshup to call. Every
// decision therefore lives in ./sender.ts, which web/src/__tests__/sender.test.ts
// exercises, and the atomic claim lives in claim_outbound_messages() (0011), which the
// database suite exercises. This file is wiring, and should stay that way.
import { createClient } from "jsr:@supabase/supabase-js@2";
import { buildMessage, classifyFailure, normaliseMobile } from "./sender.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const SEND_SECRET = Deno.env.get("SEND_NOTIFICATION_SECRET") ?? "";

const GUPSHUP_API_KEY = Deno.env.get("GUPSHUP_API_KEY") ?? "";
// The WhatsApp business number Gupshup sends from, digits only with country code.
const GUPSHUP_SOURCE = Deno.env.get("GUPSHUP_SOURCE") ?? "";
// The Gupshup app name, sent as `src.name`. Gupshup rejects a send without it.
const GUPSHUP_APP_NAME = Deno.env.get("GUPSHUP_APP_NAME") ?? "";

const GUPSHUP_URL = "https://api.gupshup.io/wa/api/v1/template/msg";

// { "token_issued": "<uuid>", "points_awarded": "<uuid>" } -- set once each template clears
// Meta approval in the Gupshup console. Kept as config so approval never waits on a deploy.
const TEMPLATE_IDS: Record<string, string> = (() => {
  try {
    return JSON.parse(Deno.env.get("GUPSHUP_TEMPLATE_IDS") ?? "{}");
  } catch {
    console.error("send-notification: GUPSHUP_TEMPLATE_IDS is not valid JSON");
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
    // that will not parse and a template with no id are states the next tick would
    // reproduce exactly, so spending an attempt on Gupshup proves nothing.
    const to = normaliseMobile(row.mobile);
    if (!to.ok) {
      await markFailed(db, row.id, to.reason);
      failed++;
      continue;
    }

    const message = buildMessage(row.template_key, row.payload, TEMPLATE_IDS);
    if (!message.ok) {
      await markFailed(db, row.id, message.reason);
      failed++;
      continue;
    }

    // Gupshup wants the template as a JSON STRING inside a form field, not as JSON body.
    const form = new URLSearchParams({
      channel: "whatsapp",
      source: GUPSHUP_SOURCE,
      destination: to.value,
      "src.name": GUPSHUP_APP_NAME,
      template: JSON.stringify({ id: message.value.templateId, params: message.value.params }),
    });

    let status: number | null = null;
    let body = "";
    try {
      const res = await fetch(GUPSHUP_URL, {
        method: "POST",
        headers: {
          apikey: GUPSHUP_API_KEY,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: form,
      });
      status = res.status;
      body = await res.text();
    } catch (e) {
      // fetch threw: the request never reached Gupshup. Retryable, and `status` stays null
      // so classifyFailure says so.
      body = String(e);
    }

    // Gupshup answers 202 with {"status":"submitted","messageId":"..."} -- accepted for
    // delivery, not yet delivered. Anything 2xx counts as ours done; what happens after is
    // Gupshup's callback to tell, and this app does not yet listen for one.
    if (status !== null && status >= 200 && status < 300) {
      let messageId: string | null = null;
      try {
        messageId = JSON.parse(body).messageId ?? null;
      } catch { /* accepted either way; the id is for support, not correctness */ }
      await db.from("outbound_messages")
        .update({
          status: "sent",
          sent_at: new Date().toISOString(),
          provider_message_id: messageId,
        })
        .eq("id", row.id);
      sent++;
      continue;
    }

    // Gupshup error bodies carry the customer's phone number. Truncated, and logged to the
    // row rather than to console, so it stays inside the tenant's own data. 402 is named
    // outright because "insufficient balance" is an operator action, not a code bug.
    const prefix = status === 402 ? "gupshup_402_balance" : `gupshup_${status ?? "throw"}`;
    const reason = `${prefix}: ${body.slice(0, 300)}`;
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
