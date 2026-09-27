import { describe, it, expect } from "vitest";
import { filterItems } from "../itemSearch";

const items = [
  { id: "1", name_en: "Onion", name_hi: "प्याज", name_mr: "कांदा" },
  { id: "2", name_en: "Potato", name_hi: "आलू", name_mr: "बटाटा" },
  { id: "3", name_en: "Green Chilli", name_hi: "", name_mr: "" },
];

describe("filterItems", () => {
  it("returns everything for an empty or blank query", () => {
    expect(filterItems(items, "")).toHaveLength(3);
    expect(filterItems(items, "   ")).toHaveLength(3);
  });
  it("matches English case-insensitively, anywhere in the name", () => {
    expect(filterItems(items, "ONI").map((i) => i.id)).toEqual(["1"]);
    expect(filterItems(items, "chil").map((i) => i.id)).toEqual(["3"]);
  });
  it("matches Hindi and Marathi names regardless of UI language", () => {
    expect(filterItems(items, "आलू").map((i) => i.id)).toEqual(["2"]);
    expect(filterItems(items, "कांदा").map((i) => i.id)).toEqual(["1"]);
  });
  it("returns nothing when nothing matches", () => {
    expect(filterItems(items, "mango")).toEqual([]);
  });
});
