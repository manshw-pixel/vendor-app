import { supabase } from "./supabase";
import { REPAY_MODES, type RepayMode, type SplitMode } from "./payments";
import type { CloseRow } from "./closeRules";

/**
 * The reads and writes behind the Close day screen and the unclosed-days banner. A sibling
 * to data.ts, history.ts and receipt.ts: a small surface the screens stub in tests. Nothing
 * here filters by vendor -- RLS scopes every query.
 *
 * As in receipt.ts, everything returned is already coerced: PostgREST sends numeric as a
 * string, and the screen must never do arithmetic on one.
 */

type DbError = { message?: string; code?: string } | null;
const num = (v: unknown): number => Number(v ?? 0);

export type DaySummary = {
  business_date: string;
  split: Record<SplitMode, { total: number; count: number }>;
  expected_cash: number;
  pending_tokens: number;
  /** Repayments of udhaar received that day (0022), by mode. Cash is already in expected_cash. */
  dues: Record<RepayMode, { total: number; count: number }>;
  /** Credit given that day that is still uncollected, as of now (0023). Falls as the
   *  customer pays, FIFO -- even after the day is closed. */
  creditOpen: { total: number; count: number };
};

/** Omitting the date asks the server for today in Asia/Kolkata, so a phone on the wrong
 *  timezone still closes the right day. Parameter names must match 0021 exactly. */
export async function loadDaySummary(date?: string): Promise<{ data: DaySummary | null; error: DbError }> {
  const { data, error } = await supabase.rpc("day_summary", date ? { p_date: date } : {});
  if (error) return { data: null, error };
  const r = (Array.isArray(data) ? data[0] : data) as Record<string, unknown> | undefined;
  if (!r) return { data: null, error: null };
  const pair = (m: SplitMode) => ({ total: num(r[m]), count: num(r[`${m}_count`]) });
  return {
    data: {
      business_date: String(r.business_date).slice(0, 10),
      split: {
        cash: pair("cash"), upi: pair("upi"), card: pair("card"),
        credit: pair("credit"), unrecorded: pair("unrecorded"),
      },
      expected_cash: num(r.expected_cash),
      pending_tokens: num(r.pending_tokens),
      dues: Object.fromEntries(REPAY_MODES.map((m) => [m, { total: num(r[`dues_${m}`]), count: num(r[`dues_${m}_count`]) }])) as
        Record<RepayMode, { total: number; count: number }>,
      creditOpen: { total: num(r.credit_open), count: num(r.credit_open_count) },
    },
    error: null,
  };
}

export async function closeDay(date: string, counted: number, note: string) {
  return supabase.rpc("close_day", {
    p_date: date, p_counted_cash: counted, p_note: note.trim() === "" ? null : note.trim(),
  });
}

export async function reopenDay(date: string, reason: string) {
  return supabase.rpc("reopen_day", { p_date: date, p_reason: reason.trim() });
}

// closed_by and reopened_by both reference app_users, so the embed must name its key.
const CLOSE_COLS =
  "id, business_date, expected_cash, counted_cash, difference, note, closed_at, " +
  "reopened_at, reopen_reason, closer:app_users!day_closes_closed_by_fkey(name)";

/** Enough rows for 14 dates even when some were reopened and closed again. */
export async function loadRecentCloses(): Promise<{ data: CloseRow[] | null; error: DbError }> {
  const { data, error } = await supabase
    .from("day_closes")
    .select(CLOSE_COLS)
    .order("closed_at", { ascending: false })
    .limit(60);
  if (error) return { data: null, error };
  const rows = (data ?? []) as unknown as (Record<string, unknown> & { closer: { name: string } | null })[];
  return {
    data: rows.map((r) => ({
      id: String(r.id),
      business_date: String(r.business_date).slice(0, 10),
      expected_cash: num(r.expected_cash),
      counted_cash: num(r.counted_cash),
      difference: num(r.difference),
      note: (r.note as string | null) ?? null,
      closed_at: String(r.closed_at),
      reopened_at: (r.reopened_at as string | null) ?? null,
      reopen_reason: (r.reopen_reason as string | null) ?? null,
      closer: r.closer?.name ?? null,
    })),
    error: null,
  };
}

export async function loadUnclosedDays(): Promise<{ data: string[] | null; error: DbError }> {
  const { data, error } = await supabase.rpc("unclosed_days");
  if (error) return { data: null, error };
  return {
    data: ((data ?? []) as { business_date: string }[]).map((r) => String(r.business_date).slice(0, 10)),
    error: null,
  };
}

/** Tells the banner to re-read right away after a close or reopen, instead of on its next
 *  poll -- a banner still nagging about the day just closed reads as "it did not work". */
export const DAY_CLOSES_CHANGED = "day-closes-changed";
export function notifyDayClosesChanged(): void {
  window.dispatchEvent(new Event(DAY_CLOSES_CHANGED));
}
