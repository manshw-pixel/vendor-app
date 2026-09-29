import { useEffect } from "react";
import { useTranslation } from "react-i18next";

export const UNDO_MS = 6000;

/** "Onion removed · Undo" -- a safety net for a slip of the thumb while weighing. It
 *  dismisses itself after UNDO_MS; a new removal replaces it (the caller re-keys it). */
export function UndoStrip({ name, onUndo, onExpire }:
  { name: string; onUndo: () => void; onExpire: () => void }) {
  const { t } = useTranslation();
  useEffect(() => {
    const id = setTimeout(onExpire, UNDO_MS);
    return () => clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <div data-testid="undo-strip" role="status"
         className="mx-3 mt-2 flex items-center justify-between gap-3 rounded-lg bg-slate-800 text-white px-3 text-sm">
      <span className="min-w-0 truncate">{t("bill.removed", { name })}</span>
      <button onClick={onUndo} className="min-h-[44px] px-2 font-semibold text-emerald-300">
        {t("bill.undo")}
      </button>
    </div>
  );
}
