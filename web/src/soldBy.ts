import type { Unit } from "./units";

export type SoldBy = { unit: Unit; price: number; grams: number | null };

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * The owner's "sold by" rules for a rate-list line. Run here, not in the model's prompt,
 * so they are the same every day and tested. Order matters: grams before the kg default,
 * a dozen before the generic piece words (a dozen is written "12 pc").
 */
export function normaliseSoldBy(soldBy: string, price: number): SoldBy {
  const s = soldBy.normalize("NFC").toLowerCase().trim();

  // "250 g", "250gm", "500 gms", "100 grams", "250 ग्राम" -- but never the g of "kg".
  const g = /(?:^|[^\d.])(\d+(?:\.\d+)?)\s*(?:g|gm|gms|gram|grams|ग्राम)(?![a-z])/.exec(` ${s}`);
  if (g && !/\d\s*kg/.test(s)) {
    const grams = Number(g[1]);
    if (grams > 0) return { unit: "kg", price: round2((price * 1000) / grams), grams };
  }
  if (/(?:^|[^\d])12\s*(?:pc|pcs|piece|pieces|nos)\b|dozen|\bdz\b|दर्जन|डझन/.test(s)) {
    return { unit: "dozen", price, grams: null };
  }
  if (/bunch|जुडी|गड्डी|judi/.test(s)) return { unit: "bunch", price, grams: null };
  if (/box|packet|\bpkt\b|\bpack\b|\bpcs?\b|piece|\bnos\b|नग/.test(s)) {
    return { unit: "piece", price, grams: null };
  }
  return { unit: "kg", price, grams: null };
}
