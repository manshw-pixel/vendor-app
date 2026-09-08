import { describe, it, expect } from "vitest";
import { rupees } from "../money";

describe("rupees", () => {
  it("gives a whole number two decimal places", () => {
    expect(rupees(40)).toBe("₹40.00");
  });

  it("gives a one-decimal amount its second decimal place", () => {
    expect(rupees(57.5)).toBe("₹57.50");
  });

  it("groups digits the Indian way above a lakh", () => {
    expect(rupees(1234567.89)).toBe("₹12,34,567.89");
  });

  it("renders zero as ₹0.00", () => {
    expect(rupees(0)).toBe("₹0.00");
  });
});
