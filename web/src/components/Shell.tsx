import { useEffect, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { NavLink } from "react-router-dom";
import { supabase } from "../supabase";
import { routesForRole } from "../routes";
import { LANGS, type Lang } from "../i18n/locales";
import { setLang } from "../i18n";
import type { Role } from "../config";

export function LangSwitch() {
  const { i18n, t } = useTranslation();
  return (
    <label className="text-sm flex items-center gap-2">
      <span className="sr-only">{t("app.language")}</span>
      <select value={i18n.language as Lang} onChange={(e) => setLang(e.target.value as Lang)}
              className="border border-slate-300 rounded-lg px-2 bg-white">
        {LANGS.map((l) => <option key={l} value={l}>{l.toUpperCase()}</option>)}
      </select>
    </label>
  );
}

/** Online-only by design: tokens are issued atomically server-side and cannot be
 *  generated offline, so the app says so plainly rather than queueing work it cannot
 *  complete. */
function OfflineBanner() {
  const { t } = useTranslation();
  const [offline, setOffline] = useState(!navigator.onLine);
  useEffect(() => {
    const on = () => setOffline(false);
    const off = () => setOffline(true);
    window.addEventListener("online", on);
    window.addEventListener("offline", off);
    return () => {
      window.removeEventListener("online", on);
      window.removeEventListener("offline", off);
    };
  }, []);
  if (!offline) return null;
  return <div className="bg-amber-100 text-amber-900 text-sm px-4 py-2 text-center">{t("offline.banner")}</div>;
}

export function Shell({ role, vendorName, name, children }:
  { role: Role; vendorName: string; name: string; children: ReactNode }) {
  const { t } = useTranslation();
  return (
    <div className="min-h-screen">
      <OfflineBanner />
      <header className="bg-white border-b border-slate-200 px-4 py-3">
        <div className="max-w-3xl mx-auto flex items-center justify-between gap-3">
          <div className="min-w-0">
            <p className="font-semibold text-slate-800 truncate">{vendorName || t("app.name")}</p>
            <p className="text-xs text-slate-500 truncate">{name} · {role}</p>
          </div>
          <div className="flex items-center gap-2">
            <LangSwitch />
            <button onClick={() => void supabase.auth.signOut()}
                    className="border border-slate-300 rounded-lg px-3 text-sm bg-white">
              {t("app.signOut")}
            </button>
          </div>
        </div>
      </header>
      <nav className="bg-white border-b border-slate-200 px-4 overflow-x-auto">
        <div className="max-w-3xl mx-auto flex gap-1">
          {routesForRole(role).map((r) => (
            <NavLink key={r.path} to={r.path}
                     className={({ isActive }) =>
                       `px-3 py-2 text-sm whitespace-nowrap border-b-2 min-h-[44px] flex items-center ${
                         isActive ? "border-green-600 text-green-700 font-medium" : "border-transparent text-slate-600"}`}>
              {t(r.labelKey)}
            </NavLink>
          ))}
        </div>
      </nav>
      <main className="max-w-3xl mx-auto p-4">{children}</main>
    </div>
  );
}
