import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import "../i18n";
import { useSession } from "../components/SessionProvider";
import { useOnline } from "../offline/useOnline";
import { useOutbox } from "../offline/useOutbox";
import { discard, listOutbox, retry, type OfflineBill } from "../offline/outbox";
import { friendlyOutboxError } from "../offline/outboxErrors";
import { rupees } from "../money";
import { Button } from "../ui/Button";
import { Banner } from "../ui/Banner";
import { Dialog } from "../ui/Dialog";
import { EmptyState } from "../ui/EmptyState";

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
  const [discarding, setDiscarding] = useState<string | null>(null);
  const cancelDiscardRef = useRef<HTMLButtonElement>(null);

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

  async function onDiscard(clientId: string) {
    if (!vendorId) return;
    setDiscarding(null);
    await discard(vendorId, clientId);
  }

  if (session.kind !== "ready") return null;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-2">
        <h1 className="text-lg font-semibold text-slate-800">{t("nav.outbox")}</h1>
        <Button variant="secondary" onClick={flushNow} disabled={!online}>
          {t("outbox.syncNow")}
        </Button>
      </div>

      {bills && bills.length === 0 && (
        <EmptyState>{t("outbox.empty")}</EmptyState>
      )}

      <ul className="divide-y divide-slate-100 border border-slate-200 rounded-xl bg-white">
        {bills?.map((b) => (
          <li key={b.clientId} className="px-3 py-3 space-y-2">
            <div className="flex items-center justify-between gap-2">
              <span className="font-medium text-slate-800">
                {t("offline.label", { seq: b.seq })} · {b.customerLabel}
              </span>
              <span className="text-slate-800">{rupees(b.take ?? b.total)}</span>
            </div>
            <p className="text-xs text-slate-500">
              {new Date(b.occurredAt).toLocaleString()} ·{" "}
              {b.state === "attention" ? t("outbox.attention") : t("outbox.waiting")}
            </p>
            {b.state === "attention" && (
              <div className="space-y-2">
                {b.error && (
                  <Banner tone="error">{friendlyOutboxError(b.error, t)}</Banner>
                )}
                <Button variant="secondary" onClick={() => void onRetry(b.clientId)}>
                  {t("outbox.retry")}
                </Button>{" "}
                <Button variant="danger" onClick={() => setDiscarding(b.clientId)}>
                  {t("outbox.discard")}
                </Button>
              </div>
            )}
          </li>
        ))}
      </ul>

      {discarding && (
        <Dialog
          label={t("outbox.discardConfirm")}
          onClose={() => setDiscarding(null)}
          initialFocusRef={cancelDiscardRef}
        >
          <p className="text-slate-800">{t("outbox.discardConfirm")}</p>
          <div className="flex gap-2 justify-end">
            <Button ref={cancelDiscardRef} variant="secondary" onClick={() => setDiscarding(null)}>
              {t("outbox.cancel")}
            </Button>
            <Button variant="danger" onClick={() => void onDiscard(discarding)}>
              {t("outbox.discard")}
            </Button>
          </div>
        </Dialog>
      )}
    </div>
  );
}
