import { useTranslation } from "react-i18next";
import { rupees } from "../../money";
import { Button } from "../../ui/Button";

/** Total and Done, always in reach while a basket is built. Sits on top of the bottom nav
 *  on phones (bottom-[calc(56px+safe-area)]) and at the bottom of the screen from sm: up,
 *  where the nav moves under the header. The total is feedback only, as in Basket. */
export function CheckoutBar({ total, count, disabled, onDone }:
  { total: number; count: number; disabled: boolean; onDone: () => void }) {
  const { t } = useTranslation();
  return (
    <div className="fixed inset-x-0 z-30 bottom-[calc(56px+env(safe-area-inset-bottom))] sm:bottom-0
                    bg-surface border-t border-slate-200 px-4 py-2">
      <div className="max-w-3xl mx-auto flex items-center justify-between gap-3">
        <p data-testid="checkout-total" className="text-ink font-semibold tabular-nums min-w-0">
          {rupees(total)} · {t("bill.itemCount", { count })}
        </p>
        <Button size="lg" disabled={disabled} onClick={onDone} className="shrink-0 px-8">
          {t("bill.done")}
        </Button>
      </div>
    </div>
  );
}
