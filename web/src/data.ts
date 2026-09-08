import { supabase } from "./supabase";
import { lineTotal, type Draft } from "./billing";
import type { Customer } from "./customers";

export type PostgrestErrorLike = { message?: string; code?: string } | null;

export type Item = {
  id: string;
  name_en: string;
  name_hi: string;
  name_mr: string;
  price: number;
  stock_kg: number;
  is_active: boolean;
};

export type PendingBill = {
  id: string;
  token_no: number;
  total: number;
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
    .select("id, name_en, name_hi, name_mr, price, stock_kg, is_active")
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

export async function addLines(vendorId: string, billId: string, lines: readonly Draft[]) {
  if (lines.length === 0) return { error: null as PostgrestErrorLike };
  return supabase.from("bill_items").insert(
    lines.map((l) => ({
      bill_id: billId,
      vendor_id: vendorId,
      item_id: l.itemId,
      qty_kg: l.qtyKg,
      unit_price: l.unitPrice,
      line_total: lineTotal(l.unitPrice, l.qtyKg),
    })),
  );
}

/** Parameter names must match 0003_functions.sql exactly; PostgREST resolves the
 *  overload by argument name, and a mismatch reads as "function not found". */
export async function issueToken(billId: string) {
  return supabase.rpc("issue_token", { p_bill_id: billId });
}

export async function listPending() {
  return supabase
    .from("bills")
    .select("id, token_no, total, customers(name, flat_no)")
    .eq("status", "billed")
    .order("token_no", { ascending: false });
}

export async function completeBill(billId: string) {
  return supabase.rpc("complete_bill", { p_bill_id: billId });
}

export type { Customer, Draft };
