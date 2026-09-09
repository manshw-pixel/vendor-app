import { describe, it, expect } from "vitest";
import { routesForRole, canAccess, homeFor } from "../routes";

describe("routesForRole", () => {
  it("gives the recorder billing and customers", () => {
    expect(routesForRole("recorder").map((r) => r.path)).toEqual(["/bill", "/customers"]);
  });

  it("gives the biller only the completion queue", () => {
    expect(routesForRole("biller").map((r) => r.path)).toEqual(["/pending"]);
  });

  it("gives admin the full set, including billing", () => {
    // The policies permit ('admin','recorder') to create bills and issue tokens, so the
    // UI follows the policy rather than narrowing it.
    expect(routesForRole("admin").map((r) => r.path)).toEqual([
      "/bill",
      "/pending",
      "/items",
      "/customers",
      "/staff",
      "/settings",
      "/dashboards",
    ]);
  });

  it("keeps loyalty settings away from recorders and billers", () => {
    // Politeness, not protection: vendors_admin_update is what actually refuses the
    // write. See the header comment in routes.ts.
    expect(canAccess("recorder", "/settings")).toBe(false);
    expect(canAccess("biller", "/settings")).toBe(false);
    expect(canAccess("admin", "/settings")).toBe(true);
  });
});

describe("canAccess", () => {
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
