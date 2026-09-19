import { describe, it, expect } from "vitest";
import { validateNewVendor, type NewVendorInput } from "../ownerRules";

const good: NewVendorInput = {
  vendorName: " Sharma Veg ", address: "", phone: "  ", adminName: " Ravi ",
  email: " Ravi@Shop.Test ", password: "sunflower9",
};

describe("validateNewVendor", () => {
  it("accepts a good form and shapes the request, blanks as null", () => {
    expect(validateNewVendor(good)).toEqual({ ok: true, value: {
      vendor: { name: "Sharma Veg", address: null, phone: null },
      admin: { name: "Ravi", email: "ravi@shop.test", password: "sunflower9" },
    } });
  });

  it("keeps a filled address and phone", () => {
    const r = validateNewVendor({ ...good, address: " 1 Road ", phone: " 999 " });
    expect(r.ok && r.value.vendor).toEqual({ name: "Sharma Veg", address: "1 Road", phone: "999" });
  });

  it("requires shop name, admin name, email and password", () => {
    const r = validateNewVendor({ ...good, vendorName: " ", adminName: "", email: "", password: "" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors).toEqual({
      vendorName: "owner.required", adminName: "owner.required",
      email: "owner.required", password: "owner.required",
    });
  });

  it("rejects a bad email", () => {
    const r = validateNewVendor({ ...good, email: "nope" });
    expect(!r.ok && r.errors.email).toBe("owner.badEmail");
  });

  it("rejects a password under 8 characters", () => {
    const r = validateNewVendor({ ...good, password: "1234567" });
    expect(!r.ok && r.errors.password).toBe("owner.weakPassword");
    expect(validateNewVendor({ ...good, password: "12345678" }).ok).toBe(true);
  });
});
