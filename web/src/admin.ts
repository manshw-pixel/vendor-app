import { supabase } from "./supabase";
import type { ItemValue, SettingsField } from "./adminRules";
import type { Role } from "./config";

/**
 * Every PostgREST call the admin screens make.
 *
 * Separate from data.ts, which is the billing flow's file, for the reason data.ts gives
 * for existing at all: a small surface the screens can stub in tests, kept small enough
 * to hold in one head.
 *
 * As in data.ts, none of these functions filters by vendor. RLS scopes every query to
 * the caller's tenant, and a client-side filter would be a weaker second copy of the
 * policy. Nor do the update functions re-send vendor_id: the row is already scoped, and
 * sending it would suggest a tenant move is something the client can attempt.
 */

export type AdminItem = {
  id: string;
  name_en: string;
  name_hi: string;
  name_mr: string;
  price: number;
  stock_kg: number;
  is_active: boolean;
};

export type StaffRow = { id: string; name: string; role: Role };

export type VendorConfig = Record<SettingsField, number>;

const ITEM_COLS = "id, name_en, name_hi, name_mr, price, stock_kg, is_active";

/** Unlike listItems() in data.ts, this does NOT filter is_active. The bill grid hides
 *  inactive items; the admin list must show them or they can never be brought back. */
export async function listAllItems() {
  return supabase.from("items").select(ITEM_COLS).order("name_en");
}

export async function createItem(vendorId: string, value: ItemValue) {
  return supabase.from("items").insert({ vendor_id: vendorId, ...value }).select("id").single();
}

export async function updateItem(id: string, value: ItemValue) {
  return supabase.from("items").update({ ...value }).eq("id", id);
}

/** Items are hidden, never deleted: bill_items.item_id references them, so a delete
 *  would either fail the FK or destroy the history the dashboards read. */
export async function setItemActive(id: string, isActive: boolean) {
  return supabase.from("items").update({ is_active: isActive }).eq("id", id);
}

export async function updateCustomer(
  id: string,
  input: { name: string; flat_no: string; mobile: string },
) {
  return supabase.from("customers").update({ ...input }).eq("id", id);
}

/** Parameter name must match 0003_functions.sql exactly; PostgREST resolves the overload
 *  by argument name, and a mismatch reads as "function not found". The function already
 *  excludes expired rows, so this is the balance, not a raw sum. */
export async function customerPoints(customerId: string) {
  return supabase.rpc("customer_points_balance", { p_customer_id: customerId });
}

export async function listStaff() {
  return supabase.from("app_users").select("id, name, role").order("name");
}

export async function updateStaff(id: string, patch: { name?: string; role?: Role }) {
  return supabase.from("app_users").update(patch).eq("id", id);
}

const CONFIG_COLS =
  "points_threshold_1, points_reward_1, points_threshold_2, points_reward_2, redeem_days";

export async function loadVendorConfig(vendorId: string) {
  return supabase.from("vendors").select(CONFIG_COLS).eq("id", vendorId).maybeSingle();
}

/** vendors_admin_update permits the whole row to an admin; this sends only the five
 *  loyalty columns so a future column cannot be clobbered by this screen by accident. */
export async function updateVendorConfig(vendorId: string, value: VendorConfig) {
  return supabase
    .from("vendors")
    .update({
      points_threshold_1: value.points_threshold_1,
      points_reward_1: value.points_reward_1,
      points_threshold_2: value.points_threshold_2,
      points_reward_2: value.points_reward_2,
      redeem_days: value.redeem_days,
    })
    .eq("id", vendorId);
}

export type ClearedCounts = { bills: number; customers: number; points_rows: number };

/**
 * Wipes this vendor's transactional history. There is no undo.
 *
 * An RPC rather than a series of deletes because 0002_rls.sql grants no write policy at
 * all on points_ledger, vendor_counters or outbound_messages -- a client cannot perform
 * these deletes under its own rights however it is authorised. clear_vendor_data() takes
 * no arguments: it scopes everything to current_vendor_id(), so there is no vendor id to
 * pass and none to get wrong.
 *
 * Returns a single row of counts; PostgREST renders a returns-table function as an array.
 */
export async function clearVendorData() {
  return supabase.rpc("clear_vendor_data");
}
