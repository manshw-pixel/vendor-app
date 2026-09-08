import { Navigate, useLocation } from "react-router-dom";
import { canAccess, homeFor } from "../routes";
import type { Role } from "../config";
import type { ReactNode } from "react";

/**
 * UX only. A biller who types /items into the address bar is redirected as a courtesy;
 * what actually stops them changing a price is items_admin_write in the database. Do not
 * add an authorization decision here that the policies do not already make.
 */
export function Guard({ role, children }: { role: Role; children: ReactNode }) {
  const { pathname } = useLocation();
  if (!canAccess(role, pathname)) return <Navigate to={homeFor(role)} replace />;
  return <>{children}</>;
}
