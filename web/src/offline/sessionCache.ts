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
    return v && typeof v.userId === "string" && v.row ? (v as Cached) : null;
  } catch { return null; }
}

export function forgetSession(): void {
  try { localStorage.removeItem(KEY); } catch { /* ignore */ }
}
