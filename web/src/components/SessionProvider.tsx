import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { supabase } from "../supabase";
import { sessionFromRow, type AppUserRow, type SessionState } from "../session";
import { describeError } from "../errors";

const Ctx = createContext<SessionState>({ kind: "loading" });

export function useSession(): SessionState {
  return useContext(Ctx);
}

/**
 * The ONLY place app_users is read. Role and tenant come from here and nowhere else,
 * because this is what current_vendor_id() and current_user_role() resolve from in the
 * database -- a second source could disagree with the policies that enforce it.
 */
export function SessionProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<SessionState>({ kind: "loading" });

  useEffect(() => {
    let cancelled = false;

    async function load(userId: string, email: string) {
      const { data, error } = await supabase
        .from("app_users")
        .select("name, role, vendor_id, must_change_password, vendors(name)")
        .eq("id", userId)
        .maybeSingle();
      if (cancelled) return;
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

    return () => {
      cancelled = true;
      sub.subscription.unsubscribe();
    };
  }, []);

  return <Ctx.Provider value={state}>{children}</Ctx.Provider>;
}
