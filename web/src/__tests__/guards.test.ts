import { describe, it, expect } from "vitest";
import {
  validateCreateUserRequest, MIN_PASSWORD_LENGTH,
} from "../../../supabase/functions/admin-create-user/guards";

const good = { email: "rina@shop.test", password: "sunflower9", name: "Rina", role: "recorder" };

describe("validateCreateUserRequest", () => {
  it("accepts a well-formed request", () => {
    const r = validateCreateUserRequest(good);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toEqual(good);
  });

  it("rejects a body that is not an object at all", () => {
    // The function is reachable by anything holding a valid JWT, not only this SPA.
    // A malformed body must be a clean 400, never a crash that reads as a 500.
    for (const body of [null, undefined, "rina", 42, []]) {
      expect(validateCreateUserRequest(body).ok).toBe(false);
    }
  });

  it("rejects a role outside the three the column allows", () => {
    // 0001_schema.sql:36 -- role in ('admin','recorder','biller'). Anything else is a
    // 23514 from the database AFTER the auth account has already been created, which is
    // the expensive way to find out.
    const r = validateCreateUserRequest({ ...good, role: "owner" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.field).toBe("role");
  });

  it("rejects a password below the floor this project sets", () => {
    const r = validateCreateUserRequest({ ...good, password: "a".repeat(MIN_PASSWORD_LENGTH - 1) });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("weak_password");
  });

  it("sets its own floor rather than inheriting Supabase's", () => {
    // Supabase's own default minimum is 6. If this constant ever equals it, a change to
    // the platform default silently weakens this app.
    expect(MIN_PASSWORD_LENGTH).toBeGreaterThan(6);
  });

  it("rejects a blank name", () => {
    const r = validateCreateUserRequest({ ...good, name: "   " });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.field).toBe("name");
  });

  it("rejects something that is not an email address", () => {
    for (const email of ["rina", "rina@", "@shop.test", "rina shop@test.com", ""]) {
      const r = validateCreateUserRequest({ ...good, email });
      expect(r.ok, `should reject ${JSON.stringify(email)}`).toBe(false);
    }
  });

  it("lowercases and trims the email, because GoTrue treats it case-insensitively", () => {
    const r = validateCreateUserRequest({ ...good, email: "  Rina@Shop.Test  " });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.email).toBe("rina@shop.test");
  });

  it("trims the name but never the password", () => {
    // Trimming a password silently changes the credential the admin read out loud.
    const r = validateCreateUserRequest({ ...good, name: "  Rina  ", password: " pass word " });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.name).toBe("Rina");
      expect(r.value.password).toBe(" pass word ");
    }
  });
});
