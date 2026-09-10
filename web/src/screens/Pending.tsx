import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
// i18next initialises as a side effect of this import, exactly as Bill.tsx does. The
// screen is rendered directly (by tests, and by the router) without going through
// main.tsx.
import "../i18n";
import { completeBill, customerBalance, listPending, pointsForBill, type PendingBill } from "../data";
import { describeError } from "../errors";
import { rupees } from "../money";

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
  // Distinct from "zero points" -- a failed read must never look like an absence of
  // data. The completion itself already happened server-side, so this note sits
  // alongside the completed message rather than replacing it.
  const [pointsReadFailed, setPointsReadFailed] = useState(false);
  // The customer's spendable balance for the bill currently being confirmed, or null
  // while there is nothing to spend from (no customer, a failed read, or a zero
  // balance) -- null is also the signal that hides the redeem input entirely.
  const [balance, setBalance] = useState<number | null>(null);
  const [redeemInput, setRedeemInput] = useState("");

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

  // Opens the confirm for one bill and, if it has a customer, reads their balance so the
  // redeem input can be offered. A walk-in bill (no customer_id) skips the read entirely
  // -- there is no loyalty account to spend from, so there is nothing to look up.
  async function openConfirm(bill: PendingBill) {
    setConfirmingId(bill.id);
    setRedeemInput("");
    setBalance(null);
    if (!bill.customer_id) return;
    const { data } = await customerBalance(bill.customer_id);
    // customerBalance resolves to an array of one row, as PostgREST renders a
    // returns-table function -- not a single object.
    const row = data?.[0];
    setBalance(row && row.balance > 0 ? row.balance : null);
  }

  function clampedPoints(bill: PendingBill): number {
    const requested = Number.parseInt(redeemInput, 10);
    if (!Number.isFinite(requested) || requested <= 0 || balance === null) return 0;
    // Mirrors complete_bill()'s own cap (least(requested, balance, floor(gross))) so the
    // summary shown to the biller matches what will actually be collected. This clamp is
    // only a courtesy, though: the function's cap is authoritative, because a stale
    // balance here (another biller redeemed in the meantime) can make this one wrong.
    return Math.min(requested, balance, Math.floor(bill.total));
  }

  async function confirm(bill: PendingBill) {
    const id = bill.id;
    const points = clampedPoints(bill);
    setConfirmingId(null);
    setCompletingId(id);
    setCompleted(false);
    setPointsAwarded(null);
    setPointsReadFailed(false);
    const { error } = await completeBill(id, points);
    if (error) {
      setFailure(describeError(error));
      setCompletingId(null);
      return;
    }
    // What complete_bill() actually wrote, not a client-side recompute of the vendor's
    // threshold. No rows is legitimate -- a bill under the first threshold earns no
    // points and writes no ledger row -- so it is "no points". A failed READ is not the
    // same thing and must not be conflated with it: the bill still completed (stock and
    // any points already moved server-side), so the completion message stands, but the
    // read failure is surfaced on its own, never silently rendered as "no points".
    const { data: ledgerRows, error: pointsError } = await pointsForBill(id);
    if (pointsError) {
      setPointsReadFailed(true);
    } else if (ledgerRows && ledgerRows.length > 0) {
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

      {completed && pointsReadFailed && (
        <p className="text-xs text-amber-700">{t("pending.pointsUnknown")}</p>
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
              <p className="text-sm text-slate-700">{rupees(bill.total)}</p>
            </div>
            <button
              data-testid={`pending-complete-${bill.id}`}
              onClick={() => void openConfirm(bill)}
              disabled={completingId === bill.id}
              className="rounded-lg px-4 py-3 min-h-[44px] bg-emerald-600 text-white font-semibold disabled:opacity-50"
            >
              {t("pending.complete")}
            </button>
          </li>
        ))}
      </ul>

      {confirmingId && (() => {
        const bill = bills?.find((b) => b.id === confirmingId);
        if (!bill) return null;
        const points = clampedPoints(bill);
        const net = bill.total - points;
        return (
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="pending-confirm-title"
            className="fixed inset-0 bg-black/40 flex items-end sm:items-center justify-center p-4"
          >
            <div className="bg-white rounded-xl p-4 w-full max-w-sm space-y-3">
              <h2 id="pending-confirm-title" className="font-semibold text-slate-800">
                {t("pending.confirmTitle")}
              </h2>
              <p className="text-slate-700">{t("pending.confirmBody")}</p>

              {/* Only offered when there is a loyalty account with something in it -- a
                  walk-in bill (no customer_id) or a zero balance has nothing to spend. */}
              {balance !== null && (
                <div className="space-y-1">
                  <p className="text-sm text-slate-500">{t("pending.balance", { points: balance })}</p>
                  <label className="block text-sm text-slate-700">
                    {t("pending.redeem")}
                    <input
                      data-testid="redeem-input"
                      inputMode="numeric"
                      value={redeemInput}
                      onChange={(e) => setRedeemInput(e.target.value)}
                      className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 min-h-[44px]"
                    />
                  </label>
                  <button
                    type="button"
                    onClick={() => setRedeemInput(String(Math.min(balance, Math.floor(bill.total))))}
                    className="text-sm text-emerald-700 underline"
                  >
                    {t("pending.redeemAll")}
                  </button>
                  <p data-testid="redeem-summary" className="text-sm text-slate-700">
                    {t("pending.redeemSummary", { net: rupees(net), used: rupees(points) })}
                  </p>
                </div>
              )}

              <button
                data-testid={`pending-confirm-${bill.id}`}
                onClick={() => void confirm(bill)}
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
        );
      })()}
    </div>
  );
}
