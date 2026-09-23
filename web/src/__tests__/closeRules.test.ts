import { describe, it, expect } from "vitest";
import { parseCounted, differenceOf, latestPerDate, formatBusinessDate, type CloseRow } from "../closeRules";

describe("parseCounted", () => {
  it("accepts zero and plain amounts to the paisa", () => {
    expect(parseCounted("0")).toEqual({ ok: true, value: 0 });
    expect(parseCounted(" 1250.50 ")).toEqual({ ok: true, value: 1250.5 });
  });
  it("names what is wrong", () => {
    expect(parseCounted("")).toEqual({ ok: false, reason: "empty" });
    expect(parseCounted("12a")).toEqual({ ok: false, reason: "notANumber" });
    expect(parseCounted("1e3")).toEqual({ ok: false, reason: "notANumber" });
    expect(parseCounted("-5")).toEqual({ ok: false, reason: "negative" });
    expect(parseCounted("10.555")).toEqual({ ok: false, reason: "tooPrecise" });
  });
});

describe("differenceOf", () => {
  it("rounds to paise so float noise never reads as a shortfall", () => {
    expect(differenceOf(0.3, 0.1 + 0.2)).toBe(0);
    expect(differenceOf(190, 200)).toBe(-10);
  });
});

const row = (date: string, closed_at: string, extra: Partial<CloseRow> = {}): CloseRow => ({
  id: `${date}-${closed_at}`, business_date: date, expected_cash: 0, counted_cash: 0, difference: 0,
  note: null, closed_at, reopened_at: null, reopen_reason: null, closer: "S", ...extra,
});

describe("latestPerDate", () => {
  it("keeps the newest close for each date, newest date first", () => {
    const rows = [
      row("2026-09-21", "2026-09-21T15:00:00Z", { reopened_at: "2026-09-21T16:00:00Z", reopen_reason: "x" }),
      row("2026-09-21", "2026-09-21T17:00:00Z"),
      row("2026-09-22", "2026-09-22T15:00:00Z"),
    ];
    expect(latestPerDate(rows).map((r) => r.id)).toEqual([
      "2026-09-22-2026-09-22T15:00:00Z", "2026-09-21-2026-09-21T17:00:00Z",
    ]);
  });
  it("stops at the limit", () => {
    const rows = Array.from({ length: 20 }, (_, i) =>
      row(`2026-08-${String(i + 1).padStart(2, "0")}`, `2026-08-${String(i + 1).padStart(2, "0")}T15:00:00Z`));
    expect(latestPerDate(rows, 14)).toHaveLength(14);
  });
});

describe("formatBusinessDate", () => {
  it("formats the calendar date without shifting it through UTC", () => {
    expect(formatBusinessDate("2026-09-22", "en")).toMatch(/22/);
    expect(formatBusinessDate("2026-09-01", "en")).toMatch(/\b1\b/);
  });
});
