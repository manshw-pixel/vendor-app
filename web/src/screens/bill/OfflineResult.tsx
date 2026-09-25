import { useTranslation } from "react-i18next";
import { rupees } from "../../money";

/** The end of an offline sale: the device's own sequence number stands in for the token
 *  until the outbox syncs. */
export function OfflineResult({ seq, total, onStartNew }: { seq: number; total: number; onStartNew: () => void }) {
  const { t } = useTranslation();
  return (
    <div className="text-center space-y-3">
      <p className="text-3xl font-bold">Offline #{seq}</p>
      <p className="text-lg">{rupees(total)}</p>
      <p className="text-sm text-slate-500">{t("offline.willSync")}</p>
      <button onClick={onStartNew} className="w-full rounded-xl px-3 py-3 min-h-[44px] bg-emerald-600 text-white font-semibold">
        {t("bill.startNew")}
      </button>
    </div>
  );
}
