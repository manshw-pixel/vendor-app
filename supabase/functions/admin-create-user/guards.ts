/**
 * Pure request validation for admin-create-user.
 *
 * Deliberately imports NOTHING -- not Deno, not supabase-js -- so the web test suite can
 * import it directly and these rules are actually exercised. The deployed function around
 * it cannot be tested locally at all (no Deno runtime in tests/run.mjs, no GoTrue), so
 * everything that can live here should.
 */

/**
 * Exactly the values app_users.role permits (0001_schema.sql check constraint).
 * A parallel copy exists in web/src/config.ts; this is intentional to keep Deno imports
 * out of the Edge Function bundle. The check constraint at 0001_schema.sql:36 is the
 * single source of truth.
 */
export const ROLES = ["admin", "recorder", "biller"] as const;
export type Role = (typeof ROLES)[number];

/**
 * Supabase's own default floor is 6. Set higher here ON PURPOSE: inheriting the platform
 * default would mean a change to it silently weakens this app, with nothing failing.
 */
export const MIN_PASSWORD_LENGTH = 8;

export type CreateUserRequest = {
  email: string;
  password: string;
  name: string;
  role: Role;
};

export type ErrorCode =
  | "bad_request"
  | "not_admin"
  | "email_taken"
  | "weak_password"
  | "create_failed"
  | "link_failed";

export type GuardResult =
  | { ok: true; value: CreateUserRequest }
  | { ok: false; code: ErrorCode; field?: string };

/** Deliberately loose. GoTrue is the authority on what it will accept; this only catches
 *  the obvious slip before an account is created, and must not reject an address GoTrue
 *  would have taken. */
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function validateCreateUserRequest(body: unknown): GuardResult {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return { ok: false, code: "bad_request" };
  }
  const b = body as Record<string, unknown>;

  const email = typeof b.email === "string" ? b.email.trim().toLowerCase() : "";
  const name = typeof b.name === "string" ? b.name.trim() : "";
  // NOT trimmed: trimming would silently change the credential the admin read out loud.
  const password = typeof b.password === "string" ? b.password : "";
  const role = typeof b.role === "string" ? b.role : "";

  if (!EMAIL.test(email)) return { ok: false, code: "bad_request", field: "email" };
  if (name === "") return { ok: false, code: "bad_request", field: "name" };
  if (!(ROLES as readonly string[]).includes(role)) {
    return { ok: false, code: "bad_request", field: "role" };
  }
  if (password.length < MIN_PASSWORD_LENGTH) {
    return { ok: false, code: "weak_password", field: "password" };
  }

  return { ok: true, value: { email, password, name, role: role as Role } };
}
