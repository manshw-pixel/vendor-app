import { useState } from "react";
import { useTranslation } from "react-i18next";
import { supabase } from "../supabase";
import { LangSwitch } from "./Shell";
import { Button } from "../ui/Button";
import { Banner } from "../ui/Banner";
import { Card } from "../ui/Card";

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
      <Card className="p-6 w-full max-w-sm shadow-sm">
        <form onSubmit={submit}>
          <h1 className="text-lg font-semibold text-slate-800 mb-5">{t("app.name")}</h1>
          {err && (
            <Banner tone="error" className="mb-3">
              {t(err.key)}
              <span className="block text-xs opacity-70 mt-1">{err.detail}</span>
            </Banner>
          )}
          <label className="block text-sm font-medium mb-1" htmlFor="email">{t("app.email")}</label>
          <input id="email" type="email" required autoComplete="username" value={email}
                 onChange={(e) => setEmail(e.target.value)}
                 className="w-full border border-slate-300 rounded-lg px-3 mb-3" />
          <label className="block text-sm font-medium mb-1" htmlFor="password">{t("app.password")}</label>
          <input id="password" type="password" required autoComplete="current-password" value={password}
                 onChange={(e) => setPassword(e.target.value)}
                 className="w-full border border-slate-300 rounded-lg px-3 mb-5" />
          <Button type="submit" disabled={busy} className="w-full">
            {busy ? t("app.signingIn") : t("app.signIn")}
          </Button>
        </form>
      </Card>
      <LangSwitch />
    </div>
  );
}
