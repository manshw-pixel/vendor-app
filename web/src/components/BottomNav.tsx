import { useState } from "react";
import { useTranslation } from "react-i18next";
import { NavLink, useLocation } from "react-router-dom";
import { splitNav, type NavGroup, type RouteDef } from "../routes";
import { Dialog } from "../ui/Dialog";
import { NavIcon } from "./navIcons";

const GROUPS: NavGroup[] = ["setup", "reports", "endOfDay"];

function Badge({ n }: { n: number }) {
  const { t } = useTranslation();
  return (
    <span data-testid="low-stock-badge" title={t("items.lowBadge", { n })}
          className="ml-1.5 bg-amber-500 text-white text-xs rounded-full px-1.5 py-0.5 min-w-[1.25rem] text-center">
      {n}
    </span>
  );
}

const tabClass = (active: boolean) =>
  `flex-1 min-w-0 min-h-[56px] px-1 py-1 flex flex-col sm:flex-row items-center justify-center gap-0.5 sm:gap-1.5
   text-xs sm:text-sm text-center break-words leading-tight border-t-2 sm:border-t-0 sm:border-b-2 ${
    active ? "border-brand text-brand-strong font-semibold" : "border-transparent text-slate-600"}`;

/**
 * The app's navigation. Below sm: a bar fixed to the bottom of the screen, where the thumb
 * is. From sm: up, the same tabs as a strip under the header. Past five routes, the first
 * four stay as tabs and the rest go into a More sheet, grouped (splitNav).
 */
export function BottomNav({ routes, lowStock }: { routes: RouteDef[]; lowStock: number }) {
  const { t } = useTranslation();
  const { pathname } = useLocation();
  const [open, setOpen] = useState(false);
  const { tabs, more } = splitNav(routes);
  const inMore = more.some((r) => pathname === r.path || pathname.startsWith(`${r.path}/`));
  const itemsInMore = more.some((r) => r.path === "/items");

  return (
    <>
      <nav className="fixed bottom-0 inset-x-0 z-40 bg-surface border-t border-slate-200 pb-[env(safe-area-inset-bottom)]
                      sm:static sm:border-t-0 sm:border-b sm:pb-0">
        <div className="max-w-3xl mx-auto flex">
          {tabs.map((r) => (
            <NavLink key={r.path} to={r.path} className={({ isActive }) => tabClass(isActive)}>
              <NavIcon name={r.path} />
              <span>
                {t(r.labelKey)}
                {r.path === "/items" && lowStock > 0 && <Badge n={lowStock} />}
              </span>
            </NavLink>
          ))}
          {more.length > 0 && (
            <button aria-haspopup="dialog" aria-current={inMore ? "page" : undefined}
                    onClick={() => setOpen(true)} className={`relative ${tabClass(inMore)}`}>
              <NavIcon name="more" />
              <span>{t("nav.more")}</span>
              {itemsInMore && lowStock > 0 && (
                <span data-testid="more-dot" aria-hidden="true"
                      className="absolute top-2 right-1/2 translate-x-4 w-2 h-2 rounded-full bg-amber-500" />
              )}
            </button>
          )}
        </div>
      </nav>
      {open && (
        <Dialog label={t("nav.more")} onClose={() => setOpen(false)}>
          <div className="flex items-center justify-between">
            <h2 className="font-semibold text-ink">{t("nav.more")}</h2>
            <button onClick={() => setOpen(false)} aria-label={t("nav.closeMenu")}
                    className="min-h-[44px] min-w-[44px] rounded-lg text-2xl leading-none text-muted active:bg-slate-100">
              <span aria-hidden="true">×</span>
            </button>
          </div>
          {GROUPS.map((g) => {
            const rs = more.filter((r) => r.group === g);
            if (rs.length === 0) return null;
            return (
              <div key={g}>
                <h3 className="text-xs font-semibold uppercase text-muted px-1 pt-1">{t(`nav.group.${g}`)}</h3>
                <ul>
                  {rs.map((r) => (
                    <li key={r.path}>
                      <NavLink to={r.path} onClick={() => setOpen(false)}
                               className={({ isActive }) => `flex items-center min-h-[44px] px-2 rounded-lg ${
                                 isActive ? "bg-emerald-50 text-brand-strong font-semibold" : "text-ink"}`}>
                        {t(r.labelKey)}
                        {r.path === "/items" && lowStock > 0 && <Badge n={lowStock} />}
                      </NavLink>
                    </li>
                  ))}
                </ul>
              </div>
            );
          })}
        </Dialog>
      )}
    </>
  );
}
