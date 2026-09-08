import { describe, it, expect } from "vitest";
import { lineTotal, runningTotal, validateWeight } from "../billing";

describe("lineTotal", () => {
  it("multiplies price by weight", () => {
    expect(lineTotal(40, 2)).toBe(80);
  });

  it("rounds to paise, because the column is numeric(10,2)", () => {
    // bill_items.line_total is numeric(10,2). Sending 53.235 would be rounded by
    // Postgres anyway; rounding here keeps the displayed total equal to the stored one.
    expect(lineTotal(40.5, 1.315)).toBe(53.26);
  });
});

describe("runningTotal", () => {
  const line = (unitPrice: number, qtyKg: number) =>
    ({ itemId: "i", name: "n", unitPrice, qtyKg });

  it("is zero for an empty basket", () => {
    expect(runningTotal([])).toBe(0);
  });

  it("sums the line totals, not the raw products", () => {
    // Sum of rounded lines (53.26 + 4.19), then rounded to paise to avoid float artifacts
    // on the screen. Without the final rounding, 53.26 + 4.19 would display as
    // ₹57.449999999999996 on a recorder's phone, not ₹57.45.
    expect(runningTotal([line(40.5, 1.315), line(12.5, 0.335)])).toBe(57.45);
  });
});

describe("validateWeight", () => {
  it("accepts a decimal weight a scale would produce", () => {
    expect(validateWeight("1.35")).toEqual({ ok: true, value: 1.35 });
  });

  it("rejects empty input", () => {
    expect(validateWeight("")).toEqual({ ok: false, reason: "empty" });
    expect(validateWeight("   ")).toEqual({ ok: false, reason: "empty" });
  });

  it("rejects non-numbers", () => {
    expect(validateWeight("abc")).toEqual({ ok: false, reason: "notANumber" });
  });

  it("rejects zero and negatives", () => {
    // bill_items has check (qty_kg > 0). Catching it here gives a real message instead
    // of a constraint violation.
    expect(validateWeight("0")).toEqual({ ok: false, reason: "notPositive" });
    expect(validateWeight("-1")).toEqual({ ok: false, reason: "notPositive" });
  });

  it("rejects more precision than the column stores", () => {
    // qty_kg is numeric(10,2). Accepting 1.234 would silently store 1.23 and bill for
    // a weight nobody agreed to.
    expect(validateWeight("1.234")).toEqual({ ok: false, reason: "tooPrecise" });
  });
});
