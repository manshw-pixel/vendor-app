import type { AppUserRow } from "../session";

const KEY = "vendor-app:last-session";
type Cached = { userId: string; email: string; row: AppUserRow };

/** Lets a reload with no network open the counter as the last person signed in. The
 *  server re-checks everything when the queue is sent, so this grants nothing there. */
export function rememberSession(userId: string, email: string, row: AppUserRow): void {
  try { localStorage.setItem(KEY, JSON.stringify({ userId, email, row })); } catch { /* private mode */ }
}

export function recallSession(): Cached | null {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? "null");
    return v && typeof v.userId === "string" && v.row
      && typeof v.row.role === "string" && typeof v.row.vendor_id === "string" ? (v as Cached) : null;
  } catch { return null; }
}

export function forgetSession(): void {
  try { localStorage.removeItem(KEY); } catch { /* ignore */ }
}

/** True while supabase-js still holds an auth token on this device. A device whose stored
 *  session is gone (signed out, expired and cleared) must open signed out, even offline. */
export function hasStoredAuthToken(): boolean {
  try {
    for (let i = 0; i < localStorage.length; i++) {
      if (/^sb-.*-auth-token$/.test(localStorage.key(i) ?? "")) return true;
    }
  } catch { /* storage blocked */ }
  return false;
}
