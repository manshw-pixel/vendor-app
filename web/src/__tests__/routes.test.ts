import { describe, it, expect } from "vitest";
import { routesForRole, canAccess, homeFor } from "../routes";

describe("routesForRole", () => {
  it("gives the recorder billing and customers", () => {
    expect(routesForRole("recorder").map((r) => r.path)).toEqual(["/bill", "/customers"]);
  });

  it("gives the biller the queue and the history", () => {
    // A biller completes bills and sees each total as they do it, so the record of what
    // they completed is theirs too. bills_read would permit more; this is nav, not policy.
    expect(routesForRole("biller").map((r) => r.path)).toEqual(["/pending", "/completed"]);
  });

  it("gives admin the full set, with staff folded into settings", () => {
    expect(routesForRole("admin").map((r) => r.path)).toEqual([
      "/bill",
      "/pending",
      "/completed",
      "/items",
      "/customers",
      "/settings",
      "/dashboards",
    ]);
  });

  it("no longer lists /staff anywhere", () => {
    // The screen still exists, as a section of /settings. The route survives as a
    // redirect (App.tsx) because it has been linkable since stage 3.
    for (const role of ["admin", "recorder", "biller"] as const) {
      expect(routesForRole(role).some((r) => r.path === "/staff")).toBe(false);
    }
  });

  it("keeps the history away from recorders", () => {
    expect(canAccess("recorder", "/completed")).toBe(false);
    expect(canAccess("biller", "/completed")).toBe(true);
    expect(canAccess("admin", "/completed")).toBe(true);
  });
});

describe("canAccess", () => {
  it("keeps loyalty settings away from recorders and billers", () => {
    // Politeness, not protection: vendors_admin_update is what actually refuses the
    // write. See the header comment in routes.ts.
    expect(canAccess("recorder", "/settings")).toBe(false);
    expect(canAccess("biller", "/settings")).toBe(false);
    expect(canAccess("admin", "/settings")).toBe(true);
  });

  it("permits a route the role owns", () => {
    expect(canAccess("biller", "/pending")).toBe(true);
  });

  it("refuses a route the role does not own", () => {
    expect(canAccess("biller", "/items")).toBe(false);
  });

  it("refuses an unknown path", () => {
    expect(canAccess("admin", "/nope")).toBe(false);
  });
});

describe("homeFor", () => {
  it("lands each role on its first route", () => {
    expect(homeFor("recorder")).toBe("/bill");
    expect(homeFor("biller")).toBe("/pending");
    expect(homeFor("admin")).toBe("/bill");
  });
});
