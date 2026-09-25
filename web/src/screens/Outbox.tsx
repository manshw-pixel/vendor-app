import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import "../i18n";
import { useSession } from "../components/SessionProvider";
import { useOnline } from "../offline/useOnline";
import { useOutbox } from "../offline/useOutbox";
import { listOutbox, retry, type OfflineBill } from "../offline/outbox";
import { rupees } from "../money";

/**
 * This device's queue: every offline bill still waiting to sync, and every one that
 * needs a look because the server refused it. Same list/empty layout as Dues.tsx.
 *
 * Retry clears the row's own attention state, then asks useOutbox's shared flush to
 * resend it right away (rather than waiting for the next scheduled attempt), and reloads
 * once that settles.
 */
export default function Outbox() {
  const { t } = useTranslation();
  const session = useSession();
  const vendorId = session.kind === "ready" ? session.vendorId : null;
  const online = useOnline();
  const { flushNow } = useOutbox(vendorId);
  const [bills, setBills] = useState<OfflineBill[] | null>(null);

  const load = useCallback(async () => {
    if (!vendorId) return;
    setBills(await listOutbox(vendorId));
  }, [vendorId]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    const on = () => void load();
    window.addEventListener("outbox-changed", on);
    return () => window.removeEventListener("outbox-changed", on);
  }, [load]);

  async function onRetry(clientId: string) {
    if (!vendorId) return;
    await retry(vendorId, clientId);
    await flushNow();
    await load();
  }

  if (session.kind !== "ready") return null;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-2">
        <h1 className="text-lg font-semibold text-slate-800">{t("nav.outbox")}</h1>
        <button
          onClick={flushNow}
          disabled={!online}
          className="border border-slate-300 rounded-lg px-3 py-2 bg-white min-h-[44px] disabled:opacity-50"
        >
          {t("outbox.syncNow")}
        </button>
      </div>

      {bills && bills.length === 0 && (
        <p className="text-sm text-slate-500">{t("outbox.empty")}</p>
      )}

      <ul className="divide-y divide-slate-100 border border-slate-200 rounded-xl bg-white">
        {bills?.map((b) => (
          <li key={b.clientId} className="px-3 py-3 space-y-2">
            <div className="flex items-center justify-between gap-2">
              <span className="font-medium text-slate-800">
                {t("offline.label", { seq: b.seq })} · {b.customerLabel}
              </span>
              <span className="text-slate-800">{rupees(b.total)}</span>
            </div>
            <p className="text-xs text-slate-500">
              {new Date(b.occurredAt).toLocaleString()} ·{" "}
              {b.state === "attention" ? t("outbox.attention") : t("outbox.waiting")}
            </p>
            {b.state === "attention" && (
              <div className="space-y-2">
                {b.error && <p className="text-sm text-red-700">{b.error}</p>}
                <button
                  onClick={() => void onRetry(b.clientId)}
                  className="border border-slate-300 rounded-lg px-3 py-2 bg-white min-h-[44px]"
                >
                  {t("outbox.retry")}
                </button>
              </div>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
