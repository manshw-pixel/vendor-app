// Creates a staff account and links it to the calling admin's vendor.
//
// THIS FUNCTION IS OUTSIDE RLS. It holds the service_role key, which carries bypassrls, so
// not one policy in 0002_rls.sql constrains it. Every tenant and role check below is
// hand-written for that reason -- the same lesson as issue_token(), at higher stakes,
// because this one can mint accounts.
//
// Untestable locally: there is no Deno runtime in tests/run.mjs and the local suite runs no
// GoTrue. Logic belongs in ./guards.ts, which the web suite does exercise. This file is
// wiring, and should stay that way.
import { createClient } from "jsr:@supabase/supabase-js@2";
import { validateCreateUserRequest, type ErrorCode } from "./guards.ts";

const URL = Deno.env.get("SUPABASE_URL")!;
const ANON = Deno.env.get("SUPABASE_ANON_KEY")!;
const SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

function fail(code: ErrorCode, status: number): Response {
  return new Response(JSON.stringify({ error: code }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return fail("bad_request", 405);

  const auth = req.headers.get("Authorization");
  if (!auth) return fail("not_admin", 401);

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return fail("bad_request", 400);
  }

  const check = validateCreateUserRequest(body);
  if (!check.ok) return fail(check.code, check.code === "weak_password" ? 422 : 400);
  const { email, password, name, role } = check.value;

  // The caller's OWN client: anon key plus their Authorization header. Two things come
  // from this and must not come from anywhere else --
  //   1. getUser() verifies the JWT's signature, so the caller is who they say;
  //   2. the app_users read runs under THEIR session, so users_read applies and the
  //      vendor_id below is the database's answer, not the request body's.
  // Taking vendor_id from the body would let any admin create staff in any shop.
  const caller = createClient(URL, ANON, {
    global: { headers: { Authorization: auth } },
    auth: { persistSession: false },
  });

  const { data: who, error: whoError } = await caller.auth.getUser();
  if (whoError || !who?.user) return fail("not_admin", 401);

  const { data: me, error: meError } = await caller
    .from("app_users")
    .select("vendor_id, role")
    .eq("id", who.user.id)
    .maybeSingle();
  if (meError || !me || me.role !== "admin") return fail("not_admin", 403);

  const admin = createClient(URL, SERVICE, { auth: { persistSession: false } });

  // email_confirm: true because production keeps confirmations on (config.toml). Without
  // it the person cannot sign in with the password the admin just handed them, which is
  // the entire point of this flow.
  const { data: created, error: createError } = await admin.auth.admin.createUser({
    email, password, email_confirm: true,
  });
  if (createError || !created?.user) {
    const already = /already|exists|registered/i.test(createError?.message ?? "");
    return fail(already ? "email_taken" : "create_failed", already ? 409 : 500);
  }

  const { error: linkError } = await admin.from("app_users").insert({
    id: created.user.id,
    vendor_id: me.vendor_id,
    role,
    name,
    must_change_password: true,
  });

  if (linkError) {
    // NOT optional. An auth account with no app_users row can sign in and resolves to no
    // tenant -- a real person stuck on the "Account not linked to a shop" panel with
    // nobody able to help them. Best-effort: if this delete also fails, that panel is
    // where they land, which is why it survives this slice.
    await admin.auth.admin.deleteUser(created.user.id).catch(() => {});
    return fail("link_failed", 500);
  }

  return new Response(JSON.stringify({ id: created.user.id }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
});
