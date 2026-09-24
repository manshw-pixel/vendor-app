import { describe, it, expect } from "vitest";
import { parseAmount, matchDues, totalOutstanding } from "../duesRules";

describe("parseAmount", () => {
  it("accepts a positive amount to the paisa", () => {
    expect(parseAmount(" 340.50 ")).toEqual({ ok: true, value: 340.5 });
  });
  it("refuses zero, negatives, too many decimals and non-numbers", () => {
    expect(parseAmount("0")).toEqual({ ok: false, reason: "zero" });
    expect(parseAmount("0.00")).toEqual({ ok: false, reason: "zero" });
    expect(parseAmount("-1")).toEqual({ ok: false, reason: "negative" });
    expect(parseAmount("1.005")).toEqual({ ok: false, reason: "tooPrecise" });
    expect(parseAmount("1e3")).toEqual({ ok: false, reason: "notANumber" });
    expect(parseAmount("")).toEqual({ ok: false, reason: "empty" });
  });
});

describe("matchDues", () => {
  const rows = [
    { name: "Asha", flat_no: "A-1", mobile: "+919811111111" },
    { name: "Ravi", flat_no: "B-7", mobile: "+919822222222" },
  ];
  it("matches name, flat or mobile, ignoring case", () => {
    expect(matchDues(rows, "asha").map((r) => r.name)).toEqual(["Asha"]);
    expect(matchDues(rows, "b-7").map((r) => r.name)).toEqual(["Ravi"]);
    expect(matchDues(rows, "98222").map((r) => r.name)).toEqual(["Ravi"]);
    expect(matchDues(rows, "  ").length).toBe(2);
  });
});

describe("totalOutstanding", () => {
  it("sums only what is owed, never an overpaid balance", () => {
    expect(totalOutstanding([{ balance: 200 }, { balance: 40.1 }, { balance: -60 }]))
      .toEqual({ amount: 240.1, count: 2 });
  });
});
