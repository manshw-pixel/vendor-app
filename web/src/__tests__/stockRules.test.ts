import { describe, it, expect } from "vitest";
import { validateMovement, signedKg, type MovementInput } from "../stockRules";

const base: MovementInput = { itemId: "i1", kind: "purchase", qtyKg: "5", unitCost: "22.50", note: "" };

describe("validateMovement", () => {
  it("accepts a purchase with kg and cost", () => {
    const r = validateMovement(base);
    expect(r).toEqual({ ok: true, value: { itemId: "i1", kind: "purchase", qtyKg: 5, unitCost: 22.5, note: "" } });
  });

  it("requires an item", () => {
    const r = validateMovement({ ...base, itemId: "" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.itemId).toBe("stock.needItem");
  });

  it.each(["", "0", "-1", "abc", "1.234"])("refuses kg %j", (qtyKg) => {
    const r = validateMovement({ ...base, qtyKg });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.qtyKg).toBe("stock.badKg");
  });

  it.each(["", "-1", "x", "1.001"])("refuses purchase cost %j", (unitCost) => {
    const r = validateMovement({ ...base, unitCost });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.unitCost).toBe("stock.badCost");
  });

  it("accepts a zero cost purchase, which is a gift from the supplier", () => {
    const r = validateMovement({ ...base, unitCost: "0" });
    expect(r.ok).toBe(true);
  });

  it("ignores any cost typed for a wastage and sends null", () => {
    const r = validateMovement({ ...base, kind: "wastage", unitCost: "garbage" });
    expect(r).toEqual({ ok: true, value: { itemId: "i1", kind: "wastage", qtyKg: 5, unitCost: null, note: "" } });
  });

  it("trims the note", () => {
    const r = validateMovement({ ...base, note: "  vashi  " });
    expect(r.ok && r.value.note).toBe("vashi");
  });
});

describe("signedKg", () => {
  it("prefixes a purchase with a plus", () => {
    expect(signedKg("purchase", 5)).toBe("+5 kg");
  });
  it("prefixes a wastage with a minus sign", () => {
    expect(signedKg("wastage", "2.50")).toBe("−2.5 kg");
  });
});
