import { useState } from "react";
import { useTranslation } from "react-i18next";
import { PAYMENT_MODES, type PaymentMode } from "../../payments";
import { rupees } from "../../money";
import type { Balance } from "../../offline/catalogue";

export function checkoutLimits(total: number, balance: Balance | undefined, mode: PaymentMode) {
  if (!balance) return { maxRedeem: 0, maxCollect: 0 };
  return {
    maxRedeem: Math.max(0, Math.min(balance.points, Math.floor(total))),
    maxCollect: mode === "credit" ? 0 : Math.max(balance.due, 0),
  };
}

/** What the biller takes from the customer: the bill, less points redeemed (one point is
 *  one rupee), plus any old due collected -- rounded to the paisa. */
export function amountToTake(total: number, redeem: number, collect: number): number {
  return Math.round((total - redeem + collect) * 100) / 100;
}

/** The offline end of a bill: what a biller asks at the counter, against the device's
 *  last-known balances. Inputs are capped here, so a sync issue can only come from the
 *  cache being out of date -- never from a typo. */
export function OfflineCheckout({ total, balance, saving = false, onConfirm, onCancel }: {
  total: number; balance: Balance | undefined; saving?: boolean;
  onConfirm: (mode: PaymentMode, redeem: number, collect: number) => void; onCancel: () => void;
}) {
  const { t } = useTranslation();
  const [mode, setMode] = useState<PaymentMode>("cash");
  const [redeem, setRedeem] = useState(0);
  const [collect, setCollect] = useState(0);
  const { maxRedeem, maxCollect } = checkoutLimits(total, balance, mode);
  const r = Math.min(redeem, maxRedeem), c = Math.min(collect, maxCollect);
  return (
    <div role="dialog" aria-modal="true" aria-label={t("offline.checkoutTitle")}
         className="fixed inset-0 bg-black/40 flex items-end sm:items-center justify-center p-4">
      <div className="bg-white rounded-xl p-4 w-full max-w-sm space-y-3">
        <p className="font-semibold">{t("offline.checkoutTitle")} · {rupees(amountToTake(total, r, c))}</p>
        <fieldset className="flex flex-wrap gap-2">
          {PAYMENT_MODES.map((m) => (
            <label key={m} className="flex items-center gap-1 min-h-[44px]">
              <input type="radio" name="mode" checked={mode === m} onChange={() => setMode(m)} />
              {t(`pay.${m}`)}
            </label>
          ))}
        </fieldset>
        {maxRedeem > 0 && (
          <label className="block text-sm">{t("offline.redeem", { max: maxRedeem })}
            <input type="number" min={0} max={maxRedeem} value={r}
                   onChange={(e) => setRedeem(Math.max(0, Math.floor(Number(e.target.value) || 0)))}
                   className="w-full border rounded px-2 py-1" />
          </label>
        )}
        {maxCollect > 0 && (
          <label className="block text-sm">{t("offline.collect", { max: rupees(maxCollect) })}
            <input type="number" min={0} max={maxCollect} step="0.01" value={c}
                   onChange={(e) => setCollect(Math.max(0, Math.round((Number(e.target.value) || 0) * 100) / 100))}
                   className="w-full border rounded px-2 py-1" />
          </label>
        )}
        <p className="text-xs text-slate-500">{t("offline.provisional")}</p>
        <button onClick={() => onConfirm(mode, r, c)} disabled={saving}
                className="disabled:opacity-50 w-full rounded-lg px-3 py-3 min-h-[44px] bg-emerald-600 text-white font-semibold">
          {t("offline.recordSale")}
        </button>
        <button onClick={onCancel} className="w-full rounded-lg px-3 py-2 min-h-[44px] border border-slate-300">
          {t("bill.cancel")}
        </button>
      </div>
    </div>
  );
}
