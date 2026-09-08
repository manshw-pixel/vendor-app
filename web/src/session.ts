import type { Role } from "./config";

export type AppUserRow = {
  name: string;
  role: Role;
  vendor_id: string;
  vendors: { name: string } | null;
};

export type SessionState =
  | { kind: "loading" }
  | { kind: "signedOut" }
  | { kind: "unmapped"; email: string }
  | { kind: "error"; detail: string }
  | {
      kind: "ready";
      userId: string;
      vendorId: string;
      vendorName: string;
      name: string;
      role: Role;
    };

/**
 * app_users is the ONLY source of role and tenant: it is what current_vendor_id() and
 * current_user_role() resolve from in the database. Deciding role any other way in the
 * UI would risk disagreeing with the policies that actually enforce it.
 */
export function sessionFromRow(
  userId: string,
  email: string,
  row: AppUserRow | null,
): SessionState {
  if (!row) return { kind: "unmapped", email };
  return {
    kind: "ready",
    userId,
    vendorId: row.vendor_id,
    vendorName: row.vendors?.name ?? "",
    name: row.name,
    role: row.role,
  };
}
