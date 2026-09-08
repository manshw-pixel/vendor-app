import { useState } from "react";
import { useTranslation } from "react-i18next";
import { matchCustomers, validateCustomer, isDuplicateMobile, type Customer } from "../../customers";
import { createCustomer, findCustomerByMobile } from "../../data";
import { describeError } from "../../errors";

/**
 * Picking or creating the customer. Nothing here writes a bill: the bill row is created
 * at Done, so a basket that is abandoned here leaves nothing behind but the customer the
 * recorder deliberately added.
 */
export function CustomerStep({
  customers,
  vendorId,
  onPick,
  onCreated,
}: {
  customers: readonly Customer[];
  vendorId: string;
  onPick: (c: Customer) => void;
  onCreated: (c: Customer) => void;
}) {
  const { t } = useTranslation();
  const [query, setQuery] = useState("");
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({ name: "", flat_no: "", mobile: "" });
  const [missing, setMissing] = useState(false);
  const [duplicate, setDuplicate] = useState<Customer | null>(null);
  const [duplicateUnreachable, setDuplicateUnreachable] = useState(false);
  const [failure, setFailure] = useState<{ key: string; detail: string } | null>(null);
  const [saving, setSaving] = useState(false);

  const shown = matchCustomers(customers, query);

  async function save() {
    setMissing(false);
    setDuplicate(null);
    setDuplicateUnreachable(false);
    setFailure(null);
    const check = validateCustomer(form);
    if (!check.ok) {
      setMissing(true);
      return;
    }
    setSaving(true);
    const { data, error } = await createCustomer(vendorId, form);
    setSaving(false);
    if (isDuplicateMobile(error)) {
      // The row already exists. Offer it -- do not silently switch the recorder to a
      // customer they have not seen, and do not leave them with a constraint message and
      // nowhere to go. It may not be in the fetched list at all (another recorder added
      // it, or a policy filtered it out of this fetch), so ask for it by mobile.
      const mobile = form.mobile.trim();
      const known = customers.find((c) => c.mobile === mobile);
      if (known) {
        setDuplicate(known);
        return;
      }
      const found = await findCustomerByMobile(mobile);
      if (found.data) setDuplicate(found.data as Customer);
      else setDuplicateUnreachable(true);
      return;
    }
    if (error || !data) {
      setFailure(describeError(error));
      return;
    }
    onCreated(data as Customer);
  }

  return (
    <div className="space-y-3">
      <h2 className="font-semibold text-slate-800">{t("bill.chooseCustomer")}</h2>

      <input
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder={t("bill.searchCustomer")}
        aria-label={t("bill.searchCustomer")}
        className="w-full border border-slate-300 rounded-lg px-3 py-2 min-h-[44px]"
      />

      <ul className="divide-y divide-slate-100 border border-slate-200 rounded-xl bg-white">
        {shown.map((c) => (
          <li key={c.id}>
            <button
              onClick={() => onPick(c)}
              className="w-full text-left px-3 py-3 min-h-[44px] active:bg-slate-100"
            >
              <span className="block font-medium text-slate-800">{c.name}</span>
              <span className="block text-xs text-slate-500">
                {c.flat_no} · {c.mobile}
              </span>
            </button>
          </li>
        ))}
      </ul>

      {!adding ? (
        <button
          onClick={() => setAdding(true)}
          className="w-full border border-slate-300 rounded-lg px-3 py-2 min-h-[44px] bg-white"
        >
          {t("bill.newCustomer")}
        </button>
      ) : (
        <div className="space-y-2 border border-slate-200 rounded-xl bg-white p-3">
          {(["name", "flat_no", "mobile"] as const).map((field) => (
            <label key={field} className="block text-sm text-slate-600">
              {t(field === "flat_no" ? "bill.flatNo" : `bill.${field}`)}
              <input
                value={form[field]}
                onChange={(e) => setForm({ ...form, [field]: e.target.value })}
                className="mt-1 w-full border border-slate-300 rounded-lg px-3 py-2 min-h-[44px]"
              />
            </label>
          ))}
          {missing && <p className="text-sm text-red-600">{t("bill.required")}</p>}
          {(duplicate !== null || duplicateUnreachable) && (
            <div className="space-y-2">
              <p className="text-sm text-amber-700">{t("bill.customerExists")}</p>
              {duplicate && (
                <button
                  onClick={() => onPick(duplicate)}
                  data-testid="duplicate-offer"
                  className="w-full text-left border border-amber-300 bg-amber-50 rounded-lg px-3 py-2 min-h-[44px]"
                >
                  <span className="block font-medium text-slate-800">{duplicate.name}</span>
                  <span className="block text-xs text-slate-500">
                    {duplicate.flat_no} · {duplicate.mobile}
                  </span>
                </button>
              )}
            </div>
          )}
          {failure && (
            <p className="text-sm text-red-600">
              {t(failure.key)} <span className="text-xs text-slate-400">{failure.detail}</span>
            </p>
          )}
          <button
            onClick={() => void save()}
            disabled={saving}
            className="w-full rounded-lg px-3 py-2 min-h-[44px] bg-emerald-600 text-white disabled:opacity-50"
          >
            {t("bill.save")}
          </button>
        </div>
      )}
    </div>
  );
}
