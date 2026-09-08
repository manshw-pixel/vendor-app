import { useState } from "react";
import { useTranslation } from "react-i18next";
import { supabase } from "../supabase";
import { LangSwitch } from "./Shell";

export function Login() {
  const { t } = useTranslation();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<{ key: string; detail: string } | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    setBusy(false);
    // Sign-in failures are GoTrue's, not PostgREST's; show the message it gives rather
    // than mapping it through describeError's Postgres codes.
    if (error) setErr({ key: "error.unknown", detail: error.message });
  }

  return (
    <div className="min-h-screen flex flex-col items-center justify-center p-4 gap-4">
      <form onSubmit={submit} className="bg-white border border-slate-200 rounded-xl p-6 w-full max-w-sm shadow-sm">
        <h1 className="text-lg font-semibold text-slate-800 mb-5">{t("app.name")}</h1>
        {err && (
          <div className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700 mb-3">
            {t(err.key)}
            <span className="block text-xs opacity-70 mt-1">{err.detail}</span>
          </div>
        )}
        <label className="block text-sm font-medium mb-1" htmlFor="email">{t("app.email")}</label>
        <input id="email" type="email" required autoComplete="username" value={email}
               onChange={(e) => setEmail(e.target.value)}
               className="w-full border border-slate-300 rounded-lg px-3 mb-3" />
        <label className="block text-sm font-medium mb-1" htmlFor="password">{t("app.password")}</label>
        <input id="password" type="password" required autoComplete="current-password" value={password}
               onChange={(e) => setPassword(e.target.value)}
               className="w-full border border-slate-300 rounded-lg px-3 mb-5" />
        <button type="submit" disabled={busy}
                className="w-full bg-green-600 disabled:bg-green-300 text-white rounded-lg font-medium">
          {busy ? t("app.signingIn") : t("app.signIn")}
        </button>
      </form>
      <LangSwitch />
    </div>
  );
}
