import { describe, it, expect } from "vitest";
import { normaliseItemName } from "../requests";

describe("normaliseItemName", () => {
  it("trims surrounding whitespace", () => {
    expect(normaliseItemName("  dragon fruit  ")).toBe("dragon fruit");
  });

  it("collapses runs of internal whitespace", () => {
    // Two words typed with a stray double space must not become a second row in
    // v_stock_request_counts, which groups on the exact lowered string.
    expect(normaliseItemName("dragon   fruit")).toBe("dragon fruit");
  });

  it("treats tabs and newlines as whitespace", () => {
    expect(normaliseItemName("dragon\tfruit\n")).toBe("dragon fruit");
  });

  it("returns an empty string for a whitespace-only entry", () => {
    // The screen uses this to disable the Log button, so the blank never reaches the
    // check constraint added in 0013.
    expect(normaliseItemName("   ")).toBe("");
  });

  it("preserves case as typed", () => {
    // Case folding is the database's job (lower() in stock_requests_between). Doing it
    // here too would show staff a lowercased version of what they typed.
    expect(normaliseItemName("Dragon Fruit")).toBe("Dragon Fruit");
  });
});
