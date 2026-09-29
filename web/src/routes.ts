import type { Role } from "./config";

export type NavGroup = "setup" | "reports" | "endOfDay";
export type RouteDef = { path: string; labelKey: string; group?: NavGroup };

/**
 * These guards are UX, not security.
 *
 * Hiding /items from a biller is politeness; what actually stops a biller changing a
 * price is items_admin_write in supabase/migrations/0002_rls.sql. Never treat a passing
 * check here as protection, and never move an authorization decision into this file.
 *
 * The offline routes are UX too: what decides who may record an offline bill is
 * record_offline_bill in the database, when the queue is sent.
 */
const BY_ROLE: Record<Role, RouteDef[]> = {
  recorder: [
    { path: "/bill", labelKey: "nav.bill" },
    { path: "/customers", labelKey: "nav.customers" },
    { path: "/requests", labelKey: "nav.requests" },
    { path: "/stock", labelKey: "nav.stock" },
  ],
  biller: [
    { path: "/pending", labelKey: "nav.pending" },
    { path: "/completed", labelKey: "nav.completed" },
    { path: "/dues", labelKey: "nav.dues" },
    { path: "/close", labelKey: "nav.close" },
  ],
  admin: [
    { path: "/bill", labelKey: "nav.bill" },
    { path: "/pending", labelKey: "nav.pending" },
    { path: "/completed", labelKey: "nav.completed" },
    { path: "/dues", labelKey: "nav.dues" },
    { path: "/items", labelKey: "nav.items", group: "setup" },
    { path: "/customers", labelKey: "nav.customers", group: "setup" },
    { path: "/stock", labelKey: "nav.stock", group: "setup" },
    { path: "/requests", labelKey: "nav.requests", group: "setup" },
    { path: "/settings", labelKey: "nav.settings", group: "setup" },
    { path: "/dashboards", labelKey: "nav.dashboards", group: "reports" },
    { path: "/sync-issues", labelKey: "nav.syncIssues", group: "reports" },
    { path: "/close", labelKey: "nav.close", group: "endOfDay" },
  ],
};

/** Offline, every role gets the counter and the queue, and nothing that needs a server. */
const OFFLINE: RouteDef[] = [
  { path: "/bill", labelKey: "nav.bill" },
  { path: "/outbox", labelKey: "nav.outbox" },
];

type Opts = { offline?: boolean };

/**
 * Paths reachable but never listed. BY_ROLE is the nav; these are screens reached from
 * inside another screen, so putting them in BY_ROLE would print a menu entry for a page
 * that needs an id to mean anything.
 *
 * Matched by prefix + one segment, NOT by String.startsWith alone -- a bare startsWith
 * would grant /receiptxyz/b1 as well.
 */
const UNLISTED: Record<Role, readonly string[]> = {
  recorder: ["/amend"],
  biller: ["/receipt", "/dues"],
  // "/items" for /items/rate-list, opened from the Items screen.
  admin: ["/receipt", "/amend", "/dues", "/items"],
};

const matchesUnlisted = (prefix: string, path: string): boolean => {
  if (!path.startsWith(`${prefix}/`)) return false;
  const rest = path.slice(prefix.length + 1);
  return rest.length > 0 && !rest.includes("/");
};

export function routesForRole(role: Role, opts: Opts = {}): RouteDef[] {
  return opts.offline ? OFFLINE : BY_ROLE[role];
}

export function canAccess(role: Role, path: string, opts: Opts = {}): boolean {
  if (opts.offline) return OFFLINE.some((r) => r.path === path);
  // Every role can open this device's queue; online it is reached from the sync chip.
  if (path === "/outbox") return true;
  if (BY_ROLE[role].some((r) => r.path === path)) return true;
  return UNLISTED[role].some((prefix) => matchesUnlisted(prefix, path));
}

export function homeFor(role: Role, opts: Opts = {}): string {
  const first = routesForRole(role, opts)[0];
  if (!first) throw new Error(`role ${role} has no routes`);
  return first.path;
}

const MAX_TABS = 5;

/** Which routes get a bottom tab and which go behind More. Up to five fit as tabs; past
 *  that, four stay and More takes the fifth slot -- replacing a single fifth tab with a
 *  More that holds only it would cost a tap and save nothing. */
export function splitNav(routes: RouteDef[]): { tabs: RouteDef[]; more: RouteDef[] } {
  if (routes.length <= MAX_TABS) return { tabs: routes, more: [] };
  return { tabs: routes.slice(0, MAX_TABS - 1), more: routes.slice(MAX_TABS - 1) };
}
