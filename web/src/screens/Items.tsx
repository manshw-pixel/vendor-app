import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
// i18next initialises as a side effect of this import, exactly as Pending.tsx does.
import "../i18n";
import { listAllItems, createItem, updateItem, setItemActive, type AdminItem } from "../admin";
import { validateItem, stockLevel, type ItemInput, type ItemField } from "../adminRules";
import { useSession } from "../components/SessionProvider";
import { itemName, type Lang } from "../i18n/locales";
import { rupees } from "../money";
import { describeError } from "../errors";

const BLANK: ItemInput = { name_en: "", name_hi: "", name_mr: "", price: "", stock_kg: "" };

const FIELDS = [
  ["name_en", "items.nameEn", "text"],
  ["name_hi", "items.nameHi", "text"],
  ["name_mr", "items.nameMr", "text"],
  ["price", "items.price", "decimal"],
  ["stock_kg", "items.stock", "decimal"],
] as const;

function toInput(it: AdminItem): ItemInput {
  return {
    name_en: it.name_en, name_hi: it.name_hi, name_mr: it.name_mr,
    price: String(it.price), stock_kg: String(it.stock_kg),
  };
}

export default function Items() {
  const { t, i18n } = useTranslation();
  const session = useSession();
  const [rows, setRows] = useState<AdminItem[]>([]);
  const [problem, setProblem] = useState<{ key: string; detail: string } | null>(null);
  const [editing, setEditing] = useState<{ id: string | null; input: ItemInput } | null>(null);
  const [errors, setErrors] = useState<Partial<Record<ItemField, string>>>({});
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const { data, error } = await listAllItems();
    setProblem(describeError(error));
    setRows(data ?? []);
  }, []);

  useEffect(() => { void load(); }, [load]);

  if (session.kind !== "ready") return null;
  const { vendorId } = session;
  const lang = i18n.language as Lang;

  async function save() {
    if (!editing) return;
    const result = validateItem(editing.input);
    if (!result.ok) { setErrors(result.errors); return; }
    setErrors({});
    setBusy(true);
    const { error } = editing.id === null
      ? await createItem(vendorId, result.value)
      : await updateItem(editing.id, result.value);
    setBusy(false);
    const described = describeError(error);
    setProblem(described);
    if (described) return;
    setEditing(null);
    await load();
  }

  async function toggle(it: AdminItem) {
    setBusy(true);
    const { error } = await setItemActive(it.id, !it.is_active);
    setBusy(false);
    // load() runs before the problem is set, because listAllItems's own (null) error
    // would otherwise clobber the message we are about to show -- same reasoning as
    // Staff.remove().
    await load();
    setProblem(describeError(error));
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="font-semibold text-slate-800">{t("items.title")}</h2>
        <button
          onClick={() => { setErrors({}); setEditing({ id: null, input: BLANK }); }}
          className="border border-slate-300 rounded-lg px-3 py-2 text-sm bg-white min-h-[44px]"
        >
          {t("items.add")}
        </button>
      </div>

      {problem && (
        <p className="text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg p-3">
          {t(problem.key)}
        </p>
      )}

      {editing && (
        <form
          onSubmit={(e) => { e.preventDefault(); void save(); }}
          className="bg-white border border-slate-200 rounded-xl p-4 space-y-3"
        >
          <h3 className="font-semibold text-slate-800">
            {editing.id === null ? t("items.add") : t("items.edit")}
          </h3>
          <p className="text-xs text-slate-500">{t("items.namesNote")}</p>

          {FIELDS.map(([field, labelKey, kind]) => (
            <div key={field}>
              <label className="block text-sm text-slate-600 mb-1" htmlFor={`item-${field}`}>
                {t(labelKey)}
              </label>
              <input
                id={`item-${field}`}
                value={editing.input[field]}
                inputMode={kind === "decimal" ? "decimal" : undefined}
                onChange={(e) =>
                  setEditing({ ...editing, input: { ...editing.input, [field]: e.target.value } })
                }
                className="w-full border border-slate-300 rounded-lg px-3 py-2 min-h-[44px]"
              />
              {errors[field] && <p className="text-xs text-red-700 mt-1">{t(errors[field]!)}</p>}
            </div>
          ))}

          <p className="text-xs text-slate-500">{t("items.stockNote")}</p>

          <div className="flex gap-2">
            <button
              type="submit" data-testid="item-save" disabled={busy}
              className="rounded-lg px-4 py-2 text-sm bg-slate-800 text-white min-h-[44px] disabled:opacity-50"
            >
              {t("items.save")}
            </button>
            <button
              type="button" onClick={() => { setEditing(null); setErrors({}); }}
              className="border border-slate-300 rounded-lg px-4 py-2 text-sm bg-white min-h-[44px]"
            >
              {t("items.cancel")}
            </button>
          </div>
        </form>
      )}

      {rows.length === 0 ? (
        <p className="text-sm text-slate-500">{t("items.empty")}</p>
      ) : (
        <ul className="space-y-2">
          {rows.map((it) => {
            const level = stockLevel(it.stock_kg);
            return (
              <li
                key={it.id}
                className="bg-white border border-slate-200 rounded-xl p-3 flex items-center gap-3"
              >
                <div className="flex-1 min-w-0">
                  <p className="font-medium text-slate-800 truncate">
                    {itemName(it, lang)}
                    {!it.is_active && (
                      <span className="ml-2 text-xs text-slate-500">({t("items.inactive")})</span>
                    )}
                  </p>
                  <p className="text-sm text-slate-500">
                    {rupees(it.price)}
                    {" · "}
                    <span className={
                      level === "out" ? "text-red-700" : level === "low" ? "text-amber-700" : ""
                    }>
                      {level === "out" ? t("items.out") : t("items.inStock", { kg: it.stock_kg })}
                      {level === "low" && ` — ${t("items.low")}`}
                    </span>
                  </p>
                </div>
                <button
                  data-testid={`item-edit-${it.id}`}
                  onClick={() => { setErrors({}); setEditing({ id: it.id, input: toInput(it) }); }}
                  className="border border-slate-300 rounded-lg px-3 py-2 text-sm bg-white min-h-[44px]"
                >
                  {t("items.edit")}
                </button>
                <button
                  data-testid={`item-toggle-${it.id}`}
                  onClick={() => void toggle(it)} disabled={busy}
                  className="border border-slate-300 rounded-lg px-3 py-2 text-sm bg-white min-h-[44px] disabled:opacity-50"
                >
                  {it.is_active ? t("items.deactivate") : t("items.reactivate")}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
