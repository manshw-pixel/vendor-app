import { useTranslation } from "react-i18next";
import { rupees } from "../../money";
import { Button } from "../../ui/Button";

/** The end of an offline sale: the device's own sequence number stands in for the token
 *  until the outbox syncs. */
export function OfflineResult({ seq, total, onStartNew }: { seq: number; /** The amount to take, not the gross bill. */ total: number; onStartNew: () => void }) {
  const { t } = useTranslation();
  return (
    <div className="text-center space-y-3">
      <p className="text-3xl font-bold">{t("offline.label", { seq })}</p>
      <p className="text-lg">{rupees(total)}</p>
      <p className="text-sm text-slate-500">{t("offline.willSync")}</p>
      <Button size="lg" onClick={onStartNew} className="w-full">
        {t("bill.startNew")}
      </Button>
    </div>
  );
}
