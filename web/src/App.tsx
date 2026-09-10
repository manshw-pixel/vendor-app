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
import Completed from "./screens/Completed";
import Dashboards from "./screens/Dashboards";
import Settings from "./screens/Settings";
import { homeFor } from "./routes";

/**
 * The screen a person sees between signing up and an admin linking them.
 *
 * It shows their user id because it is the ONLY place in the app that id can be read,
 * and Settings -> Staff -> Add staff asks an admin to paste exactly this value. Until an
 * Edge Function can invite by email, a panel here that said only "an admin needs to add
 * you" would leave both sides stuck: the admin has a form, and nobody can obtain what it
 * wants except through the Supabase dashboard -- which is the database access the form
 * exists to avoid.
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
          <p className="text-sm text-slate-700">{t("session.sendIdToAdmin")}</p>
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

function Inner() {
  const s = useSession();
  if (s.kind === "loading") return <div className="p-8 text-slate-400">…</div>;
  if (s.kind === "signedOut") return <Login />;
  if (s.kind === "unmapped") return <Unmapped userId={s.userId} email={s.email} />;
  if (s.kind === "error") return <SessionError detail={s.detail} />;
  if (s.kind === "mustChangePassword") return <ChangePassword email={s.email} />;

  return (
    <Shell role={s.role} vendorName={s.vendorName} name={s.name}>
      <Guard role={s.role}>
        <Routes>
          <Route path="/bill" element={<Bill />} />
          <Route path="/pending" element={<Pending />} />
          <Route path="/items" element={<Items />} />
          <Route path="/customers" element={<Customers />} />
          <Route path="/completed" element={<Completed />} />
          <Route path="/dashboards" element={<Dashboards />} />
          <Route path="/settings" element={<Settings />} />
          <Route path="/staff" element={<Navigate to="/settings" replace />} />
          <Route path="*" element={<Navigate to={homeFor(s.role)} replace />} />
        </Routes>
      </Guard>
    </Shell>
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
