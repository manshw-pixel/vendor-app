import { useState } from "react";
import { useTranslation } from "react-i18next";

type T = ReturnType<typeof useTranslation>["t"];
import { type Draft } from "../../billing";
import type { Item } from "../../data";
import { itemName, type Lang } from "../../i18n/locales";
import { rupees } from "../../money";
import { stockLevel } from "../../adminRules";
import { isWholeUnit, qtyText, validateQty } from "../../units";

/**
 * Stock is SHOWN, never enforced. complete_bill clamps the decrement at zero on purpose,
 * and a tile disabled here would be a weaker second copy of a rule the database owns --
 * wrong in exactly the case it looks like it protects, when the shop has produce the
 * stock figure has not caught up with.
 *
 * The threshold is the ITEM's own low_stock_at, the same exclusive comparison
 * adminRules.stockLevel and v_low_stock make, so the grid, the admin list and the badge
 * never disagree about what "low" means.
 */
function stockClass(kg: number, lowAt: number): string {
  const level = stockLevel(kg, lowAt);
  if (level === "out") return "text-red-600";
  if (level === "low") return "text-amber-600";
  return "text-slate-500";
}

function stockText(kg: number, unit: Item["unit"], t: T): string {
  return kg <= 0 ? t("bill.outOfStock") : t("bill.stock", { qty: qtyText(kg, unit, t) });
}

export function ItemGrid({
  items,
  lang,
  onAdd,
}: {
  items: readonly Item[];
  lang: Lang;
  onAdd: (line: Draft) => void;
}) {
  const { t } = useTranslation();
  const [selected, setSelected] = useState<Item | null>(null);
  const [qty, setQty] = useState("");
  const [reason, setReason] = useState<string | null>(null);

  function add() {
    if (!selected) return;
    const check = validateQty(qty, selected.unit);
    if (!check.ok) {
      setReason(check.reason);
      return;
    }
    onAdd({
      itemId: selected.id,
      name: itemName(selected, lang),
      unitPrice: selected.price,
      unit: selected.unit,
      qtyKg: check.value,
    });
    setSelected(null);
    setQty("");
    setReason(null);
  }

  function step(delta: number) {
    const current = qty.trim() === "" ? 0 : Number(qty);
    const next = Math.max(1, (Number.isFinite(current) ? current : 0) + delta);
    setQty(String(next));
  }

  return (
    <div className="space-y-3">
      <h2 className="font-semibold text-slate-800">{t("bill.addItem")}</h2>

      <label className="block text-sm text-slate-600" htmlFor="item-select">
        {t("bill.chooseItem")}
        <select
          id="item-select"
          data-testid="item-select"
          value={selected?.id ?? ""}
          onChange={(e) => {
            setSelected(items.find((i) => i.id === e.target.value) ?? null);
            setQty("");
            setReason(null);
          }}
          className="mt-1 w-full border border-slate-300 rounded-lg px-3 py-2 min-h-[44px] bg-white text-base text-slate-800"
        >
          <option value="">{t("bill.chooseItem")}</option>
          {items.map((item) => (
            <option key={item.id} value={item.id}>
              {`${itemName(item, lang)} — ${rupees(item.price)} · ${stockText(item.stock_kg, item.unit, t)}`}
            </option>
          ))}
        </select>
      </label>

      {selected && (
        <div className="space-y-2 border border-slate-200 rounded-xl bg-white p-3">
          {/* <option> cannot carry stockClass's colour, so the warning that the shop is
              low or out is repeated here, where it can be styled, for the one item the
              recorder actually picked. */}
          <p data-testid="item-detail" className="text-sm text-slate-700">
            {rupees(selected.price)}
            <span className={`ml-2 text-xs ${stockClass(selected.stock_kg, selected.low_stock_at)}`}>
              {stockText(selected.stock_kg, selected.unit, t)}
            </span>
          </p>
          <label className="block text-sm text-slate-600">
            {t(`unit.field.${selected.unit}`)}
            {isWholeUnit(selected.unit) ? (
              <span className="mt-1 flex items-center gap-2">
                <button
                  type="button"
                  data-testid="qty-minus"
                  aria-label={t("unit.step.minus")}
                  onClick={() => step(-1)}
                  className="min-h-[44px] min-w-[44px] rounded-lg border border-slate-300 text-lg"
                >
                  −
                </button>
                <input
                  data-testid="qty-input"
                  type="text"
                  inputMode="numeric"
                  value={qty}
                  onChange={(e) => setQty(e.target.value)}
                  className="w-full border border-slate-300 rounded-lg px-3 py-2 min-h-[44px] text-lg text-center"
                />
                <button
                  type="button"
                  data-testid="qty-plus"
                  aria-label={t("unit.step.plus")}
                  onClick={() => step(1)}
                  className="min-h-[44px] min-w-[44px] rounded-lg border border-slate-300 text-lg"
                >
                  +
                </button>
              </span>
            ) : (
              // Scales report values like 1.35, so this is a decimal keypad, not a stepper.
              <input
                data-testid="weight-input"
                type="text"
                inputMode="decimal"
                value={qty}
                onChange={(e) => setQty(e.target.value)}
                className="mt-1 w-full border border-slate-300 rounded-lg px-3 py-2 min-h-[44px] text-lg"
              />
            )}
          </label>
          {reason && <p className="text-sm text-red-600">{t(`bill.badWeight.${reason}`)}</p>}
          <button
            onClick={add}
            className="w-full rounded-lg px-3 py-2 min-h-[44px] bg-emerald-600 text-white"
          >
            {t("bill.add")}
          </button>
        </div>
      )}
    </div>
  );
}
