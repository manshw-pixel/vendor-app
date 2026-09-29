import { useState } from "react";
import { useTranslation } from "react-i18next";
import { lineTotal, runningTotal, type Draft } from "../../billing";
import { rupees } from "../../money";
import { qtyText } from "../../units";
import { UndoStrip } from "./UndoStrip";
import { Card } from "../../ui/Card";

/** The total here is FEEDBACK. issue_token recomputes the real one from bill_items, and
 *  nothing on this screen ever sends a total to the server. */
export function Basket({
  lines,
  onRemove,
  onRestore,
  frozen = false,
}: {
  lines: readonly Draft[];
  onRemove: (index: number) => void;
  /** Puts a removed line back at its old index. Without it there is no Undo. */
  onRestore?: (index: number, line: Draft) => void;
  /** Set once the lines are in the database and only the token is missing: editing then
   *  would silently diverge from the rows a retry is about to have tokenised. */
  frozen?: boolean;
}) {
  const { t } = useTranslation();
  // The latest removal only. `seq` re-keys the strip so a second removal restarts its timer.
  const [removed, setRemoved] = useState<{ index: number; line: Draft; seq: number } | null>(null);

  function remove(i: number) {
    const line = lines[i];
    onRemove(i);
    if (line && onRestore) setRemoved((prev) => ({ index: i, line, seq: (prev?.seq ?? 0) + 1 }));
  }

  return (
    <Card title={t("bill.basket")}>
      {removed && onRestore && !frozen && (
        <UndoStrip
          key={removed.seq}
          name={removed.line.name}
          onUndo={() => { onRestore(removed.index, removed.line); setRemoved(null); }}
          onExpire={() => setRemoved(null)}
        />
      )}
      {lines.length === 0 ? (
        <p className="text-sm text-slate-500 p-3">{t("bill.empty")}</p>
      ) : (
        <ul className="divide-y divide-slate-100">
          {lines.map((l, i) => (
            // Removing is a separate button, not the whole row: a tap on the row while
            // weighing used to delete the line.
            <li key={`${l.itemId}-${i}`} className="flex items-center gap-1 pl-3">
              <div className="flex-1 min-w-0 py-3">
                <span className="flex justify-between items-baseline gap-3">
                  <span data-testid="basket-line-name" className="font-medium text-slate-800">{l.name}</span>
                  {/* Read back to the customer line by line; do not make the recorder
                      multiply while holding a bag of onions. */}
                  <span className="font-medium text-slate-800 tabular-nums">
                    {rupees(lineTotal(l.unitPrice, l.qtyKg))}
                  </span>
                </span>
                <span className="block text-xs text-slate-500">
                  {qtyText(l.qtyKg, l.unit, t)} × {rupees(l.unitPrice)}
                </span>
              </div>
              {!frozen && (
                <button
                  onClick={() => remove(i)}
                  aria-label={`${t("bill.remove")} ${l.name}`}
                  className="min-h-[44px] min-w-[44px] text-xl text-slate-400 active:bg-slate-100 rounded-lg"
                >
                  <span aria-hidden="true">×</span>
                </button>
              )}
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
    </Card>
  );
}
