import { describe, it, expect } from "vitest";
import { SUPABASE_URL, SUPABASE_ANON_KEY, ROLES } from "../config";

describe("config", () => {
  it("points at the production project", () => {
    expect(SUPABASE_URL).toBe("https://cnnqidkmcxkgwxnulvig.supabase.co");
  });

  it("carries an anon key, never a service_role key", () => {
    // The payload of a Supabase JWT is base64 in the middle segment. A service_role key
    // in a browser bundle would hand every visitor the entire database, bypassing RLS --
    // so this asserts the role claim rather than trusting review to catch it.
    const parts = SUPABASE_ANON_KEY.split(".");
    expect(parts.length).toBe(3);
    const payload = JSON.parse(atob(parts[1]!));
    expect(payload.role).toBe("anon");
  });

  it("lists exactly the roles the database permits", () => {
    expect([...ROLES]).toEqual(["admin", "recorder", "biller"]);
  });
});
