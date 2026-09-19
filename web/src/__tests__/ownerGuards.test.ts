import { describe, it, expect } from "vitest";
import {
  validateCreateVendorRequest, MIN_PASSWORD_LENGTH,
} from "../../../supabase/functions/owner-create-vendor/guards";
import {
  validateSuspendRequest, BAN_DURATION, UNBAN,
} from "../../../supabase/functions/owner-suspend-vendor/guards";

const goodCreate = {
  vendor: { name: "Shree Traders", address: "12 MG Road", phone: "9876543210" },
  admin: { name: "Rina", email: "rina@shop.test", password: "sunflower9" },
};

describe("validateCreateVendorRequest", () => {
  it("accepts a well-formed request", () => {
    const r = validateCreateVendorRequest(goodCreate);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toEqual(goodCreate);
  });

  it("treats omitted address/phone as null", () => {
    const r = validateCreateVendorRequest({
      vendor: { name: "Shree Traders" },
      admin: goodCreate.admin,
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.vendor.address).toBeNull();
      expect(r.value.vendor.phone).toBeNull();
    }
  });

  it("rejects a body that is not an object at all", () => {
    for (const body of [null, undefined, "rina", 42, []]) {
      expect(validateCreateVendorRequest(body).ok).toBe(false);
    }
  });

  it("rejects a blank vendor name", () => {
    const r = validateCreateVendorRequest({ ...goodCreate, vendor: { ...goodCreate.vendor, name: "   " } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.field).toBe("vendor.name");
  });

  it("rejects a blank admin name", () => {
    const r = validateCreateVendorRequest({ ...goodCreate, admin: { ...goodCreate.admin, name: "  " } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.field).toBe("admin.name");
  });

  it("rejects a bad admin email", () => {
    const r = validateCreateVendorRequest({ ...goodCreate, admin: { ...goodCreate.admin, email: "rina@" } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.field).toBe("admin.email");
  });

  it("rejects a password below the floor", () => {
    const r = validateCreateVendorRequest({
      ...goodCreate,
      admin: { ...goodCreate.admin, password: "a".repeat(MIN_PASSWORD_LENGTH - 1) },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("weak_password");
  });

  it("never trims the password", () => {
    const r = validateCreateVendorRequest({
      ...goodCreate,
      admin: { ...goodCreate.admin, password: " pass word " },
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.admin.password).toBe(" pass word ");
  });

  it("lowercases and trims the admin email", () => {
    const r = validateCreateVendorRequest({
      ...goodCreate,
      admin: { ...goodCreate.admin, email: "  Rina@Shop.Test  " },
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.admin.email).toBe("rina@shop.test");
  });
});

const vendorId = "11111111-2222-3333-4444-555555555555";

describe("validateSuspendRequest", () => {
  it("accepts suspend", () => {
    const r = validateSuspendRequest({ vendor_id: vendorId, action: "suspend" });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toEqual({ vendor_id: vendorId, action: "suspend" });
  });

  it("accepts reinstate", () => {
    const r = validateSuspendRequest({ vendor_id: vendorId, action: "reinstate" });
    expect(r.ok).toBe(true);
  });

  it("rejects a non-uuid vendor_id", () => {
    const r = validateSuspendRequest({ vendor_id: "not-a-uuid", action: "suspend" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("bad_request");
  });

  it("rejects an unknown action", () => {
    const r = validateSuspendRequest({ vendor_id: vendorId, action: "delete" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("bad_request");
  });

  it("exposes the ban duration constants", () => {
    expect(BAN_DURATION).toBe("876000h");
    expect(UNBAN).toBe("none");
  });
});
