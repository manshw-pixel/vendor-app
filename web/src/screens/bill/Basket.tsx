import { useTranslation } from "react-i18next";
import { lineTotal, runningTotal, type Draft } from "../../billing";
import { rupees } from "../../money";

/** The total here is FEEDBACK. issue_token recomputes the real one from bill_items, and
 *  nothing on this screen ever sends a total to the server. */
export function Basket({
  lines,
  onRemove,
  frozen = false,
}: {
  lines: readonly Draft[];
  onRemove: (index: number) => void;
  /** Set once the lines are in the database and only the token is missing: editing then
   *  would silently diverge from the rows a retry is about to have tokenised. */
  frozen?: boolean;
}) {
  const { t } = useTranslation();

  return (
    <div className="border border-slate-200 rounded-xl bg-white">
      <h2 className="font-semibold text-slate-800 px-3 pt-3">{t("bill.basket")}</h2>
      {lines.length === 0 ? (
        <p className="text-sm text-slate-500 p-3">{t("bill.empty")}</p>
      ) : (
        <ul className="divide-y divide-slate-100">
          {lines.map((l, i) => (
            <li key={`${l.itemId}-${i}`}>
              <button
                onClick={() => onRemove(i)}
                disabled={frozen}
                aria-label={`${t("bill.remove")} ${l.name}`}
                className="w-full px-3 py-3 min-h-[44px] text-left active:bg-slate-100 disabled:opacity-60"
              >
                <span className="flex justify-between items-baseline gap-3">
                  <span className="font-medium text-slate-800">{l.name}</span>
                  {/* Read back to the customer line by line; do not make the recorder
                      multiply while holding a bag of onions. */}
                  <span className="font-medium text-slate-800 tabular-nums">
                    {rupees(lineTotal(l.unitPrice, l.qtyKg))}
                  </span>
                </span>
                <span className="block text-xs text-slate-500">
                  {t("bill.qtyLine", { qty: l.qtyKg })} × {rupees(l.unitPrice)}
                  {!frozen && ` · ${t("bill.remove")}`}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="flex justify-between items-center border-t border-slate-200 px-3 py-3">
        <span className="text-slate-600">{t("bill.total")}</span>
        <span data-testid="running-total" className="text-xl font-semibold text-slate-900 tabular-nums">
          {rupees(runningTotal(lines))}
        </span>
      </div>
    </div>
  );
}
