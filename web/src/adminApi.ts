import { supabase } from "./supabase";
import type { NewStaffValue } from "./adminRules";
import type { ErrorCode } from "../../supabase/functions/admin-create-user/guards";

/**
 * The only module that calls an Edge Function.
 *
 * Kept out of admin.ts because the failure shape is different in kind: supabase-js reports
 * a non-2xx as a FunctionsHttpError whose body has to be read off error.context, not as a
 * PostgrestError with a code. describeError matches Postgres codes and message text and
 * would send every one of these to "something went wrong", so the mapping lives here.
 */

const KEYS: Record<ErrorCode, string> = {
  not_admin: "error.notAllowed",
  email_taken: "error.emailTaken",
  weak_password: "error.weakPassword",
  bad_request: "error.unknown",
  create_failed: "error.staffNotCreated",
  link_failed: "error.staffNotCreated",
};

async function codeFrom(error: { message?: string; context?: unknown }): Promise<string> {
  if (/failed to fetch|networkerror|load failed/i.test(error.message ?? "")) {
    return "error.offline";
  }
  const res = error.context;
  if (!(res instanceof Response)) return "error.unknown";
  try {
    const body = (await res.clone().json()) as { error?: string };
    const code = body.error as ErrorCode | undefined;
    return (code && KEYS[code]) || "error.unknown";
  } catch {
    // A 502 from the platform or a gateway is HTML, not our JSON. Not knowing the cause
    // is itself the honest answer here.
    return "error.unknown";
  }
}

/**
 * Creates a staff account and links it to the signed-in admin's vendor.
 *
 * The body carries NO vendor id. The function reads that from app_users under the caller's
 * own JWT, which is what stops an admin creating staff in someone else's shop -- sending
 * one from here would invite the function to trust it.
 */
export async function createUserAccount(
  value: NewStaffValue,
): Promise<{ error: { key: string; detail: string } | null }> {
  const { error } = await supabase.functions.invoke("admin-create-user", { body: value });
  if (!error) return { error: null };
  return { error: { key: await codeFrom(error), detail: error.message ?? "" } };
}
