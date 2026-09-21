import type { Role } from "./config";

export type RouteDef = { path: string; labelKey: string };

/**
 * These guards are UX, not security.
 *
 * Hiding /items from a biller is politeness; what actually stops a biller changing a
 * price is items_admin_write in supabase/migrations/0002_rls.sql. Never treat a passing
 * check here as protection, and never move an authorization decision into this file.
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
  ],
  admin: [
    { path: "/bill", labelKey: "nav.bill" },
    { path: "/pending", labelKey: "nav.pending" },
    { path: "/completed", labelKey: "nav.completed" },
    { path: "/items", labelKey: "nav.items" },
    { path: "/customers", labelKey: "nav.customers" },
    { path: "/requests", labelKey: "nav.requests" },
    { path: "/stock", labelKey: "nav.stock" },
    { path: "/settings", labelKey: "nav.settings" },
    { path: "/dashboards", labelKey: "nav.dashboards" },
  ],
};

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
  biller: ["/receipt"],
  admin: ["/receipt", "/amend"],
};

const matchesUnlisted = (prefix: string, path: string): boolean => {
  if (!path.startsWith(`${prefix}/`)) return false;
  const rest = path.slice(prefix.length + 1);
  return rest.length > 0 && !rest.includes("/");
};

export function routesForRole(role: Role): RouteDef[] {
  return BY_ROLE[role];
}

export function canAccess(role: Role, path: string): boolean {
  if (BY_ROLE[role].some((r) => r.path === path)) return true;
  return UNLISTED[role].some((prefix) => matchesUnlisted(prefix, path));
}

export function homeFor(role: Role): string {
  const first = BY_ROLE[role][0];
  if (!first) throw new Error(`role ${role} has no routes`);
  return first.path;
}
