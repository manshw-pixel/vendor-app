import { describe, it, expect } from "vitest";
import { sessionFromRow } from "../session";

const row = {
  name: "Manish Wadhwani",
  role: "admin" as const,
  vendor_id: "7bf7f5c7-0a6a-4ab0-a2b9-f8341f42bcf3",
  vendors: { name: "My Kirana" },
};

describe("sessionFromRow", () => {
  it("builds a ready session from an app_users row", () => {
    const s = sessionFromRow("u1", "a@b.test", row);
    expect(s).toEqual({
      kind: "ready",
      userId: "u1",
      vendorId: "7bf7f5c7-0a6a-4ab0-a2b9-f8341f42bcf3",
      vendorName: "My Kirana",
      name: "Manish Wadhwani",
      role: "admin",
    });
  });

  it("reports an authenticated user with no app_users row as unmapped", () => {
    // This is the real state of every new staff member before an admin maps them.
    // Without naming it, every query returns empty and the app looks broken.
    const s = sessionFromRow("u1", "new@b.test", null);
    // userId is part of the state, not incidental: the unmapped screen is the only
    // place in the app a person can read their own id, and an admin needs it to link
    // them. Dropping it here would leave that screen with nothing to show.
    expect(s).toEqual({ kind: "unmapped", userId: "u1", email: "new@b.test" });
  });

  it("falls back when the vendor embed is missing", () => {
    // vendors(name) is an embed; a policy change could make it come back null while
    // the app_users row is still readable. A blank header is better than a crash.
    const s = sessionFromRow("u1", "a@b.test", { ...row, vendors: null });
    expect(s.kind).toBe("ready");
    if (s.kind === "ready") expect(s.vendorName).toBe("");
  });
});
