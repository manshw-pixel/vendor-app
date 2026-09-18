import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { listItems, type Item } from "../data";
import { logMovement, movementsBetween, type Movement } from "../stock";
import { validateMovement, signedKg, type MovementField, type MovementKind } from "../stockRules";
import { presetRange, type Range } from "../dateRange";
import { DateFilter } from "../components/DateFilter";
import { itemName, type Lang } from "../i18n/locales";
import { rupees } from "../money";
import { describeError } from "../errors";
import "../i18n";

export default function Stock() {
  const { t, i18n } = useTranslation();
  const lang = i18n.language as Lang;
  const [items, setItems] = useState<Item[]>([]);
  const [rows, setRows] = useState<Movement[]>([]);
  const [range, setRange] = useState<Range>(() => presetRange("today", new Date()));
  const [itemId, setItemId] = useState("");
  const [kind, setKind] = useState<MovementKind>("purchase");
  const [qtyKg, setQtyKg] = useState("");
  const [unitCost, setUnitCost] = useState("");
  const [note, setNote] = useState("");
  const [fieldErrors, setFieldErrors] = useState<Partial<Record<MovementField, string>>>({});
  const [busy, setBusy] = useState(true);
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<{ key: string; detail: string; kg?: number | "" } | null>(null);
  // Same stale-response guard as Dashboards.tsx: two quick range taps must not let the
  // slower, older fetch paint last.
  const wanted = useRef("");

  const load = useCallback(async (r: Range) => {
    const key = `${r.from}..${r.to}`;
    wanted.current = key;
    setBusy(true);
    const { data, error } = await movementsBetween(r);
    if (wanted.current !== key) return;
    setBusy(false);
    setProblem(error ? describeError(error) : null);
    setRows((data ?? []) as Movement[]);
  }, []);

  useEffect(() => {
    void (async () => {
      const { data } = await listItems();
      setItems((data ?? []) as Item[]);
    })();
  }, []);
  useEffect(() => { void load(range); }, [range, load]);

  async function submit() {
    const r = validateMovement(
      { itemId, kind, qtyKg, unitCost, note },
      items.find((i) => i.id === itemId)?.unit ?? "kg",
    );
    if (!r.ok) { setFieldErrors(r.errors); return; }
    setFieldErrors({});
    setSaving(true);
    const { error } = await logMovement(r.value);
    setSaving(false);
    if (error) {
      const p = describeError(error);
      if (p?.key === "stock.overStock") {
        // Quote the stock the SERVER saw (0016 puts it in the error's detail), frozen at
        // error time, so switching items or a concurrent sale cannot change the number.
        const fromServer = Number((error as { details?: string | null }).details ?? NaN);
        const kg = Number.isFinite(fromServer) && (error as { details?: string | null }).details?.trim()
          ? fromServer
          : chosen ? Number(chosen.stock_kg) : "";
        setProblem({ ...p, kg });
        const fresh = await listItems();
        setItems((fresh.data ?? []) as Item[]);
      } else {
        setProblem(p);
      }
      return;
    }
    setProblem(null);
    setQtyKg(""); setUnitCost(""); setNote("");
    // Refresh the item list too: its stock_kg is what the over-stock message quotes.
    const fresh = await listItems();
    setItems((fresh.data ?? []) as Item[]);
    await load(range);
  }

  const chosen = items.find((i) => i.id === itemId);
  const input = "border border-slate-300 rounded-lg px-3 min-h-[44px] w-full";

  return (
    <div className="space-y-4">
      <div>
        <h2 className="font-semibold text-slate-800">{t("stock.title")}</h2>
        <p className="text-xs text-slate-500">{t("stock.hint")}</p>
      </div>

      <section className="bg-white border border-slate-200 rounded-xl p-4 space-y-3">
        <div className="flex gap-2" role="radiogroup">
          {(["purchase", "wastage"] as const).map((k) => (
            <button key={k} type="button" role="radio" aria-checked={kind === k}
                    data-testid={`stock-kind-${k}`} onClick={() => setKind(k)}
                    className={`flex-1 rounded-lg min-h-[44px] border ${kind === k
                      ? "bg-green-600 text-white border-green-600" : "border-slate-300 text-slate-700"}`}>
              {t(`stock.${k}`)}
            </button>
          ))}
        </div>

        <label className="block text-sm text-slate-600">
          {t("stock.item")}
          <select value={itemId} onChange={(e) => setItemId(e.target.value)}
                  data-testid="stock-item" className={input}>
            <option value="">{t("stock.pickItem")}</option>
            {items.map((i) => (
              <option key={i.id} value={i.id}>{itemName(i, lang)} ({Number(i.stock_kg)} kg)</option>
            ))}
          </select>
          {fieldErrors.itemId && <span data-testid="stock-err-itemId" className="text-xs text-red-600">{t(fieldErrors.itemId)}</span>}
        </label>

        <div className="grid grid-cols-2 gap-2">
          <label className="block text-sm text-slate-600">
            {t("stock.kg")}
            <input inputMode="decimal" value={qtyKg} onChange={(e) => setQtyKg(e.target.value)}
                   data-testid="stock-kg" className={input} />
            {fieldErrors.qtyKg && <span data-testid="stock-err-qtyKg" className="text-xs text-red-600">{t(fieldErrors.qtyKg)}</span>}
          </label>
          {kind === "purchase" && (
            <label className="block text-sm text-slate-600">
              {t("stock.cost")}
              <input inputMode="decimal" value={unitCost} onChange={(e) => setUnitCost(e.target.value)}
                     data-testid="stock-cost" className={input} />
              {fieldErrors.unitCost && <span data-testid="stock-err-unitCost" className="text-xs text-red-600">{t(fieldErrors.unitCost)}</span>}
            </label>
          )}
        </div>

        <label className="block text-sm text-slate-600">
          {t("stock.note")}
          <input value={note} onChange={(e) => setNote(e.target.value)} data-testid="stock-note" className={input} />
        </label>

        <button onClick={() => void submit()} disabled={saving} data-testid="stock-submit"
                className="w-full bg-green-600 text-white rounded-lg min-h-[44px] disabled:opacity-50">
          {t("stock.submit")}
        </button>
      </section>

      {problem && (
        <div data-testid="stock-problem" className="bg-red-50 border border-red-200 rounded-lg p-3">
          <p className="text-sm text-red-700">
            {t(problem.key, { kg: problem.kg ?? "" })}
          </p>
          {problem.detail && (
            <p className="text-xs text-red-600 mt-1 break-words">{t("error.details")}: {problem.detail}</p>
          )}
        </div>
      )}

      <DateFilter value={range} onChange={setRange} />

      {busy && <p className="text-sm text-slate-500">{t("stock.loading")}</p>}
      {!busy && rows.length === 0 && <p className="text-sm text-slate-500">{t("stock.empty")}</p>}

      <ul className="space-y-2">
        {rows.map((m) => (
          <li key={m.id} data-testid={`stock-row-${m.id}`}
              className="bg-white border border-slate-200 rounded-xl p-3 text-sm">
            <div className="flex justify-between gap-3">
              <span className="text-slate-800">{itemName(m, lang)}</span>
              <span className={m.kind === "purchase" ? "text-green-700" : "text-red-700"}>
                {signedKg(m.kind, m.qty_kg)}
              </span>
            </div>
            <div className="flex justify-between gap-3 text-xs text-slate-500">
              <span>
                {new Date(m.created_at).toLocaleString()}
                {m.created_by_name ? ` · ${t("stock.by", { name: m.created_by_name })}` : ""}
                {m.note ? ` · ${m.note}` : ""}
              </span>
              {m.unit_cost !== null && <span>{rupees(Number(m.unit_cost))}/kg</span>}
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
