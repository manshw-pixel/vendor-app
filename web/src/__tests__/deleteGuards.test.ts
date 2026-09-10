import { describe, it, expect } from "vitest";
import {
  validateDeleteUserRequest, authorizeDelete,
} from "../../../supabase/functions/admin-delete-user/guards";

const ID = "3f2504e0-4f89-11d3-9a0c-0305e82c3301";
const OTHER = "9c858901-8a57-4791-81fe-4c455b099bc9";

describe("validateDeleteUserRequest", () => {
  it("accepts a uuid", () => {
    const r = validateDeleteUserRequest({ id: ID });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.id).toBe(ID);
  });

  it("rejects a body that is not an object", () => {
    // Reachable by anything holding a valid JWT, not only this app's screen. A malformed
    // body must be a clean rejection, never a throw that surfaces as a server fault.
    for (const body of [null, undefined, "x", 7, []]) {
      expect(validateDeleteUserRequest(body).ok).toBe(false);
    }
  });

  it("rejects an id that is not a uuid", () => {
    expect(validateDeleteUserRequest({ id: "u2" }).ok).toBe(false);
    expect(validateDeleteUserRequest({}).ok).toBe(false);
  });

  it("lowercases the id, so it matches however it was pasted", () => {
    const r = validateDeleteUserRequest({ id: ID.toUpperCase() });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.id).toBe(ID);
  });
});

describe("authorizeDelete", () => {
  const admin = { id: ID, vendorId: "v1", role: "admin" };

  it("lets an admin delete someone else in their own shop", () => {
    expect(authorizeDelete(admin, { id: OTHER, vendorId: "v1" }).ok).toBe(true);
  });

  it("refuses a non-admin", () => {
    const r = authorizeDelete({ ...admin, role: "recorder" }, { id: OTHER, vendorId: "v1" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("not_admin");
  });

  it("refuses a target in another shop", () => {
    // The guard that matters most here. Without it, an admin of any shop could delete any
    // auth account in the project by naming its id -- the function holds the service_role
    // key and no policy constrains it.
    const r = authorizeDelete(admin, { id: OTHER, vendorId: "v2" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("not_your_staff");
  });

  it("answers a missing target exactly as it answers another shop's", () => {
    // Distinguishing them would make this an oracle for "does this account id exist
    // somewhere in the project", answerable by any vendor's admin.
    const absent = authorizeDelete(admin, null);
    const foreign = authorizeDelete(admin, { id: OTHER, vendorId: "v2" });
    expect(absent).toEqual(foreign);
  });

  it("refuses self-deletion", () => {
    // The one action that can lock a vendor out of its own tenant: users_admin_write needs
    // an admin, so once the last one is gone the repair is SQL against production.
    const r = authorizeDelete(admin, { id: ID, vendorId: "v1" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("cannot_delete_self");
  });

  it("refuses self-deletion even though the same row passes the vendor check", () => {
    // Order matters: the self check must come after the tenant check but must still fire.
    // An admin deleting themselves is always in their own vendor, so a guard that returned
    // ok as soon as the vendors matched would let it through.
    const r = authorizeDelete(admin, { id: ID, vendorId: "v1" });
    expect(r.ok).toBe(false);
  });
});
