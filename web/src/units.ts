import type { TFunction } from "i18next";
import { validateWeight } from "./billing";

/** How an item is sold. Mirrors the CHECK on items.unit. Every unit but kg is counted in
 *  whole numbers; the server refuses a fraction for them with 22023. */
export type Unit = "kg" | "piece" | "bunch" | "dozen";
export const UNITS: readonly Unit[] = ["kg", "piece", "bunch", "dozen"];

export function isUnit(v: unknown): v is Unit {
  return typeof v === "string" && (UNITS as readonly string[]).includes(v);
}

export function isWholeUnit(unit: Unit): boolean {
  return unit !== "kg";
}

export type QtyReason = "empty" | "notANumber" | "notPositive" | "tooPrecise" | "notWhole";

/** A quantity as typed for this unit. kg keeps validateWeight's rules; the whole units
 *  take digits only, so "2.0" is refused as notWhole rather than silently accepted. */
export function validateQty(
  raw: string,
  unit: Unit,
): { ok: true; value: number } | { ok: false; reason: QtyReason } {
  if (!isWholeUnit(unit)) return validateWeight(raw);
  const text = raw.trim();
  if (text === "") return { ok: false, reason: "empty" };
  if (!/^\d+$/.test(text)) {
    return { ok: false, reason: /^\d+\.\d+$/.test(text) ? "notWhole" : "notANumber" };
  }
  const value = Number(text);
  if (value <= 0) return { ok: false, reason: "notPositive" };
  return { ok: true, value };
}

export function qtyText(qty: number | string, unit: Unit, t: TFunction): string {
  return t(`unit.qty.${unit}`, { n: Number(qty) });
}

export function perUnit(unit: Unit, t: TFunction): string {
  return t(`unit.per.${unit}`);
}
