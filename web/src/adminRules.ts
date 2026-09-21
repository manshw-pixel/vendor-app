/**
 * Pure rules for the admin screens. No supabase import, no React -- these are the
 * decisions §11b makes, and they are testable without mocking anything.
 *
 * These validations are convenience, not enforcement. The column CHECKs in
 * 0001_schema.sql (price >= 0, stock_kg >= 0) and the policies in 0002_rls.sql are what
 * actually hold. Rejecting here only buys a clearer message than a 400 from PostgREST.
 */

import { isWholeUnit, type Unit } from "./units";
import { ROLES, type Role } from "./config";
import { MIN_PASSWORD_LENGTH } from "../../supabase/functions/admin-create-user/guards";

export type ItemInput = {
  name_en: string;
  name_hi: string;
  name_mr: string;
  price: string;
  cost: string;
  stock_kg: string;
  unit: Unit;
  low_stock_at: string;
};
export type ItemField = keyof ItemInput;

export type ItemValue = {
  name_en: string;
  name_hi: string;
  name_mr: string;
  price: number;
  cost: number | null;
  stock_kg: number;
  unit: Unit;
  low_stock_at: number;
};

/** Maximum value for numeric(10,2) columns in 0001_schema.sql. */
const MAX_NUMERIC = 99999999.99;

/**
 * Below the item's own low_stock_at, a row is coloured. EXCLUSIVE, the same comparison
 * v_low_stock makes (`stock_kg < low_stock_at`), so the list, the badge and the bill grid
 * agree on what "low" means.
 */
export function stockLevel(kg: number, lowAt: number): "out" | "low" | "ok" {
  if (kg <= 0) return "out";
  return kg < lowAt ? "low" : "ok";
}

/** A non-negative decimal, or null. Rejects "", "x", "1e3" and "-1". */
function nonNegative(raw: string): number | null {
  const s = raw.trim();
  if (s === "" || !/^\d+(\.\d+)?$/.test(s)) return null;
  const n = Number(s);
  if (!Number.isFinite(n)) return null;
  if (n > MAX_NUMERIC) return null;
  return n;
}

export function validateItem(
  input: ItemInput,
  mode: "create" | "edit",
): { ok: true; value: ItemValue } | { ok: false; errors: Partial<Record<ItemField, string>> } {
  const errors: Partial<Record<ItemField, string>> = {};

  // All three names, per §11b. The columns default to '' so the database will not stop
  // a blank; this is the only place it is stopped.
  for (const f of ["name_en", "name_hi", "name_mr"] as const) {
    if (input[f].trim() === "") errors[f] = "items.required";
  }

  const price = nonNegative(input.price);
  if (price === null) errors.price = "items.badPrice";

  const stock = nonNegative(input.stock_kg);
  if (stock === null) errors.stock_kg = "items.badStock";
  else if (isWholeUnit(input.unit) && !Number.isInteger(stock)) errors.stock_kg = "items.badWholeStock";

  const lowAt = nonNegative(input.low_stock_at);
  if (lowAt === null) errors.low_stock_at = "items.badLowAt";

  // Required on create so an item never starts life uncosted -- every sale of an uncosted
  // item lands in top_items_between's uncosted_lines with no margin at all. Blank is
  // allowed on EDIT and means "leave last_cost alone", so the thousands of items created
  // before 0020 do not each have to be costed before any other field can be fixed.
  let cost: number | null = null;
  const costRaw = input.cost.trim();
  if (costRaw === "") {
    if (mode === "create") errors.cost = "items.costRequired";
  } else {
    cost = nonNegative(input.cost);
    if (cost === null) errors.cost = "items.badCost";
  }

  if (Object.keys(errors).length > 0) return { ok: false, errors };
  return {
    ok: true,
    value: {
      name_en: input.name_en.trim(),
      name_hi: input.name_hi.trim(),
      name_mr: input.name_mr.trim(),
      price: price as number,
      cost,
      stock_kg: stock as number,
      unit: input.unit,
      low_stock_at: lowAt as number,
    },
  };
}

export type SettingsInput = {
  points_threshold_1: string;
  points_reward_1: string;
  points_threshold_2: string;
  points_reward_2: string;
  redeem_days: string;
};
export type SettingsField = keyof SettingsInput;

/** Which of the five are integer columns in 0001_schema.sql. The thresholds are
 *  numeric(10,2) and may carry paise; the rest would be truncated silently. */
const WHOLE: readonly SettingsField[] = ["points_reward_1", "points_reward_2", "redeem_days"];

export function validateSettings(
  input: SettingsInput,
):
  | { ok: true; value: Record<SettingsField, number> }
  | { ok: false; errors: Partial<Record<SettingsField, string>> } {
  const errors: Partial<Record<SettingsField, string>> = {};
  const value = {} as Record<SettingsField, number>;

  for (const f of Object.keys(input) as SettingsField[]) {
    const s = input[f].trim();
    if (s === "") { errors[f] = "settings.required"; continue; }
    const n = nonNegative(s);
    if (n === null) { errors[f] = "settings.badNumber"; continue; }
    if (n <= 0) { errors[f] = "settings.notPositive"; continue; }
    if (WHOLE.includes(f) && !Number.isInteger(n)) { errors[f] = "settings.notWhole"; continue; }
    value[f] = n;
  }

  // Only meaningful once both parsed. complete_bill() awards reward_2 above threshold_2;
  // an inverted pair makes the first tier unreachable.
  if (
    errors.points_threshold_1 === undefined &&
    errors.points_threshold_2 === undefined &&
    value.points_threshold_2 <= value.points_threshold_1
  ) {
    errors.points_threshold_2 = "settings.outOfOrder";
  }

  if (Object.keys(errors).length > 0) return { ok: false, errors };
  return { ok: true, value };
}

/**
 * Whether an admin may change this staff row.
 *
 * False for themselves. Demoting or removing yourself is the single action that locks a
 * vendor out of its own tenant: users_admin_write requires current_user_role() = 'admin',
 * so once the last admin is gone nobody can undo it and the repair is hand-written SQL
 * against production.
 */
export function canEditStaff(selfUserId: string, targetUserId: string): boolean {
  return selfUserId !== targetUserId;
}

export type NewStaffInput = { email: string; password: string; name: string; role: string };
export type NewStaffField = keyof NewStaffInput;
export type NewStaffValue = { email: string; password: string; name: string; role: Role };

/** Same shape as the Edge Function's own check, and deliberately as loose: GoTrue decides
 *  what it accepts, and rejecting an address it would have taken is worse than a round
 *  trip. */
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * A new staff account, as the admin fills it in.
 *
 * This duplicates the Edge Function's guards on purpose: the round trip creates a real
 * auth account, so an obvious slip should be named against its field before it is made.
 * MIN_PASSWORD_LENGTH is IMPORTED rather than restated, because two copies of that number
 * drift and the drift appears as the server refusing what the form accepted.
 */
export function validateNewStaff(
  input: NewStaffInput,
): { ok: true; value: NewStaffValue } | { ok: false; errors: Partial<Record<NewStaffField, string>> } {
  const errors: Partial<Record<NewStaffField, string>> = {};

  const email = input.email.trim().toLowerCase();
  if (!EMAIL.test(email)) errors.email = "staff.badEmail";
  if (input.name.trim() === "") errors.name = "staff.required";
  if (!(ROLES as readonly string[]).includes(input.role)) errors.role = "staff.badRole";
  // Not trimmed: trimming silently changes the credential the admin read out loud.
  if (input.password.length < MIN_PASSWORD_LENGTH) errors.password = "staff.badPassword";

  if (Object.keys(errors).length > 0) return { ok: false, errors };
  return {
    ok: true,
    value: { email, password: input.password, name: input.name.trim(), role: input.role as Role },
  };
}
