/**
 * Validation for the /stock intake form. Pure, so it is tested without a screen.
 *
 * The database checks all of this again inside log_stock_movement (0016). These rules
 * exist to say what is wrong in the staff member's language before a round trip, not to
 * protect anything.
 */
export type MovementKind = "purchase" | "wastage";
export type MovementInput = { itemId: string; kind: MovementKind; qtyKg: string; unitCost: string; note: string };
export type MovementField = "itemId" | "qtyKg" | "unitCost";
export type MovementValue = { itemId: string; kind: MovementKind; qtyKg: number; unitCost: number | null; note: string };

// At most two decimals: the columns are numeric(10,2), and a third decimal would be
// rounded silently by the database into a number the staff member never typed.
const TWO_DP = /^\d+(\.\d{1,2})?$/;

export function validateMovement(
  input: MovementInput,
): { ok: true; value: MovementValue } | { ok: false; errors: Partial<Record<MovementField, string>> } {
  const errors: Partial<Record<MovementField, string>> = {};
  if (input.itemId === "") errors.itemId = "stock.needItem";

  const qtyRaw = input.qtyKg.trim();
  const qty = Number(qtyRaw);
  if (!TWO_DP.test(qtyRaw) || !(qty > 0)) errors.qtyKg = "stock.badKg";

  let cost: number | null = null;
  if (input.kind === "purchase") {
    const costRaw = input.unitCost.trim();
    cost = Number(costRaw);
    if (!TWO_DP.test(costRaw)) errors.unitCost = "stock.badCost";
  }

  if (Object.keys(errors).length > 0) return { ok: false, errors };
  return { ok: true, value: { itemId: input.itemId, kind: input.kind, qtyKg: qty, unitCost: cost, note: input.note.trim() } };
}

/** "+5 kg" for a purchase, "−2.5 kg" for a wastage. The minus is U+2212, which lines up
 *  with the plus in a list; a hyphen sits visibly lower. */
export function signedKg(kind: MovementKind, qty: number | string): string {
  return `${kind === "purchase" ? "+" : "−"}${Number(qty)} kg`;
}
