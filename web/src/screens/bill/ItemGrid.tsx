import { useState } from "react";
import { useTranslation } from "react-i18next";
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

      <div className="grid grid-cols-2 gap-2">
        {items.map((item) => (
          <button
            key={item.id}
            onClick={() => {
              setSelected(item);
              setWeight("");
              setReason(null);
            }}
            className={`rounded-xl border p-3 min-h-[44px] text-left bg-white ${
              selected?.id === item.id ? "border-emerald-500 ring-2 ring-emerald-200" : "border-slate-200"
            }`}
          >
            <span className="block font-medium text-slate-800">{itemName(item, lang)}</span>
            <span className="block text-sm text-slate-600">{rupees(item.price)}</span>
            <span className={`block text-xs ${stockClass(item.stock_kg)}`}>
              {item.stock_kg <= 0 ? t("bill.outOfStock") : t("bill.stock", { kg: item.stock_kg })}
            </span>
          </button>
        ))}
      </div>

      {selected && (
        <div className="space-y-2 border border-slate-200 rounded-xl bg-white p-3">
          <label className="block text-sm text-slate-600">
            {t("bill.weightKg")}
            {/* Scales report values like 1.35, so this is a decimal keypad, not a stepper. */}
            <input
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
