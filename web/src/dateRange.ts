/**
 * Every date boundary in the app, in one place.
 *
 * Two screens filter by date, and if they disagreed about where a week starts the same
 * question would get two answers depending on which screen you asked. So the boundaries
 * live here and the screens hold only a Range.
 *
 * Dates are plain YYYY-MM-DD strings, interpreted in the DEVICE's timezone. That is the
 * shop's timezone in practice, and it is the only one the person reading the screen
 * thinks in. toBounds() converts to instants for the query, so the comparison the
 * database performs is on the instant and is correct regardless of the server's zone --
 * which matters, because Supabase runs in UTC and the shops are at UTC+5:30.
 */

export type Preset = "today" | "week" | "month";

/** Inclusive at both ends, at day granularity. */
export type Range = { from: string; to: string };

export const PRESETS: readonly Preset[] = ["today", "week", "month"];

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

function ymd(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Monday of the week containing d. Postgres's date_trunc('week') is Monday-based
 *  (0004_views.sql), and a UI that started weeks on Sunday would disagree with the very
 *  numbers it filters. getDay() is 0 for Sunday, so Sunday maps back six days. */
function mondayOf(d: Date): Date {
  const day = d.getDay();
  const back = day === 0 ? 6 : day - 1;
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() - back);
}

export function presetRange(preset: Preset, now: Date): Range {
  const today = ymd(now);
  if (preset === "today") return { from: today, to: today };
  if (preset === "week") return { from: ymd(mondayOf(now)), to: today };
  return { from: ymd(new Date(now.getFullYear(), now.getMonth(), 1)), to: today };
}

/** Parses YYYY-MM-DD strictly. new Date("2026-13-01") does not throw in every engine, so
 *  the parts are checked against the date that comes back rather than trusted. */
function parseYmd(s: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s.trim());
  if (!m) return null;
  const [y, mo, da] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const d = new Date(y, mo - 1, da);
  if (d.getFullYear() !== y || d.getMonth() !== mo - 1 || d.getDate() !== da) return null;
  return d;
}

export function validateRange(
  from: string,
  to: string,
): { ok: true; value: Range } | { ok: false; error: string } {
  const f = parseYmd(from);
  const t = parseYmd(to);
  if (!f || !t) return { ok: false, error: "range.badDate" };
  // Rejected rather than sent: the query would succeed and return nothing, which reads
  // as "no sales" rather than "bad input".
  if (f.getTime() > t.getTime()) return { ok: false, error: "range.backwards" };
  return { ok: true, value: { from: ymd(f), to: ymd(t) } };
}

/** fromTs inclusive, toTs EXCLUSIVE -- the instant midnight begins the day after `to`.
 *  An inclusive end at day granularity would drop every bill completed after midnight on
 *  the final day, which is all of them. */
export function toBounds(r: Range): { fromTs: string; toTs: string } {
  const f = parseYmd(r.from);
  const t = parseYmd(r.to);
  if (!f || !t) throw new Error(`toBounds called with an invalid range: ${r.from}..${r.to}`);
  const end = new Date(t.getFullYear(), t.getMonth(), t.getDate() + 1);
  return { fromTs: f.toISOString(), toTs: end.toISOString() };
}
