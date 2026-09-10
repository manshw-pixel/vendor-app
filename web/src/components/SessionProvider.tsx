import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { supabase } from "../supabase";
import { sessionFromRow, type AppUserRow, type SessionState } from "../session";
import { describeError } from "../errors";

const Ctx = createContext<SessionState>({ kind: "loading" });
// A no-op default so a caller outside SessionProvider fails silently rather than crashing;
// every real render is wrapped in the provider, which replaces this with the real reload.
const ReloadCtx = createContext<() => void>(() => {});

export function useSession(): SessionState {
  return useContext(Ctx);
}

/**
 * Re-reads app_users for the signed-in user on demand.
 *
 * Exists because the alternative -- waiting on the onAuthStateChange event that
 * supabase.auth.updateUser() fires -- is not safe to depend on: that event resolves this
 * provider's own state before updateUser()'s promise returns, so a caller chaining work
 * after updateUser (ChangePassword's RPC that clears must_change_password) can lose the
 * race and read the row before its own write lands. Calling this explicitly, after the
 * caller's write is confirmed done, cannot silently drift if the library's internal event
 * ordering ever changes.
 */
export function useSessionReload(): () => void {
  return useContext(ReloadCtx);
}

/**
 * The ONLY place app_users is read. Role and tenant come from here and nowhere else,
 * because this is what current_vendor_id() and current_user_role() resolve from in the
 * database -- a second source could disagree with the policies that enforce it.
 */
export function SessionProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<SessionState>({ kind: "loading" });
  // Lets useSessionReload() reach the effect's `load`/`cancelled` without becoming a second
  // effect dependency -- reassigned every run, read only from the stable callback below.
  const reloadRef = useRef<() => void>(() => {});

  useEffect(() => {
    let cancelled = false;
    // Two loads can be in flight together: the incidental one onAuthStateChange fires on
    // every updateUser() call, and an explicit reload() issued right after. Network order
    // does not have to match issue order, so a request id lets a response that lands late
    // discard itself instead of overwriting a newer one -- issue order is what must win.
    let requestId = 0;

    async function load(userId: string, email: string) {
      const id = ++requestId;
      const { data, error } = await supabase
        .from("app_users")
        .select("name, role, vendor_id, must_change_password, vendors(name)")
        .eq("id", userId)
        .maybeSingle();
      if (cancelled || id !== requestId) return;
      // An error here is not the same as "no row": treat only a clean null as unmapped,
      // so a transient failure does not tell a real admin they are not staff.
      if (error) {
        const described = describeError(error);
        setState({ kind: "error", detail: described?.detail ?? error.message ?? "" });
        return;
      }
      setState(sessionFromRow(userId, email, (data as AppUserRow | null) ?? null));
    }

    void supabase.auth.getSession().then(({ data }) => {
      const s = data.session;
      if (cancelled) return;
      if (!s) setState({ kind: "signedOut" });
      else void load(s.user.id, s.user.email ?? "");
    });

    const { data: sub } = supabase.auth.onAuthStateChange((_e, s) => {
      if (cancelled) return;
      if (!s) setState({ kind: "signedOut" });
      else {
        setState({ kind: "loading" });
        void load(s.user.id, s.user.email ?? "");
      }
    });

    // No `loading` transition here: the caller (ChangePassword) is still mounted and
    // waiting on this to resolve `ready`, and switching to `loading` would unmount it
    // mid-flight, same as the onAuthStateChange race this function exists to avoid.
    reloadRef.current = () => {
      if (cancelled) return;
      void supabase.auth.getUser().then(({ data }) => {
        if (cancelled || !data.user) return;
        void load(data.user.id, data.user.email ?? "");
      });
    };

    return () => {
      cancelled = true;
      sub.subscription.unsubscribe();
    };
  }, []);

  const reload = useCallback(() => reloadRef.current(), []);

  return (
    <Ctx.Provider value={state}>
      <ReloadCtx.Provider value={reload}>{children}</ReloadCtx.Provider>
    </Ctx.Provider>
  );
}
