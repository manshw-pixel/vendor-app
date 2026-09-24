import { useState } from "react";
import { useTranslation } from "react-i18next";
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import { SessionProvider, useSession } from "./components/SessionProvider";
import { Login } from "./components/Login";
import { Shell } from "./components/Shell";
import { Guard } from "./components/Guard";
import { ChangePassword } from "./components/ChangePassword";
import Bill from "./screens/Bill";
import Pending from "./screens/Pending";
import Items from "./screens/Items";
import Customers from "./screens/Customers";
import Requests from "./screens/Requests";
import Stock from "./screens/Stock";
import Completed from "./screens/Completed";
import Dashboards from "./screens/Dashboards";
import CloseDay from "./screens/CloseDay";
import Dues from "./screens/Dues";
import Settings from "./screens/Settings";
import Receipt from "./screens/Receipt";
import AmendBill from "./screens/AmendBill";
import OwnerConsole from "./screens/OwnerConsole";
import { homeFor } from "./routes";
import type { Role } from "./config";
import { supabase } from "./supabase";

/**
 * The screen a person sees when their sign-in has no linked staff record.
 *
 * This is no longer a step in the normal flow: an admin now creates the account (email
 * and password) directly in Settings -> Staff, which links it at creation. This panel is
 * reached only by a failure -- an account made by hand in the Supabase dashboard, or the
 * rare case where the admin-create-user function's compensating delete also failed after
 * the link step errored. It keeps showing the user id because that is what support needs
 * to diagnose which of those happened.
 */
function Unmapped({ userId, email }: { userId: string; email: string }) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(userId);
      setCopied(true);
    } catch {
      // clipboard is HTTPS-only and can be refused outright. The id is selectable text
      // above, so failing to copy costs the reader a manual select, not the value --
      // which is why this swallows rather than reporting.
      setCopied(false);
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center p-4">
      <div className="bg-white border border-amber-200 rounded-xl p-6 max-w-md space-y-3">
        <h1 className="font-semibold text-slate-800">{t("session.unmappedTitle")}</h1>
        <p className="text-sm text-slate-600">{t("session.unmapped", { email })}</p>

        <div className="space-y-2 border-t border-slate-200 pt-3">
          <p className="text-sm text-slate-700">{t("session.notLinkedHelp")}</p>
          <p
            data-testid="session-user-id"
            className="font-mono text-xs break-all select-all bg-slate-50 border border-slate-200 rounded-lg p-2 text-slate-800"
          >
            {userId}
          </p>
          <button
            data-testid="session-copy-id" onClick={() => void copy()}
            className="border border-slate-300 rounded-lg px-3 py-2 text-sm bg-white min-h-[44px]"
          >
            {copied ? t("session.copied") : t("session.copyId")}
          </button>
        </div>
      </div>
    </div>
  );
}

// A failed lookup, NOT "you are not staff" -- a dropped connection or expired token
// must never be shown as the unmapped message above.
function SessionError({ detail }: { detail: string }) {
  const { t } = useTranslation();
  return (
    <div className="min-h-screen flex items-center justify-center p-4">
      <div className="bg-white border border-red-200 rounded-xl p-6 max-w-md">
        <h1 className="font-semibold text-slate-800 mb-2">{t("session.errorTitle")}</h1>
        <p className="text-sm text-slate-600 mb-4">{t("session.error")}</p>
        {detail && <p className="text-xs text-slate-400 mb-4">{detail}</p>}
        <button onClick={() => window.location.reload()}
                className="border border-slate-300 rounded-lg px-3 py-2 text-sm bg-white min-h-[44px]">
          {t("session.retry")}
        </button>
      </div>
    </div>
  );
}

// A shop the platform owner suspended. No nav, no routes reachable -- same reasoning as
// mustChangePassword: a boolean check inside a screen is a route that stayed reachable.
function Suspended({ vendorName, email }: { vendorName: string; email: string }) {
  const { t } = useTranslation();
  return (
    <div className="min-h-screen flex items-center justify-center p-4">
      <div className="bg-white border border-red-200 rounded-xl p-6 max-w-md space-y-3">
        <h1 data-testid="session-suspended" className="font-semibold text-slate-800">
          {t("session.suspendedTitle")}
        </h1>
        <p className="text-sm text-slate-600">
          {t("session.suspended", { vendor: vendorName, email })}
        </p>
        <button
          onClick={() => void supabase.auth.signOut()}
          className="border border-slate-300 rounded-lg px-3 py-2 text-sm bg-white min-h-[44px]"
        >
          {t("app.signOut")}
        </button>
      </div>
    </div>
  );
}

/**
 * Everything BUT the receipt, wrapped in the app chrome (header, nav, offline banner).
 *
 * Split out of Inner so /receipt/:billId can be routed OUTSIDE Shell entirely: the slip
 * is printed with window.print(), and nothing above it -- the shell's header, nav and
 * padded main -- may appear on customer paper. Routing it outside Shell rather than
 * marking the chrome no-print also keeps Shell's `main` padding away from the 58mm page
 * box, which is what previously clipped the right-hand column of every amount.
 */
function ShellRoutes({ role, vendorName, name }:
  { role: Role; vendorName: string; name: string }) {
  return (
    <Shell role={role} vendorName={vendorName} name={name}>
      <Routes>
        <Route path="/bill" element={<Bill />} />
        <Route path="/pending" element={<Pending />} />
        <Route path="/amend/:billId" element={<AmendBill />} />
        <Route path="/items" element={<Items />} />
        <Route path="/customers" element={<Customers />} />
        <Route path="/requests" element={<Requests />} />
        <Route path="/stock" element={<Stock />} />
        <Route path="/completed" element={<Completed />} />
        <Route path="/dashboards" element={<Dashboards />} />
        <Route path="/close" element={<CloseDay />} />
        <Route path="/dues" element={<Dues />} />
        <Route path="/settings" element={<Settings />} />
        <Route path="/staff" element={<Navigate to="/settings" replace />} />
        <Route path="*" element={<Navigate to={homeFor(role)} replace />} />
      </Routes>
    </Shell>
  );
}

function Inner() {
  const s = useSession();
  if (s.kind === "loading") return <div className="p-8 text-slate-400">…</div>;
  if (s.kind === "signedOut") return <Login />;
  if (s.kind === "unmapped") return <Unmapped userId={s.userId} email={s.email} />;
  if (s.kind === "error") return <SessionError detail={s.detail} />;
  if (s.kind === "mustChangePassword") return <ChangePassword email={s.email} />;
  if (s.kind === "suspended") return <Suspended vendorName={s.vendorName} email={s.email} />;
  if (s.kind === "owner") return <OwnerConsole />;

  return (
    <Guard role={s.role}>
      <Routes>
        <Route path="/receipt/:billId" element={<Receipt />} />
        <Route
          path="*"
          element={<ShellRoutes role={s.role} vendorName={s.vendorName} name={s.name} />}
        />
      </Routes>
    </Guard>
  );
}

export default function App() {
  // basename: the app is served from /vendor-app/ on GitHub Pages, not from the root.
  return (
    <BrowserRouter basename={import.meta.env.BASE_URL}>
      <SessionProvider>
        <Inner />
      </SessionProvider>
    </BrowserRouter>
  );
}
