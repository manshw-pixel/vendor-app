import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";

/** Shown while offline, or while this device holds bills the server has not accepted
 *  yet; links to the queue. */
export function OfflineChip({ online, waiting, attention }: { online: boolean; waiting: number; attention: number }) {
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
