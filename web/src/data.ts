import { supabase } from "./supabase";
import type { Draft } from "./billing";
import type { Unit } from "./units";
import type { Customer } from "./customers";
import type { PaymentMode } from "./payments";

export type PostgrestErrorLike = { message?: string; code?: string } | null;

export type Item = {
  id: string;
  name_en: string;
  name_hi: string;
  name_mr: string;
  price: number;
  stock_kg: number;
  is_active: boolean;
  unit: Unit;
  low_stock_at: number;
};

export type PendingBill = {
  id: string;
  token_no: number;
  total: number;
  // Needed to read a loyalty balance before completing. Nullable because a walk-in bill
  // has no customer, and therefore nothing to redeem against.
  customer_id: string | null;
  customers: { name: string; flat_no: string } | null;
};

/**
 * Every PostgREST call in the billing flow lives here.
 *
 * Two reasons. It puts the vendor_id rule in one place instead of six call sites -- the
 * columns are NOT NULL with no default, and forgetting one is a bug that has already
 * shipped once. And it gives the screens a small surface to stub in tests, so component
 * tests never mock supabase-js itself.
 *
 * None of these functions filters by vendor. They do not need to: RLS scopes every
 * query to the caller's tenant, and a client-side filter would be a weaker second copy
 * of the policy.
 */

export async function listItems() {
  return supabase
    .from("items")
    .select("id, name_en, name_hi, name_mr, price, stock_kg, is_active, unit, low_stock_at")
    .eq("is_active", true)
    .order("name_en");
}

export async function listCustomers() {
  return supabase.from("customers").select("id, name, flat_no, mobile").order("name");
}

export async function createCustomer(
  vendorId: string,
  input: { name: string; flat_no: string; mobile: string },
) {
  return supabase
    .from("customers")
    .insert({ vendor_id: vendorId, ...input })
    .select("id, name, flat_no, mobile")
    .single();
}

/** The one row a duplicate-mobile insert collided with. The recorder cannot reach it by
 *  searching -- matchCustomers filters the list already fetched, which by definition does
 *  not contain it -- so the screen has to ask for it by name. */
export async function findCustomerByMobile(mobile: string) {
  return supabase
    .from("customers")
    .select("id, name, flat_no, mobile")
    .eq("mobile", mobile)
    .maybeSingle();
}

export async function createBill(vendorId: string, customerId: string, recorderId: string) {
  // No total. issue_token recomputes it from the line items, and sending one here would
  // suggest the client's figure is authoritative when the server discards it.
  return supabase
    .from("bills")
    .insert({
      vendor_id: vendorId,
      customer_id: customerId,
      recorder_id: recorderId,
      status: "recording",
    })
    .select("id")
    .single();
}

/**
 * Sets a recording bill's lines to exactly these.
 *
 * Safe to call again after a lost response: replace_bill_lines (0015) deletes and inserts
 * in one transaction, so a retry converges on the same rows instead of appending a second
 * copy. This is what replaced addLines + billHasLines -- the old pair could only narrow
 * the double-insert window, never close it, because the check was not atomic with the
 * insert.
 *
 * No vendor_id: the function reads it off the bill. No line_total: the function computes
 * it, so a client-supplied one cannot forge a bill's total.
 */
export async function replaceBillLines(billId: string, lines: readonly Draft[]) {
  return supabase.rpc("replace_bill_lines", {
    p_bill_id: billId,
    p_lines: lines.map((l) => ({
      item_id: l.itemId,
      qty_kg: l.qtyKg,
      unit_price: l.unitPrice,
    })),
  });
}

/** Parameter names must match 0003_functions.sql exactly; PostgREST resolves the
 *  overload by argument name, and a mismatch reads as "function not found". */
export async function issueToken(billId: string) {
  return supabase.rpc("issue_token", { p_bill_id: billId });
}

/** What the server actually recorded for this bill. Used only after a token attempt
 *  failed: issue_token may have committed and had its response lost, in which case the
 *  bill is already `billed` with a real token AND the customer has already been sent it
 *  (0003_functions.sql:54-56). Reading back a server-written row is not a recompute. */
export async function billToken(billId: string) {
  return supabase.from("bills").select("token_no, status").eq("id", billId).maybeSingle();
}

export async function listPending() {
  return supabase
    .from("bills")
    .select("id, token_no, total, customer_id, customers(name, flat_no)")
    .eq("status", "billed")
    .order("token_no", { ascending: false });
}

/**
 * Completes a sale with how it was paid, optionally spending some of the customer's points
 * and/or collecting an old due in the same transaction.
 *
 * p_payment_mode is required by the database (0021): a call without it is refused, so a
 * stale tab cannot complete a sale with no payment recorded. p_redeem_points is omitted
 * rather than sent as 0 when nothing is redeemed. Parameter names must match
 * 0021_payments_and_day_close.sql exactly -- PostgREST resolves the function by argument
 * name and a mismatch reads as "function not found". p_collect_due (0023) is likewise
 * omitted rather than sent as 0, so a call with nothing to collect is byte-identical to
 * before it existed.
 */
export async function completeBill(
  billId: string, mode: PaymentMode, redeemPoints?: number, collectDue?: number,
) {
  const args: Record<string, unknown> = { p_bill_id: billId, p_payment_mode: mode };
  if (redeemPoints && redeemPoints > 0) args.p_redeem_points = redeemPoints;
  if (collectDue && collectDue > 0) args.p_collect_due = collectDue;
  return supabase.rpc("complete_bill", args);
}

/** The customer's unexpired points balance. Already tenant-guarded inside the function. */
export async function customerBalance(customerId: string) {
  return supabase.rpc("customer_points_balance", { p_customer_id: customerId });
}

/** What complete_bill() actually AWARDED for this bill, not a client-side recompute of the
 *  vendor's threshold. Filtered on bill_id only for the tenant -- RLS (points_read)
 *  already scopes the read, so a second vendor filter here would be a weaker client-side
 *  copy of the policy. Zero rows is legitimate: a bill under the vendor's first threshold
 *  earns no points and complete_bill() writes no row for it.
 *
 *  points > 0 matters since redemption existed: a redeemed bill carries its award row AND
 *  its negative redemption rows under this same bill_id, and summing both would report the
 *  customer earned less than they did -- or a negative number on a bill that earned nothing. */
export async function pointsForBill(billId: string) {
  return supabase.from("points_ledger").select("points").eq("bill_id", billId).gt("points", 0);
}

/**
 * The same rewrite replaceBillLines performs, for a bill that already has a token.
 *
 * A separate function rather than a flag, because the SERVER functions are separate:
 * replace_bill_lines refuses anything past 'recording' and cannot fix the two things
 * that makes wrong (the quoted total, the queued message), while amend_pending_bill
 * (0020) recomputes the total and supersedes the message. The bill keeps its token.
 *
 * No line_total, for the same reason as replaceBillLines: the function computes it, so a
 * client-supplied one cannot forge a bill's total.
 */
export async function amendPendingBill(billId: string, lines: readonly Draft[]) {
  return supabase.rpc("amend_pending_bill", {
    p_bill_id: billId,
    p_lines: lines.map((l) => ({
      item_id: l.itemId,
      qty_kg: l.qtyKg,
      unit_price: l.unitPrice,
    })),
  });
}

/**
 * A bill's stored lines in the shape the basket edits.
 *
 * unit_price comes from the STORED row, not from items.price: the price at the moment of
 * recording is the bill's price, and re-reading the live one would silently reprice a
 * basket during an amendment.
 */
/** The bill's STORED total, exactly as SQL's `round(numeric, 2)` computed it. AmendBill
 *  shows this beside a client-recomputed new total; `runningTotal` (billing.ts) uses
 *  `Math.round(x*100)/100` on binary floats, which can differ from the stored value by a
 *  paisa (₹10.02 x 1.25 renders 12.52 but stores 12.53). The OLD total has an authoritative
 *  stored value to defer to; the NEW one is a live preview of an unsaved basket and has
 *  none, so it stays client-computed. */
export async function billTotal(billId: string) {
  return supabase.from("bills").select("total").eq("id", billId).single();
}

export async function billDraftLines(billId: string) {
  const res = await supabase
    .from("bill_items")
    .select("id, item_id, qty_kg, unit_price, line_total, items(name_en, name_hi, name_mr, unit)")
    .eq("bill_id", billId);
  if (res.error || !res.data) return { data: null, error: res.error };
  type Row = {
    item_id: string; qty_kg: number; unit_price: number;
    items: { name_en: string; name_hi: string; name_mr: string; unit: Unit } | null;
  };
  const data: Draft[] = (res.data as unknown as Row[]).map((r) => ({
    itemId: r.item_id,
    name: r.items?.name_en ?? "",
    unitPrice: Number(r.unit_price),
    qtyKg: Number(r.qty_kg),
    unit: r.items?.unit ?? "kg",
  }));
  return { data, error: null };
}

export type { Customer, Draft };
