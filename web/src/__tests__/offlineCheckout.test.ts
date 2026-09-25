import { describe, it, expect } from "vitest";
import { checkoutLimits, amountToTake } from "../screens/bill/OfflineCheckout";
describe("offline checkout limits", () => {
  it("redeem is capped by points and by the whole-rupee total", () => {
    expect(checkoutLimits(99.5, { points: 500, due: 0 }, "cash").maxRedeem).toBe(99);
    expect(checkoutLimits(200, { points: 30, due: 0 }, "cash").maxRedeem).toBe(30);
  });
  it("collecting a due is capped by the cached due and impossible on credit", () => {
    expect(checkoutLimits(80, { points: 0, due: 120 }, "upi").maxCollect).toBe(120);
    expect(checkoutLimits(80, { points: 0, due: 120 }, "credit").maxCollect).toBe(0);
    expect(checkoutLimits(80, { points: 0, due: -5 }, "cash").maxCollect).toBe(0);
  });
  it("no cached balance allows neither", () => {
    expect(checkoutLimits(80, undefined, "cash")).toEqual({ maxRedeem: 0, maxCollect: 0 });
  });
  it("the amount to take is the bill less points plus the due, to the paisa", () => {
    expect(amountToTake(80, 10, 50)).toBe(120);
    expect(amountToTake(79.9, 10, 0.1)).toBe(70);
    expect(amountToTake(99.99, 0, 0)).toBe(99.99);
  });
});
