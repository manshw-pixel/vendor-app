import { useState } from "react";
import { useTranslation } from "react-i18next";
import { supabase } from "../supabase";
import { Button, type Variant } from "../ui/Button";
import { Banner } from "../ui/Banner";

/** Sign out that never fails silently. The global sign-out errors while offline and
 *  leaves the session in place, so fall back to clearing this device only. */
export function SignOutButton({ variant = "secondary", className = "", ...rest }:
  { variant?: Variant; className?: string; "data-testid"?: string }) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  async function signOut() {
    setBusy(true); setFailed(false);
    const { error } = await supabase.auth.signOut();
    if (!error) return;
    const local = await supabase.auth.signOut({ scope: "local" });
    if (local.error) { setFailed(true); setBusy(false); }
  }
  return (
    <>
      <Button variant={variant} className={className} disabled={busy} onClick={() => void signOut()}
              data-testid={rest["data-testid"]}>
        {t("app.signOut")}
      </Button>
      {failed && <Banner tone="error">{t("app.signOutFailed")}</Banner>}
    </>
  );
}
