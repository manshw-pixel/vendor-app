/**
 * Pure request validation and authorisation rules for admin-delete-user.
 *
 * Imports NOTHING, for the same reason as admin-create-user/guards.ts: it has to be
 * importable from both Deno and the web test suite, and the deployed handler around it
 * cannot be tested locally at all. Everything that can be decided without a database or a
 * network belongs here, where vitest can reach it.
 */

export type DeleteUserRequest = { id: string };

export type ErrorCode =
  | "bad_request"
  | "not_admin"
  | "not_your_staff"
  | "cannot_delete_self"
  | "has_history"
  | "unlink_failed"
  | "account_delete_failed";

export type GuardResult =
  | { ok: true; value: DeleteUserRequest }
  | { ok: false; code: ErrorCode };

/** app_users.id is the auth user's own id, so the request names a uuid or nothing useful. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function validateDeleteUserRequest(body: unknown): GuardResult {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return { ok: false, code: "bad_request" };
  }
  const id = (body as Record<string, unknown>).id;
  if (typeof id !== "string" || !UUID.test(id.trim())) {
    return { ok: false, code: "bad_request" };
  }
  return { ok: true, value: { id: id.trim().toLowerCase() } };
}

/**
 * Whether this caller may delete this target.
 *
 * Both rules exist because the function runs with the service_role key and NO policy
 * constrains it:
 *
 *   - Same vendor. Without this an admin of any shop could delete any auth account in the
 *     whole project just by naming its id. admin-create-user never needed the equivalent
 *     check because creating cannot reach another tenant's rows.
 *   - Not yourself. canEditStaff() already hides the button, but the UI is not the
 *     boundary. Self-deletion is the one action that can lock a vendor out of its own
 *     tenant: users_admin_write requires current_user_role() = 'admin', so once the last
 *     admin is gone nobody can undo it without hand-written SQL against production.
 */
export function authorizeDelete(
  caller: { id: string; vendorId: string; role: string },
  target: { id: string; vendorId: string } | null,
): { ok: true } | { ok: false; code: ErrorCode } {
  if (caller.role !== "admin") return { ok: false, code: "not_admin" };
  // A target that is absent and a target in another shop are answered identically on
  // purpose: telling a stranger's admin "that id exists, just not here" would turn this
  // into a way to probe for account ids across tenants.
  if (!target || target.vendorId !== caller.vendorId) {
    return { ok: false, code: "not_your_staff" };
  }
  if (target.id === caller.id) return { ok: false, code: "cannot_delete_self" };
  return { ok: true };
}
