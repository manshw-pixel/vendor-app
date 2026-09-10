import { useState } from "react";
import { useTranslation } from "react-i18next";

type T = ReturnType<typeof useTranslation>["t"];
import { validateWeight, type Draft } from "../../billing";
import type { Item } from "../../data";
import { itemName, type Lang } from "../../i18n/locales";
import { rupees } from "../../money";

/**
 * Stock is SHOWN, never enforced. complete_bill clamps the decrement at zero on purpose,
 * and a tile disabled here would be a weaker second copy of a rule the database owns --
 * wrong in exactly the case it looks like it protects, when the shop has produce the
 * stock figure has not caught up with.
 */
function stockClass(kg: number): string {
  if (kg <= 0) return "text-red-600";
  if (kg < 10) return "text-amber-600";
  return "text-slate-500";
}

function stockText(kg: number, t: T): string {
  return kg <= 0 ? t("bill.outOfStock") : t("bill.stock", { kg });
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
  const [weight, setWeight] = useState("");
  const [reason, setReason] = useState<string | null>(null);

  function add() {
    if (!selected) return;
    const check = validateWeight(weight);
    if (!check.ok) {
      setReason(check.reason);
      return;
    }
    onAdd({
      itemId: selected.id,
      name: itemName(selected, lang),
      unitPrice: selected.price,
      qtyKg: check.value,
    });
    setSelected(null);
    setWeight("");
    setReason(null);
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
            setWeight("");
            setReason(null);
          }}
          className="mt-1 w-full border border-slate-300 rounded-lg px-3 py-2 min-h-[44px] bg-white text-base text-slate-800"
        >
          <option value="">{t("bill.chooseItem")}</option>
          {items.map((item) => (
            <option key={item.id} value={item.id}>
              {`${itemName(item, lang)} — ${rupees(item.price)} · ${stockText(item.stock_kg, t)}`}
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
            <span className={`ml-2 text-xs ${stockClass(selected.stock_kg)}`}>
              {stockText(selected.stock_kg, t)}
            </span>
          </p>
          <label className="block text-sm text-slate-600">
            {t("bill.weightKg")}
            {/* Scales report values like 1.35, so this is a decimal keypad, not a stepper. */}
            <input
              data-testid="weight-input"
              type="text"
              inputMode="decimal"
              value={weight}
              onChange={(e) => setWeight(e.target.value)}
              className="mt-1 w-full border border-slate-300 rounded-lg px-3 py-2 min-h-[44px] text-lg"
            />
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
