import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { SignOutButton } from "../components/SignOutButton";
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
import { Button } from "../ui/Button";
import { Banner } from "../ui/Banner";
import { Card } from "../ui/Card";
import { Spinner } from "../ui/Spinner";
import { EmptyState } from "../ui/EmptyState";

const BLANK: NewVendorInput = {
  vendorName: "", address: "", phone: "", adminName: "", email: "", password: "",
};

const FIELDS: { field: NewVendorField; type: string }[] = [
  { field: "vendorName", type: "text" },
  { field: "address", type: "text" },
  { field: "phone", type: "tel" },
  { field: "adminName", type: "text" },
  { field: "email", type: "email" },
  { field: "password", type: "password" },
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
  // Kept apart from `problem` so a successful reload clears only a load failure, never an
  // action error that confirm() or save() set just before reloading.
  const [loadProblem, setLoadProblem] = useState<string | null>(null);
  const [adding, setAdding] = useState<boolean>(false);
  const [form, setForm] = useState<NewVendorInput>(BLANK);
  const [errors, setErrors] = useState<Partial<Record<NewVendorField, string>>>({});
  const [saving, setSaving] = useState<boolean>(false);
  const [created, setCreated] = useState<{ vendor: string; email: string } | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const [acting, setActing] = useState<boolean>(false);
  const [bansIncomplete, setBansIncomplete] = useState<boolean>(false);

  const load = useCallback(async (): Promise<void> => {
    const { data, error } = await listVendorSummary();
    if (error) {
      setLoadProblem("error.unknown");
      setRows((prev) => prev ?? []);
      return;
    }
    setLoadProblem(null);
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
    setBansIncomplete(false);
    setActing(true);
    const action = pending.action;
    const { error, outcome } = await setVendorSuspended(pending.id, action);
    setActing(false);
    setPending(null);
    if (error) {
      setProblem(error.key);
    } else if (action === "suspend" && outcome && (outcome.failed > 0 || outcome.bans_skipped)) {
      // The DB flag (vendors.suspended_at) already flipped -- that is the authoritative
      // gate -- but some staff accounts may still be able to sign back in until their
      // session expires, so the owner needs to know this suspension is not fully done.
      setBansIncomplete(true);
    }
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
          <SignOutButton variant="ghost" data-testid="owner-signout" className="text-sm underline" />
        </div>
      </header>

      <main className="mx-auto max-w-4xl space-y-4 p-4">
        <div className="flex items-center justify-between">
          <h2 className="font-semibold text-slate-800">{t("owner.vendors")}</h2>
          {!adding && (
            <Button
              data-testid="owner-add"
              onClick={() => { setAdding(true); setCreated(null); setProblem(null); }}
            >
              {t("owner.add")}
            </Button>
          )}
        </div>

        {(problem ?? loadProblem) && (
          <Banner tone="error">
            <span data-testid="owner-problem">{t((problem ?? loadProblem) as string)}</span>
          </Banner>
        )}

        {bansIncomplete && (
          <Banner tone="warn" role="alert">
            <span data-testid="owner-bans-incomplete">{t("owner.bansIncomplete")}</span>
          </Banner>
        )}

        {created && (
          <Banner tone="success">
            <span data-testid="owner-created">
              {t("owner.created", { vendor: created.vendor, email: created.email })}
            </span>
          </Banner>
        )}

        {adding && (
          <form
            className="space-y-3"
            onSubmit={(e) => { e.preventDefault(); void save(); }}
            noValidate
          >
            <Card className="space-y-3 p-4">
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
                    <span className="text-xs text-danger">{t(errors[field] as string)}</span>
                  )}
                </label>
              ))}
              <div className="flex gap-2">
                <Button type="submit" data-testid="owner-save" disabled={saving}>
                  {t("owner.save")}
                </Button>
                <Button type="button" variant="secondary"
                  onClick={() => { setAdding(false); setForm(BLANK); setErrors({}); }}>
                  {t("owner.cancel")}
                </Button>
              </div>
            </Card>
          </form>
        )}

        {pending && (
          <Card className="space-y-3 p-4 border-amber-300 bg-amber-50 text-sm">
            <p>
              {pending.action === "suspend"
                ? t("owner.confirmSuspend", { vendor: pending.name })
                : t("owner.confirmReinstate", { vendor: pending.name })}
            </p>
            <div className="flex gap-2">
              <Button type="button" data-testid="owner-confirm" disabled={acting}
                onClick={() => void confirm()}>
                {t("owner.confirm")}
              </Button>
              <Button type="button" variant="secondary" data-testid="owner-cancel" onClick={() => setPending(null)}>
                {t("owner.cancel")}
              </Button>
            </div>
          </Card>
        )}

        {rows === null ? (
          <Spinner label={t("owner.loading")} />
        ) : rows.length === 0 ? (
          <EmptyState>{t("owner.empty")}</EmptyState>
        ) : (
          <ul className="space-y-2">
            {rows.map((v) => {
              const suspended: boolean = v.suspended_at !== null;
              return (
                <li key={v.id} data-testid={`owner-vendor-${v.id}`}
                  className="flex flex-wrap items-start justify-between gap-3 rounded border bg-surface p-3">
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
                    <Button type="button" variant="secondary" size="md" data-testid={`owner-reinstate-${v.id}`}
                      onClick={() => setPending({ id: v.id, name: v.name, action: "reinstate" })}
                      className="!min-h-0 px-3 py-1">
                      {t("owner.reinstate")}
                    </Button>
                  ) : (
                    <Button type="button" variant="secondary" size="md" data-testid={`owner-suspend-${v.id}`}
                      onClick={() => setPending({ id: v.id, name: v.name, action: "suspend" })}
                      className="!min-h-0 border-red-300 px-3 py-1 text-danger">
                      {t("owner.suspend")}
                    </Button>
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
