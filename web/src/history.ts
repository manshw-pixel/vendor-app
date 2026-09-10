import { supabase } from "./supabase";
import { toBounds, type Range } from "./dateRange";

/**
 * The reads behind the history and dashboard screens.
 *
 * A third sibling to data.ts (billing) and admin.ts (admin), for the same reason both of
 * those exist: a small surface the screens stub in tests, kept small enough to hold in
 * one head.
 *
 * As in both siblings, nothing here filters by vendor. RLS scopes every query to the
 * caller's tenant, and a client-side filter would be a weaker second copy of the policy.
 */

export type CompletedBill = {
  id: string;
  token_no: number;
  total: number;
  /** What was applied from the customer's loyalty balance. `total` is the NET actually
   *  collected, so the gross a shopkeeper reconciling by hand expects is
   *  `total + redeemed_points` (1 point = ₹1). 0 for the common case of no redemption. */
  redeemed_points: number;
  completed_at: string;
  customers: { name: string; flat_no: string } | null;
};

export type BillLine = {
  id: string;
  qty_kg: number;
  unit_price: number;
  line_total: number;
  items: { name_en: string; name_hi: string; name_mr: string } | null;
};

export type TopItem = {
  item_id: string;
  name_en: string;
  name_hi: string;
  name_mr: string;
  total_qty_kg: number;
  total_revenue: number;
};

export type Pair = {
  item_a: string;
  item_b: string;
  name_a: string;
  name_b: string;
  bill_count: number;
};

/** One row. `total` arrives as a STRING: it is a Postgres numeric, and PostgREST
 *  serialises numeric as text to avoid float rounding. Coerce before arithmetic. */
export type Collected = { total: string | number; bill_count: number };

/** The keyset a "load more" resumes from. completed_at alone is not unique. */
export type Cursor = { completedAt: string; id: string };

/** Roughly a busy shop's day, so the first page usually answers "what happened today"
 *  without a second request. */
export const PAGE_SIZE = 50;

const BILL_COLS =
  "id, token_no, total, redeemed_points, completed_at, customers(name, flat_no)";

/**
 * One page of completed bills, newest first.
 *
 * Keyset, not offset. completed_at is not unique -- two bills finished in the same clock
 * tick are ordinary in a queue -- and an offset over a non-unique sort key silently drops
 * or repeats a row at the page boundary. The tuple (completed_at, id) is unique, so
 * resuming strictly after it is exact.
 *
 * Asks for PAGE_SIZE + 1 rows: if the extra one comes back there is another page, which
 * the caller learns without paying for a count query.
 */
export async function listCompleted(range: Range, after: Cursor | null) {
  const { fromTs, toTs } = toBounds(range);
  let q = supabase
    .from("bills")
    .select(BILL_COLS)
    .eq("status", "done")
    .gte("completed_at", fromTs)
    .lt("completed_at", toTs);

  if (after) {
    // Lexicographic on (completed_at, id): strictly earlier, or the same instant with a
    // smaller id.
    //
    // Both values are interpolated into PostgREST's filter grammar unescaped, which is
    // safe ONLY because neither is user input: completed_at is an ISO timestamp and id a
    // uuid, both round-tripped from a previous response of this same query. Thread a
    // user-supplied cursor through here and that stops being true.
    q = q.or(
      `completed_at.lt.${after.completedAt},` +
        `and(completed_at.eq.${after.completedAt},id.lt.${after.id})`,
    );
  }

  return q
    .order("completed_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(PAGE_SIZE + 1);
}

export async function billLines(billId: string) {
  return supabase
    .from("bill_items")
    .select("id, qty_kg, unit_price, line_total, items(name_en, name_hi, name_mr)")
    .eq("bill_id", billId);
}

/**
 * Money collected and bill count for the window, aggregated in SQL.
 *
 * Two reasons it is an RPC rather than a select.
 *
 * It must not be v_payments_daily: that view buckets with date_trunc('day',
 * completed_at), which resolves in the database server's timezone -- UTC on Supabase --
 * while the shops are at UTC+5:30. A sale at 02:00 IST is 20:30 the previous day in UTC,
 * so UTC buckets would attribute the first five and a half hours of every Indian day to
 * yesterday, and nobody would notice until the dashboard disagreed with the cash drawer.
 *
 * And it must not select the rows and sum them here: PostgREST caps a response at
 * db-max-rows (1000 on Supabase Cloud) and returns the truncated page with NO error, so a
 * shop doing sixty bills a day would watch its month's takings stop growing partway
 * through, silently. Summing in the database has no such ceiling.
 */
export async function collectedBetween(range: Range) {
  const { fromTs, toTs } = toBounds(range);
  return supabase.rpc("collected_between", { p_from: fromTs, p_to: toTs });
}

/** Parameter names must match 0007_analytics_by_date.sql exactly; PostgREST resolves the
 *  overload by argument name, and a mismatch reads as "function not found". */
export async function topItemsBetween(range: Range) {
  const { fromTs, toTs } = toBounds(range);
  return supabase.rpc("top_items_between", { p_from: fromTs, p_to: toTs });
}

export async function pairsBetween(range: Range) {
  const { fromTs, toTs } = toBounds(range);
  return supabase.rpc("bought_together_between", { p_from: fromTs, p_to: toTs });
}
