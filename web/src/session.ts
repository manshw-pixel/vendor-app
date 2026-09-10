import type { Role } from "./config";

export type AppUserRow = {
  name: string;
  role: Role;
  vendor_id: string;
  vendors: { name: string } | null;
  must_change_password: boolean;
};

export type SessionState =
  | { kind: "loading" }
  | { kind: "signedOut" }
  // Carries userId as well as email BECAUSE this is the screen that has to show it:
  // reaching "unmapped" now means the admin-create-user link step failed, or the account
  // was made by hand outside the app, so the id is what support needs to diagnose which.
  // See App.tsx's Unmapped panel.
  | { kind: "unmapped"; userId: string; email: string }
  // Its own kind rather than a flag on `ready`, so App.tsx cannot reach the routes at all.
  // A boolean on ready would leave Shell and Guard rendering the app behind the prompt and
  // put the burden on every screen to remember the check.
  | { kind: "mustChangePassword"; userId: string; email: string }
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
  if (!row) return { kind: "unmapped", userId, email };
  // Checked before role: an admin who created their own account is in exactly the same
  // position as anyone else, because the person who typed the password knows it.
  if (row.must_change_password) return { kind: "mustChangePassword", userId, email };
  return {
    kind: "ready",
    userId,
    vendorId: row.vendor_id,
    vendorName: row.vendors?.name ?? "",
    name: row.name,
    role: row.role,
  };
}
