import { supabase } from "./supabase";
import type { Range } from "./dateRange";
import { toBounds } from "./dateRange";
import type { Unit } from "./units";
import type { MovementKind } from "./stockRules";

/** One row of stock_movements_between (0016). Numeric columns arrive as strings from
 *  PostgREST; Number() them before arithmetic or display. */
export type Movement = {
  id: string;
  item_id: string;
  name_en: string;
  name_hi: string;
  name_mr: string;
  unit: Unit;
  kind: MovementKind;
  qty_kg: string | number;
  unit_cost: string | number | null;
  note: string;
  created_by_name: string | null;
  created_at: string;
};

/**
 * Every PostgREST call for stock movements. No vendor_id is sent: log_stock_movement
 * reads the vendor off the item and refuses one that is not the caller's, and the read
 * is scoped by RLS.
 *
 * Parameter names must match 0016_stock_movements.sql exactly; PostgREST resolves the
 * function by argument name and a mismatch reads as "function not found".
 */
export async function logMovement(v: {
  itemId: string; kind: MovementKind; qtyKg: number; unitCost: number | null; note: string;
}) {
  const args: Record<string, unknown> = {
    p_item_id: v.itemId, p_kind: v.kind, p_qty_kg: v.qtyKg, p_note: v.note,
  };
  // Omitted rather than sent as null for a wastage: the SQL default is null, and not
  // sending it keeps the call identical to what the function documents.
  if (v.unitCost !== null) args.p_unit_cost = v.unitCost;
  return supabase.rpc("log_stock_movement", args);
}

export async function movementsBetween(range: Range) {
  const { fromTs, toTs } = toBounds(range);
  return supabase.rpc("stock_movements_between", { p_from: fromTs, p_to: toTs });
}
