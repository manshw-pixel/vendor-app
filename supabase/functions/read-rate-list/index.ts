// Reads a rate-list photo with Gemini and returns the lines. Writes nothing: the admin
// reviews the result in the app and apply_price_list is the only write.
//
// Needs no service role -- every read below runs under the caller's JWT.
// Untestable locally (no Deno runtime); logic lives in ./guards.ts, tested by the web suite.
import { createClient } from "jsr:@supabase/supabase-js@2";
import {
  validateReadRequest, geminiRequest, geminiUrl, parseGeminiResponse, DEFAULT_MODEL, type ErrorCode,
} from "./guards.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const ANON = Deno.env.get("SUPABASE_ANON_KEY")!;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status: number) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...CORS } });
const fail = (code: ErrorCode, status: number) => json({ error: code }, status);

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (req.method !== "POST") return fail("bad_request", 405);

  const key = Deno.env.get("GEMINI_API_KEY");
  if (!key) return fail("not_configured", 500);

  const auth = req.headers.get("Authorization");
  if (!auth) return fail("not_admin", 401);

  let body: unknown;
  try { body = await req.json(); } catch { return fail("bad_request", 400); }
  const check = validateReadRequest(body);
  if (!check.ok) return fail(check.code, 400);

  const caller = createClient(SUPABASE_URL, ANON, {
    global: { headers: { Authorization: auth } }, auth: { persistSession: false },
  });
  const { data: who, error: whoError } = await caller.auth.getUser();
  if (whoError || !who?.user) return fail("not_admin", 401);
  const { data: me, error: meError } = await caller
    .from("app_users").select("vendor_id, role, vendors(suspended_at)").eq("id", who.user.id).maybeSingle();
  if (meError || !me || me.role !== "admin") return fail("not_admin", 403);
  // A suspended shop's admin still passes the role check above -- suspension is a separate
  // axis from role, so it needs its own gate. Without this, a suspended shop's admin could
  // keep spending the shop's Gemini quota even though the sentinel role and RLS treat the
  // shop as shut down everywhere else.
  const vendorRow = Array.isArray(me.vendors) ? me.vendors[0] : me.vendors;
  if (vendorRow?.suspended_at) return fail("not_admin", 403);

  const model = Deno.env.get("GEMINI_MODEL") || DEFAULT_MODEL;
  let res: Response;
  try {
    res = await fetch(geminiUrl(model), {
      method: "POST",
      // The key travels in a header, never the URL, so it cannot land in a request log.
      headers: { "Content-Type": "application/json", "x-goog-api-key": key },
      body: JSON.stringify(geminiRequest(check.images)),
      signal: AbortSignal.timeout(60_000),
    });
  } catch {
    return fail("read_failed", 502);
  }
  if (!res.ok) return fail("read_failed", 502);
  const parsed = parseGeminiResponse(await res.json().catch(() => null));
  if (!parsed.ok) return fail("read_failed", 502);
  return json({ rows: parsed.rows }, 200);
});
