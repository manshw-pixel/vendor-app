import { useState } from "react";
import { useTranslation } from "react-i18next";
import { supabase } from "../supabase";
import { MIN_PASSWORD_LENGTH } from "../../../supabase/functions/admin-create-user/guards";
import { LangSwitch } from "./Shell";

/**
 * Shown instead of every route while app_users.must_change_password is set.
 *
 * The admin typed this person's first password, so the admin knows it. bills.recorder_id
 * and bills.biller_id name who did the work, so until it changes an admin could record
 * bills under this person's name and the history would not show it.
 *
 * There is no cancel: the flag is the whole point. Sign out is the way out, for someone
 * handed a password that does not work -- without it they would be stuck on a screen they
 * cannot satisfy.
 */
export function ChangePassword({ email }: { email: string }) {
  const { t } = useTranslation();
  const [pw, setPw] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<{ key: string; detail: string } | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (pw.length < MIN_PASSWORD_LENGTH) {
      setError({ key: "changePw.tooShort", detail: "" });
      return;
    }
    if (pw !== confirm) {
      setError({ key: "changePw.mismatch", detail: "" });
      return;
    }
    setError(null);
    setBusy(true);

    // ORDER MATTERS. The password changes first; only then is the flag cleared. Reversed,
    // a failure between the two would leave the flag clear and the admin's password live,
    // which is exactly the window this screen closes. A failure in the other direction
    // just prompts again, which is harmless.
    const { error: pwError } = await supabase.auth.updateUser({ password: pw });
    if (pwError) {
      setBusy(false);
      setError({ key: "changePw.failed", detail: pwError.message ?? "" });
      return;
    }

    const { error: flagError } = await supabase.rpc("complete_password_change");
    setBusy(false);
    if (flagError) {
      setError({ key: "changePw.failed", detail: flagError.message ?? "" });
      return;
    }
    // SessionProvider re-reads app_users on the auth state change updateUser triggers, so
    // there is nothing to navigate to: the session resolves to `ready` and App renders the
    // routes on its own.
  }

  return (
    <div className="min-h-screen flex flex-col items-center justify-center p-4 gap-4">
      <form onSubmit={submit} className="bg-white border border-slate-200 rounded-xl p-6 w-full max-w-sm shadow-sm space-y-3">
        <h1 className="text-lg font-semibold text-slate-800">{t("changePw.title")}</h1>
        <p className="text-sm text-slate-600">{t("changePw.body", { email })}</p>

        {error && (
          <div data-testid="newpw-error" className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">
            {t(error.key)}
            {error.detail && <span className="block text-xs opacity-70 mt-1">{error.detail}</span>}
          </div>
        )}

        <div>
          <label className="block text-sm font-medium mb-1" htmlFor="newpw">{t("changePw.new")}</label>
          <input
            id="newpw" data-testid="newpw" type="password" autoComplete="new-password"
            value={pw} onChange={(e) => setPw(e.target.value)}
            className="w-full border border-slate-300 rounded-lg px-3 py-2 min-h-[44px]"
          />
        </div>
        <div>
          <label className="block text-sm font-medium mb-1" htmlFor="newpw-confirm">{t("changePw.confirm")}</label>
          <input
            id="newpw-confirm" data-testid="newpw-confirm" type="password" autoComplete="new-password"
            value={confirm} onChange={(e) => setConfirm(e.target.value)}
            className="w-full border border-slate-300 rounded-lg px-3 py-2 min-h-[44px]"
          />
        </div>

        <button
          type="submit" data-testid="newpw-save" disabled={busy}
          className="w-full bg-green-600 disabled:bg-green-300 text-white rounded-lg font-medium min-h-[44px]"
        >
          {t("changePw.save")}
        </button>
        <button
          type="button" data-testid="newpw-signout" onClick={() => void supabase.auth.signOut()}
          className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm bg-white min-h-[44px]"
        >
          {t("app.signOut")}
        </button>
      </form>
      <LangSwitch />
    </div>
  );
}
