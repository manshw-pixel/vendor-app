import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
// i18next initialises as a side effect of this import, exactly as Bill.tsx does. The
// screen is rendered directly (by tests, and by the router) without going through
// main.tsx.
import "../i18n";
import { completeBill, listPending, pointsForBill, type PendingBill } from "../data";
import { describeError } from "../errors";

/**
 * The biller's queue: bills already `billed`, waiting for a customer to pay at the
 * counter. Completing one is a one-way door (stock and points move server-side, #14/#15)
 * so every completion goes through a confirm, and the button disables while the call is
 * in flight -- complete_bill is idempotent, so a double tap is harmless, but a spinner is
 * cheaper than explaining idempotency to a biller with a queue in front of them.
 */
export default function Pending() {
  const { t } = useTranslation();

  const [bills, setBills] = useState<PendingBill[] | null>(null);
  const [failure, setFailure] = useState<{ key: string; detail: string } | null>(null);
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const [completingId, setCompletingId] = useState<string | null>(null);
  const [completed, setCompleted] = useState(false);
  const [pointsAwarded, setPointsAwarded] = useState<number | null>(null);

  async function refresh() {
    const { data, error } = await listPending();
    // A policy-filtered read arrives as zero rows, not an error -- an empty queue is
    // "nothing waiting", never "not allowed".
    setFailure(describeError(error));
    setBills((data ?? []) as unknown as PendingBill[]);
  }

  useEffect(() => {
    void refresh();
  }, []);

  async function confirm(id: string) {
    setConfirmingId(null);
    setCompletingId(id);
    setCompleted(false);
    setPointsAwarded(null);
    const { error } = await completeBill(id);
    if (error) {
      setFailure(describeError(error));
      setCompletingId(null);
      return;
    }
    // What complete_bill() actually wrote, not a client-side recompute of the vendor's
    // threshold. No rows is legitimate -- a bill under the first threshold earns no
    // points and writes no ledger row -- so it is "no points", never an error.
    const { data: ledgerRows, error: pointsError } = await pointsForBill(id);
    if (!pointsError && ledgerRows && ledgerRows.length > 0) {
      setPointsAwarded(ledgerRows.reduce((sum, row) => sum + row.points, 0));
    }
    setCompletingId(null);
    setCompleted(true);
    await refresh();
  }

  return (
    <div className="space-y-4">
      <h1 className="text-lg font-semibold text-slate-800">{t("pending.title")}</h1>

      {failure && (
        <p className="border border-red-200 bg-red-50 rounded-xl p-3 text-sm text-red-700">
          {t(failure.key)} <span className="text-xs text-slate-500">{failure.detail}</span>
        </p>
      )}

      {completed && (
        <p className="border border-emerald-200 bg-emerald-50 rounded-xl p-3 text-sm text-emerald-700">
          {pointsAwarded !== null && pointsAwarded > 0
            ? t("pending.pointsAwarded", { n: pointsAwarded })
            : t("pending.completed")}
        </p>
      )}

      {bills !== null && bills.length === 0 && !failure && (
        <p className="text-slate-500 text-sm">{t("pending.empty")}</p>
      )}

      <ul className="space-y-2">
        {bills?.map((bill) => (
          <li
            key={bill.id}
            className="border border-slate-200 rounded-xl p-3 flex items-center justify-between gap-3"
          >
            <div>
              <p className="font-semibold text-slate-800">{t("pending.token", { n: bill.token_no })}</p>
              <p className="text-sm text-slate-500">
                {bill.customers ? `${bill.customers.name} · ${bill.customers.flat_no}` : "—"}
              </p>
              <p className="text-sm text-slate-700">{bill.total}</p>
            </div>
            <button
              onClick={() => setConfirmingId(bill.id)}
              disabled={completingId === bill.id}
              className="rounded-lg px-4 py-3 min-h-[44px] bg-emerald-600 text-white font-semibold disabled:opacity-50"
            >
              {t("pending.complete")}
            </button>
          </li>
        ))}
      </ul>

      {confirmingId && (
        <div
          role="dialog"
          aria-modal="true"
          className="fixed inset-0 bg-black/40 flex items-end sm:items-center justify-center p-4"
        >
          <div className="bg-white rounded-xl p-4 w-full max-w-sm space-y-3">
            <h2 className="font-semibold text-slate-800">{t("pending.confirmTitle")}</h2>
            <p className="text-slate-700">{t("pending.confirmBody")}</p>
            <button
              onClick={() => void confirm(confirmingId)}
              className="w-full rounded-lg px-3 py-3 min-h-[44px] bg-emerald-600 text-white font-semibold"
            >
              {t("pending.confirmAccept")}
            </button>
            <button
              onClick={() => setConfirmingId(null)}
              className="w-full rounded-lg px-3 py-2 min-h-[44px] border border-slate-300"
            >
              {t("bill.cancel")}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
