import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { loadReceipt, type Receipt as ReceiptData } from "../receipt";
import { itemName, type Lang } from "../i18n/locales";
import { qtyText } from "../units";
import { describeError } from "../errors";
import "../i18n";

/** Plain two-decimal, no currency sign and no digit grouping -- matching the item lines'
 *  `.toFixed(2)` so every amount on the 32-character slip lines up the same way. The
 *  spec's mock has no ₹ anywhere; `rupees()` (money.ts) is for on-screen amounts
 *  elsewhere in the app and is deliberately not used here. */
const amt = (n: number): string => n.toFixed(2);

/**
 * The 58mm slip (Slice A).
 *
 * ONE render, two media. What is on screen is what goes on paper -- the only difference
 * is the @media print block in index.css, which hides the Print button and the page
 * chrome. There is deliberately no second "printable" component: that duplication is the
 * one that drifts, and a slip that disagrees with the screen is worse than no slip.
 *
 * The layout is a fixed-width monospace block because 58mm is about 32 characters and
 * the columns have to line up. Items take two lines -- name, then qty/rate/amount --
 * because a Marathi name plus three numbers does not fit on one.
 */
export default function Receipt() {
  const { billId } = useParams<{ billId: string }>();
  const { t, i18n } = useTranslation();
  const lang = i18n.language as Lang;
  const [data, setData] = useState<ReceiptData | null>(null);
  const [problem, setProblem] = useState<{ key: string; detail: string } | null>(null);

  useEffect(() => {
    // Reset on every id change: without this, navigating receipt -> receipt without an
    // unmount in between could leave a prior bill's error banner sitting over a good
    // load, or -- with `live` guarding the stale response -- briefly race a slow load of
    // bill A into rendering under bill B's URL.
    setData(null);
    setProblem(null);
    if (!billId) return;
    let live = true;
    void (async () => {
      const { data: r, error } = await loadReceipt(billId);
      if (!live) return;
      if (r) setData(r);
      else setProblem(describeError(error) ?? { key: "receipt.notFound", detail: "" });
    })();
    return () => {
      live = false;
    };
  }, [billId]);

  // Scopes the 58mm @page rule to exactly the lifetime of this component -- see
  // index.css. A plain <style> tag rather than a stylesheet import so it can be added and
  // removed with the component instead of applying for the whole app.
  useEffect(() => {
    const style = document.createElement("style");
    style.textContent = "@page { size: 58mm auto; margin: 0; }";
    document.head.appendChild(style);
    return () => {
      document.head.removeChild(style);
    };
  }, []);

  if (problem) {
    return <p data-testid="receipt-problem" className="p-4 text-sm text-red-700">{t(problem.key)}</p>;
  }
  if (!data) return <p className="p-4 text-slate-400">{t("receipt.loading")}</p>;

  const when = new Date(data.completed_at);
  const rule = <div aria-hidden className="border-t border-dashed border-slate-400 my-1" />;

  return (
    <div className="flex flex-col items-center">
      {/* Hidden on paper by the print block: a receipt with a button on it is a bug. */}
      <button
        data-testid="receipt-print" onClick={() => window.print()}
        className="receipt-noprint mb-3 rounded-lg px-4 py-2 text-sm bg-slate-800 text-white min-h-[44px]"
      >
        {t("receipt.print")}
      </button>

      <div className="receipt-slip font-mono text-[11px] leading-tight text-black bg-white p-2">
        {data.voided && (
          <div data-testid="receipt-voided" className="text-center font-bold">
            <div>{t("receipt.voided")}</div>
            <div>{t("receipt.voidedReason", { reason: data.voided.reason })}</div>
          </div>
        )}
        <div data-testid="receipt-shop" className="text-center">
          <div className="font-bold">{data.shop.name}</div>
          {data.shop.address && <div data-testid="receipt-shop-address">{data.shop.address}</div>}
          {data.shop.phone && <div>{data.shop.phone}</div>}
        </div>
        {rule}

        <div data-testid="receipt-token" className="flex justify-between">
          <span>{t("receipt.token", { n: data.token_no })}</span>
        </div>
        <div className="flex justify-between">
          <span>{when.toLocaleDateString()}</span>
          <span>{when.toLocaleTimeString()}</span>
        </div>
        {data.customer && (
          <div data-testid="receipt-customer" className="flex justify-between gap-2">
            <span className="truncate">{data.customer.name}</span>
            <span className="whitespace-nowrap">{data.customer.flat_no}</span>
          </div>
        )}
        {rule}

        <ul>
          {data.lines.map((l) => (
            <li key={l.id} data-testid={`receipt-line-${l.id}`}>
              <div className="truncate">{l.items ? itemName(l.items, lang) : "—"}</div>
              <div className="flex justify-between pl-2">
                <span>{`${qtyText(l.qty_kg, l.items?.unit ?? "kg", t)} x ${l.unit_price.toFixed(2)}`}</span>
                <span>{l.line_total.toFixed(2)}</span>
              </div>
            </li>
          ))}
        </ul>
        {rule}

        <div data-testid="receipt-subtotal" className="flex justify-between">
          <span>{t("receipt.items", { n: data.lines.length })}</span>
          <span>{`${t("receipt.subtotal")} ${amt(data.gross)}`}</span>
        </div>
        {data.redeemed_points > 0 && (
          <div data-testid="receipt-redeemed" className="flex justify-between">
            <span>{t("receipt.redeemed")}</span>
            <span>{`- ${amt(data.redeemed_points)}`}</span>
          </div>
        )}
        <div data-testid="receipt-total" className="flex justify-between font-bold">
          <span>{t("receipt.total")}</span>
          <span>{amt(data.net)}</span>
        </div>
        {data.voided && (
          <div data-testid="receipt-voided-foot" className="font-bold text-center">
            {t("receipt.voided")} — {t("receipt.voidedReason", { reason: data.voided.reason })}
          </div>
        )}
        {/* A credit bill was not paid, so it gets a due row in place of "Paid" -- and
            that row already names the mode, so no separate mode line follows it. */}
        {data.payment_mode === "credit" ? (
          <div data-testid="receipt-credit-due" className="flex justify-between">
            <span>{t("receipt.onCredit")}</span>
            <span>{amt(data.net)}</span>
          </div>
        ) : (
          <>
            <div data-testid="receipt-paid" className="flex justify-between">
              <span>{t("receipt.paid")}</span>
              <span>{amt(data.net)}</span>
            </div>
            {data.payment_mode && (
              <div data-testid="receipt-mode" className="text-center">
                {t("receipt.paidBy", { mode: t(`pay.${data.payment_mode}`) })}
              </div>
            )}
            {data.due_collected > 0 && (
              <>
                <div data-testid="receipt-due-paid" className="flex justify-between">
                  <span>{t("receipt.duePaid")}</span>
                  <span>{amt(data.due_collected)}</span>
                </div>
                <div data-testid="receipt-total-collected" className="flex justify-between font-bold">
                  <span>{t("receipt.totalCollected")}</span>
                  <span>{amt(data.net + data.due_collected)}</span>
                </div>
              </>
            )}
          </>
        )}

        {data.balance && (
          <>
            {rule}
            <div data-testid="receipt-points">
              <div className="flex justify-between">
                <span>{t("receipt.pointsEarned")}</span>
                <span>{data.points_earned}</span>
              </div>
              <div className="flex justify-between">
                <span>{t("receipt.balance")}</span>
                <span>{data.balance.balance}</span>
              </div>
              {/* The line this whole slice makes visible for the first time. Omitted at a
                  zero balance, where there is no deadline to miss. */}
              {data.balance.balance > 0 && data.balance.days_left !== null && (
                <div data-testid="receipt-expires">
                  {t("receipt.expires", {
                    date: new Date(
                      Date.now() + data.balance.days_left * 86_400_000,
                    ).toLocaleDateString(),
                    days: data.balance.days_left,
                  })}
                </div>
              )}
            </div>
          </>
        )}

        {rule}
        <div className="text-center">
          {data.biller_name && (
            <span data-testid="receipt-served-by">
              {t("receipt.servedBy", { name: data.biller_name })}{" · "}
            </span>
          )}
          {t("receipt.thanks")}
        </div>
      </div>
    </div>
  );
}
