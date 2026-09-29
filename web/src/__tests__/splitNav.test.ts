import { describe, it, expect } from "vitest";
import { routesForRole, splitNav, homeFor } from "../routes";

const paths = (r: { path: string }[]) => r.map((x) => x.path);

describe("splitNav", () => {
  it("admin: four tabs, the rest grouped in More", () => {
    const { tabs, more } = splitNav(routesForRole("admin"));
    expect(paths(tabs)).toEqual(["/bill", "/pending", "/completed", "/dues"]);
    expect(paths(more)).toEqual([
      "/items", "/customers", "/stock", "/requests", "/settings",
      "/dashboards", "/sync-issues", "/close",
    ]);
    expect(more.every((r) => r.group)).toBe(true);
  });
  it("recorder and biller: all tabs, no More", () => {
    for (const role of ["recorder", "biller"] as const) {
      const { tabs, more } = splitNav(routesForRole(role));
      expect(tabs).toHaveLength(4);
      expect(more).toEqual([]);
    }
  });
  it("offline: Bill and Outbox only, for every role", () => {
    for (const role of ["recorder", "biller", "admin"] as const) {
      const { tabs, more } = splitNav(routesForRole(role, { offline: true }));
      expect(paths(tabs)).toEqual(["/bill", "/outbox"]);
      expect(more).toEqual([]);
    }
  });
  it("admin home is still /bill", () => {
    expect(homeFor("admin")).toBe("/bill");
  });
});
