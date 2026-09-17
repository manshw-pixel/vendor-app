import { supabase } from "./supabase";

/**
 * The reads behind the printed receipt.
 *
 * A fourth sibling to data.ts (billing), admin.ts (admin) and history.ts (history), for
 * the same reason all three exist: a small surface the screen stubs in tests.
 *
 * As in its siblings, nothing here filters by vendor. RLS scopes every query, and a
 * client-side filter would be a weaker second copy of the policy.
 *
 * Everything this module returns is already coerced and already derived. The screen
 * receives a finished object and does no arithmetic -- which is what keeps Receipt.tsx
 * purely about the 58mm layout.
 */

export type ReceiptLine = {
  id: string;
  qty_kg: number;
  unit_price: number;
  line_total: number;
  items: { name_en: string; name_hi: string; name_mr: string } | null;
};

export type Receipt = {
  token_no: number;
  completed_at: string;
  /** What was actually collected: bills.total. */
  net: number;
  /** Before the loyalty discount: net + redeemed_points. */
  gross: number;
  redeemed_points: number;
  lines: ReceiptLine[];
  customer: { name: string; flat_no: string } | null;
  biller_name: string | null;
  shop: { name: string; address: string | null; phone: string | null };
  points_earned: number;
  /** Live balance and days to expiry; null when there is no customer. */
  balance: { balance: number; days_left: number | null } | null;
};

/**
 * Separate from history.ts's BILL_COLS on purpose: it adds two joins (the biller's name
 * and the shop header) that the Completed list never renders, and that list is paged
 * fifty rows at a time.
 *
 * `app_users!bills_biller_id_fkey` disambiguates: bills references app_users twice
 * (recorder_id and biller_id), so an unqualified embed is ambiguous to PostgREST.
 * bills.biller_id's foreign key is unnamed in 0001_schema.sql (`references app_users(id)`
 * inline), so Postgres generated the default name for it: <table>_<column>_fkey, i.e.
 * bills_biller_id_fkey.
 */
const RECEIPT_COLS =
  "token_no, completed_at, total, redeemed_points, customer_id, " +
  "customers(name, flat_no), app_users!bills_biller_id_fkey(name), " +
  "vendors(name, address, phone)";

/** PostgREST serialises numeric as TEXT to avoid float rounding. Everything monetary
 *  passes through here before it reaches arithmetic or rendering. */
const num = (v: unknown): number => Number(v ?? 0);

export async function loadReceipt(billId: string): Promise<
  | { data: Receipt; error: null }
  | { data: null; error: { message?: string; code?: string } | null }
> {
  const { data: bill, error } = await supabase
    .from("bills")
    .select(RECEIPT_COLS)
    .eq("id", billId)
    .maybeSingle();

  if (error || !bill) return { data: null, error: error ?? null };

  const b = bill as unknown as {
    token_no: number;
    completed_at: string;
    total: string | number;
    redeemed_points: number;
    customer_id: string | null;
    customers: { name: string; flat_no: string } | null;
    app_users: { name: string } | null;
    vendors: { name: string; address: string | null; phone: string | null } | null;
  };

  const { data: lineRows, error: lineError } = await supabase
    .from("bill_items")
    .select("id, qty_kg, unit_price, line_total, items(name_en, name_hi, name_mr)")
    .eq("bill_id", billId);

  if (lineError) return { data: null, error: lineError };

  // Points EARNED on this bill, read rather than recomputed. A client-side copy of the
  // threshold rule would drift from complete_bill the first time a vendor tunes their
  // config in Settings. Positive rows only: the negative row on this same bill_id is the
  // redemption, which redeemed_points already reports.
  const { data: ledgerRows, error: ledgerError } = await supabase
    .from("points_ledger")
    .select("points")
    .eq("bill_id", billId)
    .gt("points", 0);

  if (ledgerError) return { data: null, error: ledgerError };

  let balance: Receipt["balance"] = null;
  if (b.customer_id) {
    // Parameter name must match 0003_functions.sql exactly; PostgREST resolves the
    // overload by argument name, and a mismatch reads as "function not found".
    const { data: rpcData } = await supabase.rpc("customer_points_balance", {
      p_customer_id: b.customer_id,
    });
    // A returns-table function arrives from PostgREST as an array of one row.
    const row = (Array.isArray(rpcData) ? rpcData[0] : rpcData) as
      | { balance: number; days_left: number | null }
      | undefined;
    // A failed or empty balance read must not lose the receipt: the slip's job is the
    // sale, and the points block is an extra. Falls back to zero rather than propagating.
    balance = row
      ? { balance: num(row.balance), days_left: row.days_left }
      : { balance: 0, days_left: null };
  }

  const net = num(b.total);
  const redeemed = num(b.redeemed_points);

  const data: Receipt = {
    token_no: b.token_no,
    completed_at: b.completed_at,
    net,
    // bills.total is the NET (0010). The gross a customer expects to see itemised is
    // total + redeemed_points, at 1 point = ₹1.
    gross: net + redeemed,
    redeemed_points: redeemed,
    lines: ((lineRows ?? []) as unknown as ReceiptLine[]).map((l) => ({
      id: l.id,
      qty_kg: num(l.qty_kg),
      unit_price: num(l.unit_price),
      line_total: num(l.line_total),
      items: l.items ?? null,
    })),
    customer: b.customers ?? null,
    biller_name: b.app_users?.name ?? null,
    shop: {
      name: b.vendors?.name ?? "",
      address: b.vendors?.address ?? null,
      phone: b.vendors?.phone ?? null,
    },
    points_earned: ((ledgerRows ?? []) as { points: number }[]).reduce(
      (sum, r) => sum + num(r.points),
      0,
    ),
    balance,
  };

  return { data, error: null };
}
