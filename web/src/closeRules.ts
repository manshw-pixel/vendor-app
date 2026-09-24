/**
 * The day-close screen's arithmetic and parsing, kept out of the component so it can be
 * tested without rendering. Nothing here talks to the database.
 */

const paise = (n: number): number => Math.round(n * 100) / 100 || 0;

export function parseCounted(
  raw: string,
): { ok: true; value: number } | { ok: false; reason: "empty" | "notANumber" | "negative" | "tooPrecise" } {
  const text = raw.trim();
  if (text === "") return { ok: false, reason: "empty" };
  // Plain decimals only: "1e3" would be read as 1000 by Number() and by Postgres alike,
  // which is not what anyone counting a drawer typed.
  if (!/^-?\d+(\.\d+)?$/.test(text)) return { ok: false, reason: "notANumber" };
  const value = Number(text);
  if (value < 0) return { ok: false, reason: "negative" };
  if ((text.split(".")[1]?.length ?? 0) > 2) return { ok: false, reason: "tooPrecise" };
  return { ok: true, value };
}

/** Counted minus expected, to the paisa. The server computes the stored figure the same way. */
export function differenceOf(counted: number, expected: number): number {
  return paise(counted - expected);
}

export type CloseRow = {
  id: string;
  business_date: string;
  expected_cash: number;
  counted_cash: number;
  difference: number;
  note: string | null;
  closed_at: string;
  reopened_at: string | null;
  reopen_reason: string | null;
  closer: string | null;
};

/** The newest close for each date (a reopened day may have several), newest date first. */
export function latestPerDate(rows: readonly CloseRow[], limit = 14): CloseRow[] {
  const byDate = new Map<string, CloseRow>();
  for (const r of rows) {
    const seen = byDate.get(r.business_date);
    if (!seen || r.closed_at > seen.closed_at) byDate.set(r.business_date, r);
  }
  return [...byDate.values()]
    .sort((a, b) => (a.business_date < b.business_date ? 1 : -1))
    .slice(0, limit);
}

/**
 * "2026-09-22" is a calendar date, not an instant. new Date("2026-09-22") would parse it as
 * UTC midnight and show the 21st west of Greenwich, so build it from its parts in local time.
 */
export function formatBusinessDate(ymd: string, lang: string): string {
  const [y, m, d] = ymd.split("-").map(Number) as [number, number, number];
  return new Date(y, m - 1, d).toLocaleDateString(lang, { day: "numeric", month: "short" });
}
