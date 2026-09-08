export type Draft = {
  itemId: string;
  name: string;
  unitPrice: number;
  qtyKg: number;
};

/** numeric(10,2): two decimal places, so round here rather than let Postgres do it
 *  silently and leave the screen showing a different number from the stored row. */
const paise = (n: number): number => Math.round(n * 100) / 100;

export function lineTotal(unitPrice: number, qtyKg: number): number {
  return paise(unitPrice * qtyKg);
}

export function runningTotal(lines: readonly Draft[]): number {
  // Sum of the ROUNDED lines, matching what bill_items will hold. Summing the raw
  // products and rounding once would drift from the stored rows by a paisa or two.
  return paise(lines.reduce((sum, l) => sum + lineTotal(l.unitPrice, l.qtyKg), 0));
}

export function validateWeight(
  raw: string,
): { ok: true; value: number } | { ok: false; reason: "empty" | "notANumber" | "notPositive" | "tooPrecise" } {
  const text = raw.trim();
  if (text === "") return { ok: false, reason: "empty" };
  const value = Number(text);
  if (!Number.isFinite(value)) return { ok: false, reason: "notANumber" };
  if (value <= 0) return { ok: false, reason: "notPositive" };
  const decimals = text.split(".")[1]?.length ?? 0;
  if (decimals > 2) return { ok: false, reason: "tooPrecise" };
  return { ok: true, value };
}
