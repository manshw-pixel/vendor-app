import { useTranslation } from "react-i18next";
import { supabase } from "../supabase";
import { Dialog } from "../ui/Dialog";
import { Button } from "../ui/Button";
import { LangSwitch } from "./Shell";

/** Who is signed in, the language, and Sign out -- off the header so it fits a 360px phone. */
export function AccountSheet({ name, role, onClose }: { name: string; role: string; onClose: () => void }) {
  const { t } = useTranslation();
  return (
    <Dialog label={t("app.account")} onClose={onClose}>
      <div>
        <p className="font-semibold text-ink">{name}</p>
        <p className="text-sm text-muted">{t(`role.${role}`, { defaultValue: role })}</p>
      </div>
      <div className="space-y-1">
        <p className="text-sm text-slate-600">{t("app.language")}</p>
        <LangSwitch />
      </div>
      <Button variant="danger" className="w-full" onClick={() => void supabase.auth.signOut()}>
        {t("app.signOut")}
      </Button>
    </Dialog>
  );
}
