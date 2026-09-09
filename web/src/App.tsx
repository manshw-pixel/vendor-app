import { useTranslation } from "react-i18next";
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import { SessionProvider, useSession } from "./components/SessionProvider";
import { Login } from "./components/Login";
import { Shell } from "./components/Shell";
import { Guard } from "./components/Guard";
import { Placeholder } from "./screens/Placeholder";
import Bill from "./screens/Bill";
import Pending from "./screens/Pending";
import Items from "./screens/Items";
import Customers from "./screens/Customers";
import Staff from "./screens/Staff";
import Settings from "./screens/Settings";
import { homeFor } from "./routes";

function Unmapped({ email }: { email: string }) {
  const { t } = useTranslation();
  return (
    <div className="min-h-screen flex items-center justify-center p-4">
      <div className="bg-white border border-amber-200 rounded-xl p-6 max-w-md">
        <h1 className="font-semibold text-slate-800 mb-2">{t("session.unmappedTitle")}</h1>
        <p className="text-sm text-slate-600">{t("session.unmapped", { email })}</p>
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
  if (s.kind === "unmapped") return <Unmapped email={s.email} />;
  if (s.kind === "error") return <SessionError detail={s.detail} />;

  return (
    <Shell role={s.role} vendorName={s.vendorName} name={s.name}>
      <Guard role={s.role}>
        <Routes>
          <Route path="/bill" element={<Bill />} />
          <Route path="/pending" element={<Pending />} />
          <Route path="/items" element={<Items />} />
          <Route path="/customers" element={<Customers />} />
          <Route path="/staff" element={<Staff />} />
          <Route path="/settings" element={<Settings />} />
          <Route path="/dashboards" element={<Placeholder titleKey="nav.dashboards" />} />
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
