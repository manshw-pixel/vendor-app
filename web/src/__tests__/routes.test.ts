import { describe, it, expect } from "vitest";
import { routesForRole, canAccess, homeFor } from "../routes";

describe("routesForRole", () => {
  it("gives the recorder billing and customers", () => {
    expect(routesForRole("recorder").map((r) => r.path)).toEqual(["/bill", "/customers", "/requests", "/stock"]);
  });

  it("gives the biller the queue and the history", () => {
    // A biller completes bills and sees each total as they do it, so the record of what
    // they completed is theirs too. bills_read would permit more; this is nav, not policy.
    expect(routesForRole("biller").map((r) => r.path)).toEqual(["/pending", "/completed", "/dues", "/close"]);
  });

  it("gives admin the full set, with staff folded into settings", () => {
    expect(routesForRole("admin").map((r) => r.path)).toEqual([
      "/bill",
      "/pending",
      "/completed",
      "/items",
      "/customers",
      "/dues",
      "/requests",
      "/stock",
      "/settings",
      "/dashboards",
      "/close",
      "/sync-issues",
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

  it("gives recorders and admins the requests screen, but not billers", () => {
    expect(canAccess("recorder", "/requests")).toBe(true);
    expect(canAccess("admin", "/requests")).toBe(true);
    // UX only -- what actually stops a biller writing one is stock_requests_staff_insert
    // in 0013_stock_requests_worklist.sql.
    expect(canAccess("biller", "/requests")).toBe(false);
  });

  it("keeps stock intake away from billers", () => {
    expect(canAccess("biller", "/stock")).toBe(false);
    expect(canAccess("recorder", "/stock")).toBe(true);
    expect(canAccess("admin", "/stock")).toBe(true);
  });

  it("gives the close screen to admin and biller, never the recorder", () => {
    expect(canAccess("admin", "/close")).toBe(true);
    expect(canAccess("biller", "/close")).toBe(true);
    expect(canAccess("recorder", "/close")).toBe(false);
  });
});

describe("homeFor", () => {
  it("lands each role on its first route", () => {
    expect(homeFor("recorder")).toBe("/bill");
    expect(homeFor("biller")).toBe("/pending");
    expect(homeFor("admin")).toBe("/bill");
  });
});

describe("the receipt route", () => {
  it("is open to the biller and the admin", () => {
    expect(canAccess("biller", "/receipt/b1")).toBe(true);
    expect(canAccess("admin", "/receipt/b1")).toBe(true);
  });

  it("is closed to the recorder", () => {
    // A recorder hands off at the token stage and never sees money; the slip carries a
    // points balance they have no reason to read. Politeness, not protection -- RLS on
    // bills, customers and points_ledger is what actually refuses the data.
    expect(canAccess("recorder", "/receipt/b1")).toBe(false);
  });

  it("does not put the receipt in the nav", () => {
    // It is reached from a bill, not from a menu: there is no useful receipt list.
    for (const role of ["admin", "recorder", "biller"] as const) {
      expect(routesForRole(role).some((r) => r.path.startsWith("/receipt"))).toBe(false);
    }
  });

  it("still matches exact paths exactly", () => {
    // The parameterised match must not turn into a prefix match: /completed must not
    // start granting /completedxyz.
    expect(canAccess("biller", "/completedxyz")).toBe(false);
    expect(canAccess("biller", "/receipt")).toBe(false);
    expect(canAccess("biller", "/receiptxyz/b1")).toBe(false);
  });
});

describe("the dues screens", () => {
  it("gives the dues screens to admin and biller, never the recorder", () => {
    expect(canAccess("admin", "/dues")).toBe(true);
    expect(canAccess("biller", "/dues/c1")).toBe(true);
    expect(canAccess("admin", "/dues/c1")).toBe(true);
    expect(canAccess("recorder", "/dues")).toBe(false);
    expect(canAccess("recorder", "/dues/c1")).toBe(false);
    expect(canAccess("biller", "/dues/c1/x")).toBe(false);
  });
});

describe("offline routes", () => {
  it("offline, every role gets Bill and the outbox and nothing else", () => {
    for (const role of ["admin", "recorder", "biller"] as const) {
      expect(routesForRole(role, { offline: true }).map((r) => r.path)).toEqual(["/bill", "/outbox"]);
      expect(canAccess(role, "/bill", { offline: true })).toBe(true);
      expect(canAccess(role, "/dues", { offline: true })).toBe(false);
      expect(homeFor(role, { offline: true })).toBe("/bill");
    }
  });
  it("online, only admin reaches sync issues; everyone reaches the outbox", () => {
    expect(canAccess("admin", "/sync-issues")).toBe(true);
    expect(canAccess("biller", "/sync-issues")).toBe(false);
    expect(canAccess("biller", "/outbox")).toBe(true);
    expect(canAccess("biller", "/bill")).toBe(false);
  });
});
