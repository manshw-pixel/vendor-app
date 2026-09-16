import { supabase } from "./supabase";

export type StockRequest = {
  id: string;
  item_name: string;
  status: "open" | "handled";
  created_at: string;
};

/**
 * Trim and collapse internal whitespace, preserving case.
 *
 * stock_requests_between() groups on lower(item_name), so "dragon fruit" and
 * "dragon  fruit" would otherwise count as two different fruits. Case is folded in SQL
 * rather than here, so the worklist shows staff exactly what they typed.
 *
 * Deliberately NOT doing fuzzy matching: "dragonfruit" and "dragon fruit" will still
 * count separately. Synonym tables and trigram matching are speculative until real
 * counter entry proves messy; the item_name edit path in 0013 is the cheap mitigation.
 */
export function normaliseItemName(raw: string): string {
  return raw.trim().replace(/\s+/g, " ");
}

/**
 * Every PostgREST call for stock requests lives here, for the same two reasons as
 * data.ts: vendor_id is NOT NULL with no default and forgetting it is a bug that has
 * shipped before, and the screens get a small surface to stub in tests.
 *
 * None of these filters by vendor on the read path. RLS scopes it; a client filter
 * would be a weaker second copy of stock_requests_read.
 */
export async function logRequest(vendorId: string, itemName: string) {
  return supabase
    .from("stock_requests")
    .insert({ vendor_id: vendorId, item_name: normaliseItemName(itemName) })
    .select("id, item_name, status, created_at")
    .single();
}

export async function listRequests() {
  return supabase
    .from("stock_requests")
    .select("id, item_name, status, created_at")
    .order("created_at", { ascending: false })
    .limit(200);
}

export async function markHandled(id: string) {
  return supabase
    .from("stock_requests")
    .update({ status: "handled" })
    .eq("id", id)
    .select("id, status")
    .single();
}
