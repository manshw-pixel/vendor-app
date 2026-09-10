// Removes a staff member from a shop AND deletes their auth account, so their email is
// genuinely free to use again.
//
// THIS FUNCTION IS OUTSIDE RLS. It holds the service_role key, which carries bypassrls, so
// not one policy in 0002_rls.sql constrains it. Every check below is hand-written for that
// reason -- and this one can delete accounts, so it needs a guard admin-create-user did
// not: the target must belong to the caller's own vendor. Creating cannot reach another
// tenant's rows; deleting by id absolutely can.
//
// Untestable locally: there is no Deno runtime in tests/run.mjs and the local suite runs no
// GoTrue. The decisions live in ./guards.ts, which the web suite exercises. This file is
// wiring, and should stay that way.
import { createClient } from "jsr:@supabase/supabase-js@2";
import { validateDeleteUserRequest, authorizeDelete, type ErrorCode } from "./guards.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const ANON = Deno.env.get("SUPABASE_ANON_KEY")!;
const SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

// `*` is deliberate, not an oversight. CORS is not this function's auth boundary --
// verify_jwt plus the hand-written admin and tenant checks are. Narrowing the origin was
// rejected for admin-create-user for the same reasons (GitHub Pages, a possible custom
// domain) and a wrong origin fails as invisibly as no CORS at all.
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
  // The SPA's invoke is a cross-origin fetch carrying Authorization and Content-Type, so
  // the browser sends a preflight OPTIONS before the real POST and expects only headers.
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (req.method !== "POST") return fail("bad_request", 405);

  const auth = req.headers.get("Authorization");
  if (!auth) return fail("not_admin", 401);

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return fail("bad_request", 400);
  }

  const check = validateDeleteUserRequest(body);
  if (!check.ok) return fail(check.code, 400);
  const { id } = check.value;

  // The caller's OWN client: anon key plus their Authorization header. getUser() verifies
  // the JWT's signature, and the app_users reads below run under THEIR session so
  // users_read applies -- which is what makes the vendor comparison meaningful rather than
  // something the request could assert about itself.
  const caller = createClient(SUPABASE_URL, ANON, {
    global: { headers: { Authorization: auth } },
    auth: { persistSession: false },
  });

  const { data: who, error: whoError } = await caller.auth.getUser();
  if (whoError || !who?.user) return fail("not_admin", 401);

  const { data: me, error: meError } = await caller
    .from("app_users").select("vendor_id, role").eq("id", who.user.id).maybeSingle();
  if (meError || !me) return fail("not_admin", 403);

  // Read under the CALLER's session too, so users_read scopes it to their tenant. A target
  // in another shop comes back null here, which authorizeDelete answers identically to a
  // target that does not exist -- deliberately, so this cannot be used to probe for ids.
  const { data: target } = await caller
    .from("app_users").select("id, vendor_id").eq("id", id).maybeSingle();

  const verdict = authorizeDelete(
    { id: who.user.id, vendorId: me.vendor_id, role: me.role },
    target ? { id: target.id, vendorId: target.vendor_id } : null,
  );
  if (!verdict.ok) {
    const status = verdict.code === "not_admin" ? 403
      : verdict.code === "cannot_delete_self" ? 409 : 404;
    return fail(verdict.code, status);
  }

  const admin = createClient(SUPABASE_URL, SERVICE, { auth: { persistSession: false } });

  // ORDER MATTERS, and it is the opposite of the intuitive one. bills.recorder_id and
  // bills.biller_id reference app_users with no ON DELETE clause (0001_schema.sql:75-76),
  // so removing anyone who has recorded or completed a bill fails with 23503 -- the common
  // case in a working shop, not an edge case. Unlinking FIRST means that refusal leaves the
  // auth account untouched and nothing half-done. Deleting the account first would strand a
  // roster row pointing at an account that no longer exists: a ghost who cannot sign in but
  // still occupies the list.
  const { error: unlinkError } = await admin.from("app_users").delete().eq("id", id);
  if (unlinkError) {
    const history = unlinkError.code === "23503";
    return fail(history ? "has_history" : "unlink_failed", history ? 409 : 500);
  }

  const { error: deleteError } = await admin.auth.admin.deleteUser(id);
  if (deleteError) {
    // The person IS off the roster -- that write already committed -- but their email is
    // still taken. Reported honestly rather than as success: this is exactly the state
    // that made re-adding someone impossible before this function existed, and an admin
    // who thinks it is clean will hit "email already has an account" and not know why.
    console.error("admin-delete-user: unlinked but account delete failed", { id, deleteError });
    return fail("account_delete_failed", 500);
  }

  return new Response(JSON.stringify({ id }), {
    status: 200,
    headers: { "Content-Type": "application/json", ...CORS },
  });
});
