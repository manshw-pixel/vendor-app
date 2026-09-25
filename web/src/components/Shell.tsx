import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Link, NavLink } from "react-router-dom";
import { supabase } from "../supabase";
import { routesForRole } from "../routes";
import { LANGS, type Lang } from "../i18n/locales";
import { setLang } from "../i18n";
import type { Role } from "../config";
import { useLowStock } from "../useLowStock";
import { UnclosedBanner } from "./UnclosedBanner";
import { useSession } from "./SessionProvider";
import { useOnline } from "../offline/useOnline";
import { useOutbox } from "../offline/useOutbox";

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

/** Shown while offline, or while this device holds bills the server has not accepted
 *  yet; links to the queue. */
function OfflineChip({ online, waiting, attention }: { online: boolean; waiting: number; attention: number }) {
  const { t } = useTranslation();
  if (online && waiting + attention === 0) return null;
  return (
    <Link to="/outbox" className="block bg-amber-100 text-amber-900 text-sm px-4 py-2 text-center">
      {!online && t("offline.chip")}{!online && waiting + attention > 0 && " · "}
      {waiting > 0 && t("offline.waiting", { count: waiting })}
      {waiting > 0 && attention > 0 && " · "}
      {attention > 0 && t("offline.attention", { count: attention })}
    </Link>
  );
}

export function Shell({ role, vendorName, name, children }:
  { role: Role; vendorName: string; name: string; children: ReactNode }) {
  const { t } = useTranslation();
  // Admin only: they are the role that restocks. A recorder told about low stock can
  // do nothing but worry about it.
  const lowStock = useLowStock(role === "admin");
  const session = useSession();
  const online = useOnline();
  const { waiting, attention } = useOutbox(session.kind === "ready" ? session.vendorId : null);
  return (
    <div className="min-h-screen">
      <OfflineChip online={online} waiting={waiting} attention={attention} />
      <UnclosedBanner role={role} />
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
          {routesForRole(role, { offline: !online }).map((r) => (
            <NavLink key={r.path} to={r.path}
                     className={({ isActive }) =>
                       `px-3 py-2 text-sm whitespace-nowrap border-b-2 min-h-[44px] flex items-center ${
                         isActive ? "border-green-600 text-green-700 font-medium" : "border-transparent text-slate-600"}`}>
              <>
                {t(r.labelKey)}
                {r.path === "/items" && lowStock > 0 && (
                  <span
                    data-testid="low-stock-badge"
                    title={t("items.lowBadge", { n: lowStock })}
                    className="ml-1.5 bg-amber-500 text-white text-xs rounded-full px-1.5 py-0.5 min-w-[1.25rem] text-center"
                  >
                    {lowStock}
                  </span>
                )}
              </>
            </NavLink>
          ))}
        </div>
      </nav>
      <main className="max-w-3xl mx-auto p-4">{children}</main>
    </div>
  );
}
