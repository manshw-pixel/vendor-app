import { describe, it, expect } from "vitest";
import en from "../i18n/en.json";
import hi from "../i18n/hi.json";
import mr from "../i18n/mr.json";

const flatten = (o: Record<string, unknown>, p = ""): string[] =>
  Object.entries(o).flatMap(([k, v]) =>
    v && typeof v === "object" ? flatten(v as Record<string, unknown>, `${p}${k}.`) : [`${p}${k}`],
  );

describe("billing translations", () => {
  it("adds the keys the billing screens need", () => {
    for (const key of [
      "bill.chooseCustomer", "bill.searchCustomer", "bill.newCustomer", "bill.name",
      "bill.flatNo", "bill.mobile", "bill.save", "bill.customerExists", "bill.required",
      "bill.addItem", "bill.weightKg", "bill.add", "bill.basket", "bill.total",
      "bill.empty", "bill.done", "bill.confirmTitle", "bill.confirmBody", "bill.cancel",
      "bill.tokenTitle", "bill.startNew", "bill.remove", "bill.stock", "bill.outOfStock",
      "bill.badWeight.empty", "bill.badWeight.notANumber",
      "bill.badWeight.notPositive", "bill.badWeight.tooPrecise",
      "pending.title", "pending.empty", "pending.token", "pending.complete",
      "pending.confirmBody", "pending.completed", "pending.pointsAwarded",
    ]) {
      expect(flatten(en), `missing en: ${key}`).toContain(key);
    }
  });

  it("keeps every locale's key structure identical", () => {
    // A key present in en but missing from mr silently falls back to English for a
    // Marathi user -- which looks like a translation nobody wrote, not a bug.
    const a = flatten(en).sort();
    expect(flatten(hi).sort()).toEqual(a);
    expect(flatten(mr).sort()).toEqual(a);
  });
});
