import { parseCounted } from "./closeRules";

/**
 * The Dues screens' parsing and arithmetic, kept out of the components so they can be
 * tested without rendering. Nothing here talks to the database.
 */

const paise = (n: number): number => Math.round(n * 100) / 100 || 0;

/** A repayment or opening amount: the counted-cash rules, and more than zero. */
export function parseAmount(
  raw: string,
): { ok: true; value: number } | { ok: false; reason: "empty" | "notANumber" | "negative" | "tooPrecise" | "zero" } {
  const p = parseCounted(raw);
  if (!p.ok) return p;
  if (p.value === 0) return { ok: false, reason: "zero" };
  return p;
}

/** Filters an already-fetched list, like matchCustomers. RLS already scoped it. */
export function matchDues<T extends { name: string; flat_no: string; mobile: string }>(
  rows: readonly T[], query: string,
): T[] {
  const q = query.trim().toLowerCase();
  if (q === "") return [...rows];
  return rows.filter((r) =>
    r.name.toLowerCase().includes(q) || r.flat_no.toLowerCase().includes(q) || r.mobile.includes(q));
}

/** What the shop is owed. An overpaid balance is owed BY the shop, so it is not netted off. */
export function totalOutstanding(rows: readonly { balance: number }[]): { amount: number; count: number } {
  const owing = rows.filter((r) => r.balance > 0);
  return { amount: paise(owing.reduce((s, r) => s + r.balance, 0)), count: owing.length };
}
