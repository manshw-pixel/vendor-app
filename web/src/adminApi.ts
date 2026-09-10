import { supabase } from "./supabase";
import type { NewStaffValue } from "./adminRules";
import type { ErrorCode } from "../../supabase/functions/admin-create-user/guards";
import type { ErrorCode as DeleteErrorCode } from "../../supabase/functions/admin-delete-user/guards";

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
  // The account was created before this step failed, and the compensating delete may
  // itself have failed -- unlike create_failed, "nothing was saved" would be a lie here.
  link_failed: "error.staffPartlyCreated",
};

/** Takes the map as an argument because each function has its own ErrorCode union; a
 *  shared map would have to be the union of both, and a code from one would then silently
 *  resolve against the other's key. */
async function codeFrom(
  error: { message?: string; context?: unknown },
  keys: Record<string, string>,
): Promise<string> {
  if (/failed to fetch|networkerror|load failed/i.test(error.message ?? "")) {
    return "error.offline";
  }
  const res = error.context;
  if (!(res instanceof Response)) return "error.unknown";
  try {
    const body = (await res.clone().json()) as { error?: string };
    const code = body.error;
    return (code && keys[code]) || "error.unknown";
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
  return { error: { key: await codeFrom(error, KEYS), detail: error.message ?? "" } };
}

const DELETE_KEYS: Record<DeleteErrorCode, string> = {
  not_admin: "error.notAllowed",
  bad_request: "error.unknown",
  // Absent and belonging-to-another-shop are one code by design, so this cannot be used to
  // probe for account ids across tenants. "No longer on your staff list" is true of both.
  not_your_staff: "error.staffNotFound",
  cannot_delete_self: "error.notAllowed",
  // The 23503 the database raises when the person has recorded or completed bills. The
  // same message the old direct-delete path produced, so the common failure in a working
  // shop still reads the way it always has.
  has_history: "error.staffHasHistory",
  unlink_failed: "error.unknown",
  // Off the roster but the account survives, so their email is still taken. Distinct from
  // unlink_failed because the two leave genuinely different states behind.
  account_delete_failed: "error.staffPartlyRemoved",
};

/**
 * Removes a person from this shop AND deletes their auth account.
 *
 * Went through the Edge Function rather than a direct table delete because deleting an
 * auth.users row needs the service_role key. The old direct delete left the account alive,
 * which is why a removed person's email could never be reused -- the whole reason this
 * exists.
 */
export async function deleteUserAccount(
  id: string,
): Promise<{ error: { key: string; detail: string } | null }> {
  const { error } = await supabase.functions.invoke("admin-delete-user", { body: { id } });
  if (!error) return { error: null };
  return { error: { key: await codeFrom(error, DELETE_KEYS), detail: error.message ?? "" } };
}
