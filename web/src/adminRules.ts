/**
 * Pure rules for the admin screens. No supabase import, no React -- these are the
 * decisions §11b makes, and they are testable without mocking anything.
 *
 * These validations are convenience, not enforcement. The column CHECKs in
 * 0001_schema.sql (price >= 0, stock_kg >= 0) and the policies in 0002_rls.sql are what
 * actually hold. Rejecting here only buys a clearer message than a 400 from PostgREST.
 */

export type ItemInput = {
  name_en: string;
  name_hi: string;
  name_mr: string;
  price: string;
  stock_kg: string;
};
export type ItemField = keyof ItemInput;

export type ItemValue = {
  name_en: string;
  name_hi: string;
  name_mr: string;
  price: number;
  stock_kg: number;
};

/** At or below this many kg, a row is coloured. Matches the bill grid's threshold. */
export const LOW_STOCK_KG = 2;

export function stockLevel(kg: number): "out" | "low" | "ok" {
  if (kg <= 0) return "out";
  return kg <= LOW_STOCK_KG ? "low" : "ok";
}

/** A non-negative decimal, or null. Rejects "", "x", "1e3" and "-1". */
function nonNegative(raw: string): number | null {
  const s = raw.trim();
  if (s === "" || !/^\d+(\.\d+)?$/.test(s)) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

export function validateItem(
  input: ItemInput,
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

  if (Object.keys(errors).length > 0) return { ok: false, errors };
  return {
    ok: true,
    value: {
      name_en: input.name_en.trim(),
      name_hi: input.name_hi.trim(),
      name_mr: input.name_mr.trim(),
      price: price as number,
      stock_kg: stock as number,
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
