import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { supabase } from "../supabase";
import { useSession } from "../components/SessionProvider";
import { LangSwitch } from "../components/Shell";
import { rupees } from "../money";
import { validateNewVendor, type NewVendorField, type NewVendorInput } from "../ownerRules";
import {
  createVendor,
  listVendorSummary,
  setVendorSuspended,
  type VendorSummary,
} from "../ownerApi";

const BLANK: NewVendorInput = {
  vendorName: "", address: "", phone: "", adminName: "", email: "", password: "",
};

const FIELDS: { field: NewVendorField; type: string }[] = [
  { field: "vendorName", type: "text" },
  { field: "address", type: "text" },
  { field: "phone", type: "tel" },
  { field: "adminName", type: "text" },
  { field: "email", type: "email" },
  { field: "password", type: "text" },
];

type Pending = { id: string; name: string; action: "suspend" | "reinstate" };

/**
 * The platform owner's only screen: every shop at a glance, onboarding a new one, and
 * suspending or reinstating. Everything it does goes through ownerApi.
 */
export default function OwnerConsole() {
  const { t } = useTranslation();
  const session = useSession();
  const ownerName: string = session.kind === "owner" ? session.name : "";

  const [rows, setRows] = useState<VendorSummary[] | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [adding, setAdding] = useState<boolean>(false);
  const [form, setForm] = useState<NewVendorInput>(BLANK);
  const [errors, setErrors] = useState<Partial<Record<NewVendorField, string>>>({});
  const [saving, setSaving] = useState<boolean>(false);
  const [created, setCreated] = useState<{ vendor: string; email: string } | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const [acting, setActing] = useState<boolean>(false);

  const load = useCallback(async (): Promise<void> => {
    const { data, error } = await listVendorSummary();
    if (error) {
      setProblem("error.unknown");
      setRows((prev) => prev ?? []);
      return;
    }
    setRows(data ?? []);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function save(): Promise<void> {
    setProblem(null);
    setCreated(null);
    const r = validateNewVendor(form);
    if (!r.ok) {
      setErrors(r.errors);
      return;
    }
    setErrors({});
    setSaving(true);
    const { error } = await createVendor(r.value);
    setSaving(false);
    if (error) {
      setProblem(error.key);
      return;
    }
    setCreated({ vendor: r.value.vendor.name, email: r.value.admin.email });
    setForm(BLANK);
    setAdding(false);
    await load();
  }

  async function confirm(): Promise<void> {
    if (!pending) return;
    setProblem(null);
    setActing(true);
    const { error } = await setVendorSuspended(pending.id, pending.action);
    setActing(false);
    setPending(null);
    if (error) setProblem(error.key);
    await load();
  }

  return (
    <div data-testid="owner-console" className="min-h-screen bg-slate-50">
      <header className="flex flex-wrap items-center justify-between gap-2 border-b bg-white px-4 py-3">
        <div>
          <h1 className="font-semibold text-slate-800">{t("owner.title")}</h1>
          <p className="text-sm text-slate-600">{ownerName}</p>
        </div>
        <div className="flex items-center gap-3">
          <LangSwitch />
          <button
            type="button" data-testid="owner-signout"
            onClick={() => void supabase.auth.signOut()}
            className="text-sm text-slate-700 underline"
          >
            {t("app.signOut")}
          </button>
        </div>
      </header>

      <main className="mx-auto max-w-4xl space-y-4 p-4">
        <div className="flex items-center justify-between">
          <h2 className="font-semibold text-slate-800">{t("owner.vendors")}</h2>
          {!adding && (
            <button
              type="button" data-testid="owner-add"
              onClick={() => { setAdding(true); setCreated(null); setProblem(null); }}
              className="rounded bg-emerald-600 px-3 py-2 text-sm text-white"
            >
              {t("owner.add")}
            </button>
          )}
        </div>

        {problem && (
          <div data-testid="owner-problem" role="alert"
            className="rounded border border-red-300 bg-red-50 p-3 text-sm text-red-800">
            {t(problem)}
          </div>
        )}

        {created && (
          <p data-testid="owner-created" className="rounded bg-emerald-50 p-3 text-sm text-emerald-800">
            {t("owner.created", { vendor: created.vendor, email: created.email })}
          </p>
        )}

        {adding && (
          <form
            className="space-y-3 rounded border bg-white p-4"
            onSubmit={(e) => { e.preventDefault(); void save(); }}
            noValidate
          >
            {FIELDS.map(({ field, type }) => (
              <label key={field} className="block text-sm">
                <span className="text-slate-700">{t(`owner.${field}`)}</span>
                <input
                  data-testid={`owner-${field}`} type={type} value={form[field]}
                  autoComplete="off"
                  onChange={(e) => setForm({ ...form, [field]: e.target.value })}
                  className="mt-1 block w-full rounded border px-2 py-1"
                />
                {errors[field] && (
                  <span className="text-xs text-red-700">{t(errors[field] as string)}</span>
                )}
              </label>
            ))}
            <div className="flex gap-2">
              <button type="submit" data-testid="owner-save" disabled={saving}
                className="rounded bg-emerald-600 px-3 py-2 text-sm text-white disabled:opacity-50">
                {t("owner.save")}
              </button>
              <button type="button"
                onClick={() => { setAdding(false); setForm(BLANK); setErrors({}); }}
                className="rounded border px-3 py-2 text-sm">
                {t("owner.cancel")}
              </button>
            </div>
          </form>
        )}

        {pending && (
          <div className="space-y-3 rounded border border-amber-300 bg-amber-50 p-4 text-sm">
            <p>
              {pending.action === "suspend"
                ? t("owner.confirmSuspend", { vendor: pending.name })
                : t("owner.confirmReinstate", { vendor: pending.name })}
            </p>
            <div className="flex gap-2">
              <button type="button" data-testid="owner-confirm" disabled={acting}
                onClick={() => void confirm()}
                className="rounded bg-slate-800 px-3 py-2 text-white disabled:opacity-50">
                {t("owner.confirm")}
              </button>
              <button type="button" data-testid="owner-cancel" onClick={() => setPending(null)}
                className="rounded border px-3 py-2">
                {t("owner.cancel")}
              </button>
            </div>
          </div>
        )}

        {rows === null ? (
          <p className="text-sm text-slate-600">{t("owner.loading")}</p>
        ) : rows.length === 0 ? (
          <p className="text-sm text-slate-600">{t("owner.empty")}</p>
        ) : (
          <ul className="space-y-2">
            {rows.map((v) => {
              const suspended: boolean = v.suspended_at !== null;
              return (
                <li key={v.id} data-testid={`owner-vendor-${v.id}`}
                  className="flex flex-wrap items-start justify-between gap-3 rounded border bg-white p-3">
                  <div className="space-y-1 text-sm">
                    <div className="flex items-center gap-2">
                      <span className="font-medium text-slate-800">{v.name}</span>
                      <span className={suspended
                        ? "rounded bg-red-100 px-2 text-xs text-red-800"
                        : "rounded bg-emerald-100 px-2 text-xs text-emerald-800"}>
                        {suspended ? t("owner.suspendedBadge") : t("owner.active")}
                      </span>
                    </div>
                    <div className="text-slate-500">{new Date(v.created_at).toLocaleDateString()}</div>
                    <div className="flex flex-wrap gap-x-4 text-slate-700">
                      <span>{t("owner.staff", { n: Number(v.staff_count) })}</span>
                      <span>{t("owner.billsMonth", { n: Number(v.bills_month) })}</span>
                      <span>{t("owner.salesMonth")}: <span>{rupees(Number(v.sales_month))}</span></span>
                    </div>
                    <div className="text-slate-500">
                      {t("owner.lastBill")}:{" "}
                      <span>{v.last_bill_at ? new Date(v.last_bill_at).toLocaleString() : t("owner.never")}</span>
                    </div>
                  </div>
                  {suspended ? (
                    <button type="button" data-testid={`owner-reinstate-${v.id}`}
                      onClick={() => setPending({ id: v.id, name: v.name, action: "reinstate" })}
                      className="rounded border px-3 py-1 text-sm">
                      {t("owner.reinstate")}
                    </button>
                  ) : (
                    <button type="button" data-testid={`owner-suspend-${v.id}`}
                      onClick={() => setPending({ id: v.id, name: v.name, action: "suspend" })}
                      className="rounded border border-red-300 px-3 py-1 text-sm text-red-700">
                      {t("owner.suspend")}
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </main>
    </div>
  );
}
