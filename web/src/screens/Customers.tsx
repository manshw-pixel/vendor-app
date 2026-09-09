import "../i18n";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { listCustomers } from "../data";
import { updateCustomer, customerPoints } from "../admin";
import { matchCustomers, validateCustomer, isDuplicateMobile, type Customer } from "../customers";
import { describeError } from "../errors";

type Draft = { name: string; flat_no: string; mobile: string };

const FIELDS = [
  ["name", "bill.name"],
  ["flat_no", "bill.flatNo"],
  ["mobile", "bill.mobile"],
] as const;

export default function Customers() {
  const { t } = useTranslation();
  const [all, setAll] = useState<Customer[]>([]);
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState<Customer | null>(null);
  const [draft, setDraft] = useState<Draft>({ name: "", flat_no: "", mobile: "" });
  const [points, setPoints] = useState<number | null>(null);
  const [pointsFailed, setPointsFailed] = useState(false);
  const [incomplete, setIncomplete] = useState(false);
  const [duplicate, setDuplicate] = useState(false);
  const [problem, setProblem] = useState<{ key: string; detail: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const { data, error } = await listCustomers();
    setProblem(describeError(error));
    setAll(data ?? []);
  }, []);

  useEffect(() => { void load(); }, [load]);

  async function openCustomer(c: Customer) {
    setOpen(c);
    setDraft({ name: c.name, flat_no: c.flat_no, mobile: c.mobile });
    setIncomplete(false); setDuplicate(false); setProblem(null);
    setPoints(null); setPointsFailed(false);
    const { data, error } = await customerPoints(c.id);
    // customer_points_balance() is declared `returns table (...)`, so PostgREST always
    // hands back an array of rows -- never a scalar. Zero rows is a real answer (a
    // customer under the vendor's first spend threshold has earned nothing and the
    // ledger holds no row for them), not a failure -- only `error` means the lookup
    // itself failed, and the two must not render the same way.
    if (error) setPointsFailed(true);
    else setPoints(data?.[0]?.balance ?? 0);
  }

  async function save() {
    if (!open) return;
    const check = validateCustomer(draft);
    if (!check.ok) { setIncomplete(true); return; }
    setIncomplete(false); setDuplicate(false);
    setBusy(true);
    const { error } = await updateCustomer(open.id, draft);
    setBusy(false);
    if (isDuplicateMobile(error)) { setDuplicate(true); return; }
    const described = describeError(error);
    setProblem(described);
    if (described) return;
    setOpen(null);
    await load();
  }

  const shown = matchCustomers(all, query);

  return (
    <div className="space-y-4">
      <h2 className="font-semibold text-slate-800">{t("customersScreen.title")}</h2>

      <div>
        <label className="block text-sm text-slate-600 mb-1" htmlFor="customer-search">
          {t("customersScreen.search")}
        </label>
        <input
          id="customer-search" data-testid="customer-search"
          value={query} onChange={(e) => setQuery(e.target.value)}
          className="w-full border border-slate-300 rounded-lg px-3 py-2 min-h-[44px]"
        />
      </div>

      {problem && (
        <p className="text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg p-3">
          {t(problem.key)}
        </p>
      )}

      {open && (
        <form
          onSubmit={(e) => { e.preventDefault(); void save(); }}
          className="bg-white border border-slate-200 rounded-xl p-4 space-y-3"
        >
          <h3 className="font-semibold text-slate-800">{t("customersScreen.edit")}</h3>
          <p className="text-sm text-slate-500">
            {pointsFailed
              ? t("customersScreen.pointsUnknown")
              : points === null ? "…" : t("customersScreen.points", { n: points })}
          </p>

          {FIELDS.map(([field, labelKey]) => (
            <div key={field}>
              <label className="block text-sm text-slate-600 mb-1" htmlFor={`customer-${field}`}>
                {t(labelKey)}
              </label>
              <input
                id={`customer-${field}`} data-testid={`customer-field-${field}`}
                value={draft[field]}
                inputMode={field === "mobile" ? "tel" : undefined}
                onChange={(e) => setDraft({ ...draft, [field]: e.target.value })}
                className="w-full border border-slate-300 rounded-lg px-3 py-2 min-h-[44px]"
              />
            </div>
          ))}

          {incomplete && <p className="text-sm text-red-700">{t("bill.required")}</p>}
          {duplicate && (
            <p data-testid="customer-duplicate" className="text-sm text-red-700">
              {t("customersScreen.duplicate")}
            </p>
          )}

          <div className="flex gap-2">
            <button
              type="submit" data-testid="customer-save" disabled={busy}
              className="rounded-lg px-4 py-2 text-sm bg-slate-800 text-white min-h-[44px] disabled:opacity-50"
            >
              {t("customersScreen.save")}
            </button>
            <button
              type="button" onClick={() => setOpen(null)}
              className="border border-slate-300 rounded-lg px-4 py-2 text-sm bg-white min-h-[44px]"
            >
              {t("customersScreen.cancel")}
            </button>
          </div>
        </form>
      )}

      {shown.length === 0 ? (
        <p className="text-sm text-slate-500">{t("customersScreen.empty")}</p>
      ) : (
        <ul className="space-y-2">
          {shown.map((c) => (
            <li key={c.id}>
              <button
                data-testid={`customer-${c.id}`} onClick={() => void openCustomer(c)}
                className="w-full text-left bg-white border border-slate-200 rounded-xl p-3 min-h-[44px]"
              >
                <span className="font-medium text-slate-800">{c.name}</span>
                <span className="block text-sm text-slate-500">{c.flat_no} · {c.mobile}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
