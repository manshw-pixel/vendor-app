import { useTranslation } from "react-i18next";

/** Named stubs so routing is real in stage 1 and each screen has a home to grow into. */
export function Placeholder({ titleKey }: { titleKey: string }) {
  const { t } = useTranslation();
  return (
    <div className="bg-white border border-slate-200 rounded-xl p-6">
      <h2 className="font-semibold text-slate-800 mb-1">{t(titleKey)}</h2>
      <p className="text-sm text-slate-500">{t("soon.body")}</p>
    </div>
  );
}
