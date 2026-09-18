import { describe, it, expect } from "vitest";
import type { TFunction } from "i18next";
import { UNITS, isUnit, isWholeUnit, validateQty, qtyText, perUnit } from "../units";

// Narrow cast, test-only: a fake matching just the (key, options) shape we call.
const t = ((k: string, o?: object) => (o ? `${k}${JSON.stringify(o)}` : k)) as unknown as TFunction;

describe("units", () => {
  it("lists the four units and recognises them", () => {
    expect(UNITS).toEqual(["kg", "piece", "bunch", "dozen"]);
    expect(isUnit("dozen")).toBe(true);
    expect(isUnit("litre")).toBe(false);
    expect(isUnit(3)).toBe(false);
  });

  it("treats every unit but kg as whole", () => {
    expect(isWholeUnit("kg")).toBe(false);
    expect(isWholeUnit("piece")).toBe(true);
    expect(isWholeUnit("bunch")).toBe(true);
    expect(isWholeUnit("dozen")).toBe(true);
  });
});

describe("validateQty", () => {
  it.each([
    ["1.5", "kg", { ok: true, value: 1.5 }],
    ["1.5", "piece", { ok: false, reason: "notWhole" }],
    ["3", "piece", { ok: true, value: 3 }],
    [" 4 ", "dozen", { ok: true, value: 4 }],
    ["0", "bunch", { ok: false, reason: "notPositive" }],
    ["", "dozen", { ok: false, reason: "empty" }],
    ["2.0", "piece", { ok: false, reason: "notWhole" }],
    ["abc", "piece", { ok: false, reason: "notANumber" }],
    ["-1", "piece", { ok: false, reason: "notANumber" }],
    ["1.234", "kg", { ok: false, reason: "tooPrecise" }],
  ] as const)("%j as %s", (raw, unit, expected) => {
    expect(validateQty(raw, unit)).toEqual(expected);
  });
});

describe("qtyText and perUnit", () => {
  it("formats a quantity through unit.qty, coercing strings", () => {
    expect(qtyText("2.50", "kg", t)).toBe('unit.qty.kg{"n":2.5}');
    expect(qtyText(3, "piece", t)).toBe('unit.qty.piece{"n":3}');
  });

  it("names the per-unit price suffix", () => {
    expect(perUnit("bunch", t)).toBe("unit.per.bunch");
  });
});
