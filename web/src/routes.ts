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
  ],
  biller: [{ path: "/pending", labelKey: "nav.pending" }],
  admin: [
    { path: "/bill", labelKey: "nav.bill" },
    { path: "/pending", labelKey: "nav.pending" },
    { path: "/items", labelKey: "nav.items" },
    { path: "/customers", labelKey: "nav.customers" },
    { path: "/staff", labelKey: "nav.staff" },
    { path: "/settings", labelKey: "nav.settings" },
    { path: "/dashboards", labelKey: "nav.dashboards" },
  ],
};

export function routesForRole(role: Role): RouteDef[] {
  return BY_ROLE[role];
}

export function canAccess(role: Role, path: string): boolean {
  return BY_ROLE[role].some((r) => r.path === path);
}

export function homeFor(role: Role): string {
  const first = BY_ROLE[role][0];
  if (!first) throw new Error(`role ${role} has no routes`);
  return first.path;
}
