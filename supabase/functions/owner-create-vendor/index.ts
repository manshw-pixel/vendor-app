// Onboards a new vendor: creates the vendor row and its first admin account, called by a
// platform owner.
//
// THIS FUNCTION IS OUTSIDE RLS. It holds the service_role key, which carries bypassrls, so
// not one policy in 0002_rls.sql constrains it. Every tenant and role check below is
// hand-written for that reason -- the same lesson as admin-create-user, at higher stakes,
// because this one can mint whole vendors.
//
// Untestable locally: there is no Deno runtime in tests/run.mjs and the local suite runs no
// GoTrue. Logic belongs in ./guards.ts, which the web suite does exercise. This file is
// wiring, and should stay that way.
import { createClient } from "jsr:@supabase/supabase-js@2";
import { validateCreateVendorRequest, type ErrorCode } from "./guards.ts";

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

  const check = validateCreateVendorRequest(body);
  if (!check.ok) return fail(check.code, check.code === "weak_password" ? 422 : 400);
  const { vendor, admin } = check.value;

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

  const { data: createdVendor, error: vendorError } = await service
    .from("vendors")
    .insert({ name: vendor.name, address: vendor.address, phone: vendor.phone })
    .select("id")
    .single();
  if (vendorError || !createdVendor) return fail("vendor_failed", 500);

  // email_confirm: true because production keeps confirmations on (config.toml). Without
  // it the person cannot sign in with the password the owner just handed them, which is
  // the entire point of this flow.
  const { data: createdUser, error: createError } = await service.auth.admin.createUser({
    email: admin.email, password: admin.password, email_confirm: true,
  });
  if (createError || !createdUser?.user) {
    // NOT optional. A vendor row with no admin is a shop nobody can sign into.
    try {
      const { error: deleteError } = await service.from("vendors").delete().eq("id", createdVendor.id);
      if (deleteError) {
        console.error("owner-create-vendor: compensating vendor delete failed", {
          vendorId: createdVendor.id,
          createError,
          deleteError,
        });
      }
    } catch (deleteError) {
      console.error("owner-create-vendor: compensating vendor delete threw", {
        vendorId: createdVendor.id,
        createError,
        deleteError,
      });
    }
    const already = /already|exists|registered/i.test(createError?.message ?? "");
    return fail(already ? "email_taken" : "create_failed", already ? 409 : 500);
  }

  const { error: linkError } = await service.from("app_users").insert({
    id: createdUser.user.id,
    vendor_id: createdVendor.id,
    role: "admin",
    name: admin.name,
    must_change_password: true,
  });

  if (linkError) {
    // NOT optional. An auth account with no app_users row can sign in and resolves to no
    // tenant, and a vendor with no admin is unusable either way. Compensation order:
    // delete the auth user first, then the vendor -- both best-effort, both logged if they
    // fail, because a failure here means someone needs to clean this up by hand.
    try {
      const { error: deleteUserError } = await service.auth.admin.deleteUser(createdUser.user.id);
      if (deleteUserError) {
        console.error("owner-create-vendor: compensating deleteUser failed", {
          userId: createdUser.user.id,
          linkError,
          deleteUserError,
        });
      }
    } catch (deleteUserError) {
      console.error("owner-create-vendor: compensating deleteUser threw", {
        userId: createdUser.user.id,
        linkError,
        deleteUserError,
      });
    }
    try {
      const { error: deleteVendorError } = await service.from("vendors").delete().eq("id", createdVendor.id);
      if (deleteVendorError) {
        console.error("owner-create-vendor: compensating vendor delete failed", {
          vendorId: createdVendor.id,
          linkError,
          deleteVendorError,
        });
      }
    } catch (deleteVendorError) {
      console.error("owner-create-vendor: compensating vendor delete threw", {
        vendorId: createdVendor.id,
        linkError,
        deleteVendorError,
      });
    }
    return fail("link_failed", 500);
  }

  return new Response(JSON.stringify({ vendor_id: createdVendor.id, admin_id: createdUser.user.id }), {
    status: 200,
    headers: { "Content-Type": "application/json", ...CORS },
  });
});
