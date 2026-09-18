import { describe, it, expect } from "vitest";
import type { TFunction } from "i18next";
import { validateMovement, signedQty, type MovementInput } from "../stockRules";

// Real translations, not the narrow fake used in units.test.ts: signedQty's output is
// asserted verbatim ("+3 pcs"), so the fake's `key{json}` shape would not do.
import i18n from "../i18n";
const t = i18n.getFixedT("en") as TFunction;

const base: MovementInput = { itemId: "i1", kind: "purchase", qtyKg: "5", unitCost: "22.50", note: "" };

describe("validateMovement", () => {
  it("accepts a purchase with kg and cost", () => {
    const r = validateMovement(base, "kg");
    expect(r).toEqual({ ok: true, value: { itemId: "i1", kind: "purchase", qtyKg: 5, unitCost: 22.5, note: "" } });
  });

  it("requires an item", () => {
    const r = validateMovement({ ...base, itemId: "" }, "kg");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.itemId).toBe("stock.needItem");
  });

  it.each(["", "0", "-1", "abc", "1.234"])("refuses kg %j", (qtyKg) => {
    const r = validateMovement({ ...base, qtyKg }, "kg");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.qtyKg).toBe("stock.badKg");
  });

  it.each(["", "-1", "x", "1.001"])("refuses purchase cost %j", (unitCost) => {
    const r = validateMovement({ ...base, unitCost }, "kg");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.unitCost).toBe("stock.badCost");
  });

  it("accepts a zero cost purchase, which is a gift from the supplier", () => {
    const r = validateMovement({ ...base, unitCost: "0" }, "kg");
    expect(r.ok).toBe(true);
  });

  it("ignores any cost typed for a wastage and sends null", () => {
    const r = validateMovement({ ...base, kind: "wastage", unitCost: "garbage" }, "kg");
    expect(r).toEqual({ ok: true, value: { itemId: "i1", kind: "wastage", qtyKg: 5, unitCost: null, note: "" } });
  });

  it("trims the note", () => {
    const r = validateMovement({ ...base, note: "  vashi  " }, "kg");
    expect(r.ok && r.value.note).toBe("vashi");
  });
});

describe("signedQty", () => {
  it("prefixes a purchase with a plus", () => {
    expect(signedQty("purchase", 5, "kg", t)).toBe("+5 kg");
  });
  it("prefixes a wastage with a minus sign", () => {
    expect(signedQty("wastage", "2.50", "kg", t)).toBe("−2.5 kg");
  });
  it("names the item's own unit, not kg", () => {
    expect(signedQty("purchase", 3, "piece", t)).toBe("+3 pcs");
  });
});

describe("validateMovement for a whole unit", () => {
  it("refuses a fractional quantity", () => {
    const r = validateMovement({ ...base, qtyKg: "2.5" }, "piece");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.qtyKg).toBe("stock.badWhole");
  });

  it("accepts a whole quantity", () => {
    expect(validateMovement({ ...base, qtyKg: "3" }, "piece").ok).toBe(true);
  });
});
