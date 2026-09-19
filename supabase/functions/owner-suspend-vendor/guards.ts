/**
 * Pure request validation for owner-suspend-vendor.
 *
 * Deliberately imports NOTHING -- not Deno, not supabase-js -- so the web test suite can
 * import it directly and these rules are actually exercised. The deployed function around
 * it cannot be tested locally at all (no Deno runtime in tests/run.mjs, no GoTrue), so
 * everything that can live here should.
 */

export type SuspendRequest = { vendor_id: string; action: "suspend" | "reinstate" };

export type ErrorCode = "bad_request" | "not_owner" | "not_found" | "update_failed";

export type GuardResult =
  | { ok: true; value: SuspendRequest }
  | { ok: false; code: ErrorCode; field?: string };

// GoTrue/Postgres uuid shape, not a strict RFC 4122 validator -- close enough to catch a
// garbled id before it hits the database.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const ACTIONS = ["suspend", "reinstate"] as const;

/** ban_duration understood by GoTrue's admin.updateUserById. 876000h ~= 100 years. */
export const BAN_DURATION = "876000h";
export const UNBAN = "none";

export function validateSuspendRequest(body: unknown): GuardResult {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return { ok: false, code: "bad_request" };
  }
  const b = body as Record<string, unknown>;

  const vendorId = typeof b.vendor_id === "string" ? b.vendor_id.trim() : "";
  const action = typeof b.action === "string" ? b.action : "";

  if (!UUID.test(vendorId)) return { ok: false, code: "bad_request", field: "vendor_id" };
  if (!(ACTIONS as readonly string[]).includes(action)) {
    return { ok: false, code: "bad_request", field: "action" };
  }

  return { ok: true, value: { vendor_id: vendorId, action: action as "suspend" | "reinstate" } };
}
