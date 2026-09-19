// Suspends or reinstates a vendor, called by a platform owner. Flips vendors.suspended_at
// (the authoritative gate the sentinel role and RLS read) and, best-effort, bans or unbans
// every app_users account of that vendor so new sign-ins stop immediately too.
//
// THIS FUNCTION IS OUTSIDE RLS. It holds the service_role key, which carries bypassrls, so
// not one policy in 0002_rls.sql constrains it. Every tenant and role check below is
// hand-written for that reason -- the same lesson as admin-create-user, at higher stakes.
//
// Untestable locally: there is no Deno runtime in tests/run.mjs and the local suite runs no
// GoTrue. Logic belongs in ./guards.ts, which the web suite does exercise. This file is
// wiring, and should stay that way.
import { createClient } from "jsr:@supabase/supabase-js@2";
import { validateSuspendRequest, BAN_DURATION, UNBAN, type ErrorCode } from "./guards.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const ANON = Deno.env.get("SUPABASE_ANON_KEY")!;
const SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

// `*` here is deliberate, not an oversight. CORS is not this function's auth boundary --
// verify_jwt = true (config.toml) plus the hand-written owner check below are. Narrowing
// this to one origin was considered and rejected: the SPA is served from GitHub Pages
// today, a custom domain may follow, and a wrong origin fails exactly as invisibly (a
// browser-only, silent failure) as no CORS at all.
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function fail(code: ErrorCode, status: number): Response {
  return new Response(JSON.stringify({ error: code }), {
    status,
    headers: { "Content-Type": "application/json", ...CORS },
  });
}

Deno.serve(async (req) => {
  // supabase.functions.invoke() from the browser is a cross-origin fetch carrying
  // Authorization and Content-Type headers, so the browser sends a preflight OPTIONS
  // before the real POST. It expects only the CORS headers back, not a body.
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });

  if (req.method !== "POST") return fail("bad_request", 405);

  const auth = req.headers.get("Authorization");
  if (!auth) return fail("not_owner", 401);

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return fail("bad_request", 400);
  }

  const check = validateSuspendRequest(body);
  if (!check.ok) return fail(check.code, 400);
  const { vendor_id, action } = check.value;

  // The caller's OWN client: anon key plus their Authorization header. getUser() verifies
  // the JWT's signature, so the caller is who they say; the platform_owners read runs
  // under THEIR session, so RLS on that table applies -- a non-owner sees no row.
  const caller = createClient(SUPABASE_URL, ANON, {
    global: { headers: { Authorization: auth } },
    auth: { persistSession: false },
  });

  const { data: who, error: whoError } = await caller.auth.getUser();
  if (whoError || !who?.user) return fail("not_owner", 401);

  const { data: owner, error: ownerError } = await caller
    .from("platform_owners")
    .select("user_id")
    .eq("user_id", who.user.id)
    .maybeSingle();
  if (ownerError || !owner) return fail("not_owner", 403);

  const service = createClient(SUPABASE_URL, SERVICE, { auth: { persistSession: false } });

  const suspendedAt = action === "suspend" ? new Date().toISOString() : null;

  const { data: updated, error: updateError } = await service
    .from("vendors")
    .update({ suspended_at: suspendedAt })
    .eq("id", vendor_id)
    .select("id");
  if (updateError) return fail("update_failed", 500);
  if (!updated || updated.length === 0) return fail("not_found", 404);

  const { data: users, error: usersError } = await service
    .from("app_users")
    .select("id")
    .eq("vendor_id", vendor_id);
  if (usersError) {
    // The DB flag already flipped, which is the authoritative gate -- bans are a
    // best-effort extra layer to stop existing sessions from signing back in.
    console.error("owner-suspend-vendor: could not list app_users to ban/unban", {
      vendorId: vendor_id,
      usersError,
    });
    // Reported honestly rather than as a clean {banned:0, failed:0}: that shape reads as
    // "there was nobody to ban," which is false here -- the roster read itself failed, so
    // whether any account still can sign back in is unknown. bans_skipped tells the caller
    // that, distinctly from "this vendor genuinely has zero staff."
    return new Response(JSON.stringify({ banned: 0, failed: 0, bans_skipped: true }), {
      status: 200,
      headers: { "Content-Type": "application/json", ...CORS },
    });
  }

  const banDuration = action === "suspend" ? BAN_DURATION : UNBAN;
  let banned = 0;
  let failed = 0;
  for (const user of users ?? []) {
    try {
      const { error: banError } = await service.auth.admin.updateUserById(user.id, {
        ban_duration: banDuration,
      });
      if (banError) {
        failed += 1;
        console.error("owner-suspend-vendor: updateUserById failed", {
          vendorId: vendor_id,
          userId: user.id,
          action,
          banError,
        });
      } else {
        banned += 1;
      }
    } catch (banError) {
      failed += 1;
      console.error("owner-suspend-vendor: updateUserById threw", {
        vendorId: vendor_id,
        userId: user.id,
        action,
        banError,
      });
    }
  }

  return new Response(JSON.stringify({ banned, failed }), {
    status: 200,
    headers: { "Content-Type": "application/json", ...CORS },
  });
});
