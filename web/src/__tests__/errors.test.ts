import { describe, it, expect } from "vitest";
import { describeError } from "../errors";

describe("describeError", () => {
  it("returns null for no error", () => {
    expect(describeError(null)).toBeNull();
  });

  it("names an RLS refusal as a permission problem", () => {
    // 42501 is what a policy-blocked write raises. Showing the raw string to a biller
    // in a shop is useless; keeping it in `detail` keeps it debuggable.
    const d = describeError({ code: "42501", message: "new row violates row-level security policy" });
    expect(d?.key).toBe("error.notAllowed");
    expect(d?.detail).toContain("row-level security");
  });

  it("names a duplicate mobile as an existing customer", () => {
    // (vendor_id, mobile) is unique. "duplicate key value" is not an answer.
    const d = describeError({ code: "23505", message: 'duplicate key value violates unique constraint "customers_vendor_id_mobile_key"' });
    expect(d?.key).toBe("error.customerExists");
  });

  it("distinguishes a network failure from a refusal", () => {
    const d = describeError({ message: "Failed to fetch" });
    expect(d?.key).toBe("error.offline");
  });

  it("falls back to a generic key, keeping the raw message", () => {
    const d = describeError({ message: "something odd" });
    expect(d?.key).toBe("error.unknown");
    expect(d?.detail).toBe("something odd");
  });
});
