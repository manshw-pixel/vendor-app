/**
 * Pure request validation for owner-create-vendor.
 *
 * Deliberately imports NOTHING -- not Deno, not supabase-js -- so the web test suite can
 * import it directly and these rules are actually exercised. The deployed function around
 * it cannot be tested locally at all (no Deno runtime in tests/run.mjs, no GoTrue), so
 * everything that can live here should.
 */

/**
 * Supabase's own default floor is 6. Set higher here ON PURPOSE: inheriting the platform
 * default would mean a change to it silently weakens this app, with nothing failing.
 */
export const MIN_PASSWORD_LENGTH = 8;

export type CreateVendorRequest = {
  vendor: { name: string; address: string | null; phone: string | null };
  admin: { name: string; email: string; password: string };
};

export type ErrorCode =
  | "bad_request"
  | "not_owner"
  | "email_taken"
  | "weak_password"
  | "vendor_failed"
  | "create_failed"
  | "link_failed";

export type GuardResult =
  | { ok: true; value: CreateVendorRequest }
  | { ok: false; code: ErrorCode; field?: string };

/** Deliberately loose. GoTrue is the authority on what it will accept; this only catches
 *  the obvious slip before an account is created, and must not reject an address GoTrue
 *  would have taken. */
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function validateCreateVendorRequest(body: unknown): GuardResult {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return { ok: false, code: "bad_request" };
  }
  const b = body as Record<string, unknown>;

  const vendorRaw = typeof b.vendor === "object" && b.vendor !== null ? (b.vendor as Record<string, unknown>) : {};
  const adminRaw = typeof b.admin === "object" && b.admin !== null ? (b.admin as Record<string, unknown>) : {};

  const vendorName = typeof vendorRaw.name === "string" ? vendorRaw.name.trim() : "";
  const addressTrimmed = typeof vendorRaw.address === "string" ? vendorRaw.address.trim() : "";
  const phoneTrimmed = typeof vendorRaw.phone === "string" ? vendorRaw.phone.trim() : "";
  const address = addressTrimmed === "" ? null : addressTrimmed;
  const phone = phoneTrimmed === "" ? null : phoneTrimmed;

  const adminName = typeof adminRaw.name === "string" ? adminRaw.name.trim() : "";
  const email = typeof adminRaw.email === "string" ? adminRaw.email.trim().toLowerCase() : "";
  // NOT trimmed: trimming would silently change the credential the owner read out loud.
  const password = typeof adminRaw.password === "string" ? adminRaw.password : "";

  if (vendorName === "") return { ok: false, code: "bad_request", field: "vendor.name" };
  if (adminName === "") return { ok: false, code: "bad_request", field: "admin.name" };
  if (!EMAIL.test(email)) return { ok: false, code: "bad_request", field: "admin.email" };
  if (password.length < MIN_PASSWORD_LENGTH) {
    return { ok: false, code: "weak_password", field: "admin.password" };
  }

  return {
    ok: true,
    value: {
      vendor: { name: vendorName, address, phone },
      admin: { name: adminName, email, password },
    },
  };
}
