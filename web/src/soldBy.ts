import type { Unit } from "./units";

/** `unclear`: the line names a quantity other than one of its unit ("6 pc", "5 kg", "½ kg"),
 * so its price is not a per-unit price. The unit is still a best guess; the price must be typed. */
export type SoldBy = { unit: Unit; price: number; grams: number | null; unclear: boolean };

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * The owner's "sold by" rules for a rate-list line. Run here, not in the model's prompt,
 * so they are the same every day and tested. Order matters: grams before the kg default,
 * a dozen before the generic piece words (a dozen is written "12 pc").
 */
/** A count or fraction before a kg/piece/box/packet word, other than exactly 1. */
function unclearQuantity(s: string): boolean {
  if (/[½¼¾⅓⅔]/.test(s)) return true;
  const m = /(?:^|[^\d./])(\d+(?:\.\d+)?(?:\s*\/\s*\d+)?)\s*(?:kg|kgs|kilo|kilos|pc|pcs|piece|pieces|box|boxes|packet|packets|pkt|pack|nos|नग)(?![a-z])/.exec(` ${s}`);
  if (!m?.[1]) return false;
  const q = m[1].replace(/\s/g, "");
  return q.includes("/") || Number(q) !== 1;
}

export function normaliseSoldBy(soldBy: string, price: number): SoldBy {
  const s = soldBy.normalize("NFC").toLowerCase().trim();
  const unclear = unclearQuantity(s);

  // "250 g", "250gm", "500 gms", "100 grams", "250 ग्राम" -- but never the g of "kg".
  const g = /(?:^|[^\d.])(\d+(?:\.\d+)?)\s*(?:g|gm|gms|gram|grams|ग्राम)(?![a-z])/.exec(` ${s}`);
  if (g && !/\d\s*kg/.test(s)) {
    const grams = Number(g[1]);
    if (grams > 0) return { unit: "kg", price: round2((price * 1000) / grams), grams, unclear: false };
  }
  if (/(?:^|[^\d])12\s*(?:pc|pcs|piece|pieces|nos)\b|dozen|\bdz\b|दर्जन|डझन/.test(s)) {
    return { unit: "dozen", price, grams: null, unclear: false };
  }
  if (/bunch|जुडी|गड्डी|judi/.test(s)) return { unit: "bunch", price, grams: null, unclear };
  if (/box|packet|\bpkt\b|\bpack\b|\bpcs?\b|piece|\bnos\b|नग/.test(s)) {
    return { unit: "piece", price, grams: null, unclear };
  }
  return { unit: "kg", price, grams: null, unclear };
}
