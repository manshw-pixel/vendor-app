import { describe, it, expect } from "vitest";
import { matchCustomers, validateCustomer, isDuplicateMobile } from "../customers";

const list = [
  { id: "1", name: "Asha Patil", flat_no: "A-101", mobile: "+919812345678" },
  { id: "2", name: "Ravi Kumar", flat_no: "B-22", mobile: "+919887654321" },
];

describe("matchCustomers", () => {
  it("matches on a name fragment, case-insensitively", () => {
    expect(matchCustomers(list, "asha").map((c) => c.id)).toEqual(["1"]);
  });

  it("matches on a partial mobile number", () => {
    // A recorder types the last few digits the customer reads out, not the +91 prefix.
    expect(matchCustomers(list, "7654").map((c) => c.id)).toEqual(["2"]);
  });

  it("matches on flat number", () => {
    expect(matchCustomers(list, "b-22").map((c) => c.id)).toEqual(["2"]);
  });

  it("returns everything for an empty query", () => {
    expect(matchCustomers(list, "  ").length).toBe(2);
  });

  it("returns nothing when nothing matches", () => {
    expect(matchCustomers(list, "zzz")).toEqual([]);
  });
});

describe("validateCustomer", () => {
  it("accepts all three fields present", () => {
    expect(validateCustomer({ name: "A", flat_no: "B-1", mobile: "+9198" })).toEqual({ ok: true });
  });

  it("names every missing field, not just the first", () => {
    // Requirement #11: all three mandatory. Reporting them one at a time makes a
    // recorder submit three times to learn three things.
    expect(validateCustomer({ name: "", flat_no: " ", mobile: "" }))
      .toEqual({ ok: false, missing: ["name", "flat_no", "mobile"] });
  });
});

describe("isDuplicateMobile", () => {
  it("recognises the unique-violation on customers", () => {
    // (vendor_id, mobile) is unique. This must become "that customer already exists",
    // never a raw constraint message.
    expect(isDuplicateMobile({
      code: "23505",
      message: 'duplicate key value violates unique constraint "customers_vendor_id_mobile_key"',
    })).toBe(true);
  });

  it("does not claim unrelated errors", () => {
    expect(isDuplicateMobile({ code: "23505", message: 'unique constraint "bills_vendor_id_token_no_key"' })).toBe(false);
    expect(isDuplicateMobile({ code: "42501", message: "row-level security" })).toBe(false);
    expect(isDuplicateMobile(null)).toBe(false);
  });
});
