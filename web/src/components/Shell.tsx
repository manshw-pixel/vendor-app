import { useEffect, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { routesForRole } from "../routes";
import { BottomNav } from "./BottomNav";
import type { Lang } from "../i18n/locales";
import { setLang } from "../i18n";
import type { Role } from "../config";
import { useLowStock } from "../useLowStock";
import { UnclosedBanner, useUnclosedDays } from "./UnclosedBanner";
import { useSession } from "./SessionProvider";
import { useOnline } from "../offline/useOnline";
import { useRouteOffline } from "../offline/useRouteOffline";
import { OfflineChip } from "./OfflineChip";
import { useOutbox } from "../offline/useOutbox";
import { useSnapshotRefresh } from "../offline/useSnapshotRefresh";
import { getUpdateReady, onUpdateReady } from "../offline/updateReady";
import { SegmentedControl } from "../ui/SegmentedControl";
import { AccountSheet } from "./AccountSheet";
import { Button } from "../ui/Button";

// Display order, independent of LANGS (which is ordered for default-language resolution,
// not for how the picker reads left to right).
const DISPLAY_LANGS: Lang[] = ["en", "hi", "mr"];

export function LangSwitch() {
  const { i18n, t } = useTranslation();
  return (
    <SegmentedControl<Lang>
      label={t("app.language")}
      value={i18n.language as Lang}
      onChange={(l) => setLang(l)}
      options={DISPLAY_LANGS.map((l) => ({ value: l, label: t(`app.langName.${l}`) }))}
    />
  );
}

/** Shown when a new service worker has installed alongside the current one. Reloading is
 *  always the person's choice: an unattended reload could wipe an in-progress bill. */
export function useUpdateReady(): ServiceWorkerRegistration | null {
  // Read any registration recorded before this component mounted (e.g. install finished
  // during the initial page load, ahead of Shell's first render) as well as subscribing
  // for one that arrives later.
  const [reg, setReg] = useState<ServiceWorkerRegistration | null>(() => getUpdateReady());
  useEffect(() => onUpdateReady(setReg), []);
  return reg;
}

export function pickStrip({ offline, unclosed, update }: { offline: boolean; unclosed: boolean; update: boolean }):
  "offline" | "unclosed" | "update" | null {
  // Unsent bills are money at risk; a reload is always optional.
  if (offline) return "offline";
  if (unclosed) return "unclosed";
  if (update) return "update";
  return null;
}

export function UpdateBanner() {
  const { t } = useTranslation();
  const reg = useUpdateReady();
  if (!reg) return null;
  return (
    <div className="bg-emerald-100 text-emerald-900 text-sm px-4 py-2 text-center flex items-center justify-center gap-3">
      <span>{t("app.updateReady")}</span>
      <Button
        variant="secondary" size="md"
        className="!min-h-0 border-emerald-700 bg-surface px-2 py-0.5"
        onClick={() => {
          navigator.serviceWorker.addEventListener("controllerchange", () => window.location.reload(), { once: true });
          reg.waiting?.postMessage("skip-waiting");
        }}
      >
        {t("app.reload")}
      </Button>
    </div>
  );
}

export function Shell({ role, vendorName, name, children }:
  { role: Role; vendorName: string; name: string; children: ReactNode }) {
  const { t } = useTranslation();
  const [accountOpen, setAccountOpen] = useState(false);
  // Admin only: they are the role that restocks. A recorder told about low stock can
  // do nothing but worry about it.
  const lowStock = useLowStock(role === "admin");
  const session = useSession();
  const online = useOnline();
  const routeOffline = useRouteOffline();
  const { waiting, attention } = useOutbox(session.kind === "ready" ? session.vendorId : null);
  const days = useUnclosedDays(role);
  const reg = useUpdateReady();
  const strip = pickStrip({ offline: !online || waiting + attention > 0, unclosed: days.length > 0, update: !!reg });
  useSnapshotRefresh(session.kind === "ready" ? session.vendorId : null,
                     session.kind === "ready" && !!session.fromCache);
  return (
    <div className="min-h-screen">
      {strip === "offline" && <OfflineChip online={online} waiting={waiting} attention={attention} />}
      {strip === "unclosed" && <UnclosedBanner days={days} />}
      {strip === "update" && <UpdateBanner />}
      <header className="bg-surface border-b border-slate-200 px-4 py-3">
        <div className="max-w-3xl mx-auto flex items-center justify-between gap-3">
          <p className="font-semibold text-ink truncate min-w-0">{vendorName || t("app.name")}</p>
          <button data-testid="account-button" aria-haspopup="dialog" onClick={() => setAccountOpen(true)}
                  className="min-h-[44px] flex items-center gap-2 rounded-full border border-slate-300 bg-surface pl-1 pr-3 text-sm text-ink max-w-[50%]">
            <span aria-hidden="true" className="w-8 h-8 rounded-full bg-emerald-50 text-brand-strong font-semibold flex items-center justify-center">
              {name.trim().charAt(0).toUpperCase() || "?"}
            </span>
            <span className="truncate">{name}</span>
          </button>
        </div>
      </header>
      {accountOpen && <AccountSheet name={name} role={role} onClose={() => setAccountOpen(false)} />}
      <BottomNav routes={routesForRole(role, { offline: routeOffline })} lowStock={lowStock} />
      <main className="max-w-3xl mx-auto p-4 pb-40 sm:pb-24">{children}</main>
    </div>
  );
}
