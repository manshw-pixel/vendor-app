import { describe, it, expect } from "vitest";
import { normaliseSoldBy } from "../soldBy";

describe("normaliseSoldBy", () => {
  it.each([
    ["12 pc", "dozen"], ["12pcs", "dozen"], ["Dozen", "dozen"], ["1 dz", "dozen"], ["दर्जन", "dozen"], ["डझन", "dozen"],
    ["1 box", "piece"], ["packet", "piece"], ["1 pkt", "piece"], ["1 pc", "piece"], ["piece", "piece"], ["नग", "piece"],
    ["bunch", "bunch"], ["1 जुडी", "bunch"], ["गड्डी", "bunch"],
    ["1 kg", "kg"], ["1kg", "kg"], ["kilo", "kg"], ["", "kg"], ["per bag", "kg"],
  ])("%s → %s, price unchanged", (soldBy, unit) => {
    const r = normaliseSoldBy(soldBy, 20);
    expect(r.unit).toBe(unit);
    expect(r.price).toBe(20);
    expect(r.grams).toBeNull();
  });

  it.each([
    ["250 g", 20, 80], ["250gm", 20, 80], ["500 gms", 30, 60], ["100 grams", 12, 120], ["250 ग्राम", 20, 80], ["333 g", 10, 30.03],
  ])("%s at ₹%d → ₹%d per kg", (soldBy, price, perKg) => {
    const r = normaliseSoldBy(soldBy, price);
    expect(r.unit).toBe("kg");
    expect(r.price).toBe(perKg);
    expect(r.grams).not.toBeNull();
  });

  it("does not read the g in kg as grams", () => {
    expect(normaliseSoldBy("2 kg", 50)).toEqual({ unit: "kg", price: 50, grams: null, unclear: true });
  });

  it("does not treat 12 inside a larger number as a dozen", () => {
    expect(normaliseSoldBy("120 pc", 5).unit).toBe("piece");
  });

  it.each([["2 kg", "kg"], ["6 pc", "piece"], ["3 box", "piece"], ["½ kg", "kg"], ["1/2 kg", "kg"], ["0.5 kg", "kg"], ["5 kg", "kg"], ["2 dozen", "dozen"], ["3 dz", "dozen"], ["2 bunch", "bunch"], ["½ dozen", "dozen"]])(
    "%s is flagged unclear (a quantity other than one), unit best-guess %s", (soldBy, unit) => {
      const r = normaliseSoldBy(soldBy, 30);
      expect(r.unclear).toBe(true);
      expect(r.unit).toBe(unit);
    });

  it.each(["1 kg", "1 pc", "12 pc", "12 nos", "250 g", "", "1 box", "per bag", "1 dozen", "dozen", "bunch", "1 bunch"])("%s is not unclear", (soldBy) => {
    expect(normaliseSoldBy(soldBy, 30).unclear).toBe(false);
  });
});
