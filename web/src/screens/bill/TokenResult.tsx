import { useTranslation } from "react-i18next";
import { Card } from "../../ui/Card";
import { Button } from "../../ui/Button";

/** The number the server issued -- not one this screen computed. */
export function TokenResult({ token, onStartNew }: { token: number; onStartNew: () => void }) {
  const { t } = useTranslation();
  return (
    <Card className="p-6 text-center space-y-4">
      <p className="text-slate-600">{t("bill.tokenTitle")}</p>
      <p className="text-6xl font-bold text-brand-strong">{token}</p>
      <Button size="lg" onClick={onStartNew} className="w-full">
        {t("bill.startNew")}
      </Button>
    </Card>
  );
}
