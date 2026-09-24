import { supabase } from "./supabase";
import type { RepayMode } from "./payments";

/**
 * Every read and write behind the Dues screens (0022). A sibling to dayClose.ts: a small
 * surface the screens stub in tests. Nothing here filters by vendor -- RLS scopes every
 * read, and the writers check the vendor themselves.
 *
 * Everything returned is coerced: PostgREST sends numeric as a string.
 */

type DbError = { message?: string; code?: string } | null;
const num = (v: unknown): number => Number(v ?? 0);
const ymd = (v: unknown): string => String(v).slice(0, 10);
const blankToNull = (s: string): string | null => (s.trim() === "" ? null : s.trim());

export type DuesRow = {
  customer_id: string; name: string; flat_no: string; mobile: string;
  balance: number; oldest_unpaid: string | null;
};

export type DuesEntry = {
  kind: "credit_bill" | "opening" | "repayment";
  id: string; at: string; business_date: string; amount: number;
  mode: RepayMode | null; note: string | null; by_name: string | null; token_no: number | null;
  reversed_at: string | null; reversed_by_name: string | null; reverse_reason: string | null;
  day_closed: boolean;
};

export type UnassignedBill = { bill_id: string; token_no: number | null; completed_at: string; amount: number };

export async function loadDuesList(): Promise<{ data: DuesRow[] | null; error: DbError }> {
  const { data, error } = await supabase.rpc("dues_list");
  if (error) return { data: null, error };
  return {
    data: ((data ?? []) as Record<string, unknown>[]).map((r) => ({
      customer_id: String(r.customer_id), name: String(r.name), flat_no: String(r.flat_no),
      mobile: String(r.mobile), balance: num(r.balance),
      oldest_unpaid: r.oldest_unpaid == null ? null : ymd(r.oldest_unpaid),
    })),
    error: null,
  };
}

export type DuesCustomer = { name: string; flat_no: string; mobile: string };

/**
 * The balance comes from customer_due, the one server definition, never summed here.
 * The customer row is read beside it so the page can say whose dues these are; RLS
 * scopes it, and a row this user cannot see comes back as `customer: null`.
 */
export async function loadCustomerDues(
  customerId: string,
): Promise<{
  data: { balance: number; entries: DuesEntry[]; customer: DuesCustomer | null } | null;
  error: DbError;
}> {
  const [bal, tl, cust] = await Promise.all([
    supabase.rpc("customer_due", { p_customer: customerId }),
    supabase.rpc("customer_dues", { p_customer: customerId }),
    supabase.from("customers").select("name, flat_no, mobile").eq("id", customerId).maybeSingle(),
  ]);
  const error = bal.error ?? tl.error ?? cust.error;
  if (error) return { data: null, error };
  const c = cust.data as Record<string, unknown> | null;
  return {
    data: {
      customer: c ? { name: String(c.name), flat_no: String(c.flat_no), mobile: String(c.mobile) } : null,
      balance: num(bal.data),
      entries: ((tl.data ?? []) as Record<string, unknown>[]).map((r) => ({
        kind: r.kind as DuesEntry["kind"], id: String(r.id), at: String(r.at),
        business_date: ymd(r.business_date), amount: num(r.amount),
        mode: (r.mode as RepayMode | null) ?? null, note: (r.note as string | null) ?? null,
        by_name: (r.by_name as string | null) ?? null,
        token_no: r.token_no == null ? null : Number(r.token_no),
        reversed_at: (r.reversed_at as string | null) ?? null,
        reversed_by_name: (r.reversed_by_name as string | null) ?? null,
        reverse_reason: (r.reverse_reason as string | null) ?? null,
        day_closed: r.day_closed === true,
      })),
    },
    error: null,
  };
}

/** Just the balance, for Pending's "Already owes" line. */
export async function loadCustomerDue(customerId: string): Promise<{ data: number | null; error: DbError }> {
  const { data, error } = await supabase.rpc("customer_due", { p_customer: customerId });
  if (error) return { data: null, error };
  return { data: num(data), error: null };
}

/** Parameter names must match 0022_dues.sql exactly. */
export async function recordRepayment(customerId: string, amount: number, mode: RepayMode, note: string) {
  return supabase.rpc("record_repayment", {
    p_customer: customerId, p_amount: amount, p_mode: mode, p_note: blankToNull(note),
  });
}

export async function recordOpeningBalance(customerId: string, amount: number, note: string) {
  return supabase.rpc("record_opening_balance", { p_customer: customerId, p_amount: amount, p_note: note.trim() });
}

export async function reverseDuesEntry(entryId: string, reason: string) {
  return supabase.rpc("reverse_dues_entry", { p_entry: entryId, p_reason: reason.trim() });
}

export async function loadUnassignedCredit(): Promise<{ data: UnassignedBill[] | null; error: DbError }> {
  const { data, error } = await supabase.rpc("unassigned_credit");
  if (error) return { data: null, error };
  return {
    data: ((data ?? []) as Record<string, unknown>[]).map((r) => ({
      bill_id: String(r.bill_id), token_no: r.token_no == null ? null : Number(r.token_no),
      completed_at: String(r.completed_at), amount: num(r.amount),
    })),
    error: null,
  };
}

export async function assignCreditCustomer(billId: string, customerId: string) {
  return supabase.rpc("assign_credit_customer", { p_bill: billId, p_customer: customerId });
}
