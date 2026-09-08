import { useTranslation } from "react-i18next";

/** The number the server issued -- not one this screen computed. */
export function TokenResult({ token, onStartNew }: { token: number; onStartNew: () => void }) {
  const { t } = useTranslation();
  return (
    <div className="border border-slate-200 rounded-xl bg-white p-6 text-center space-y-4">
      <p className="text-slate-600">{t("bill.tokenTitle")}</p>
      <p className="text-6xl font-bold text-emerald-700">{token}</p>
      <button
        onClick={onStartNew}
        className="w-full rounded-lg px-3 py-2 min-h-[44px] bg-emerald-600 text-white"
      >
        {t("bill.startNew")}
      </button>
    </div>
  );
}
