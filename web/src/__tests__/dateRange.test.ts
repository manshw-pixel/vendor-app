import { describe, it, expect } from "vitest";
import { presetRange, validateRange, toBounds, PRESETS } from "../dateRange";

// A Wednesday, chosen so the week boundary is visibly not the same as the day boundary.
const wed = new Date(2026, 8, 9, 14, 30);

describe("presetRange", () => {
  it("makes today a single inclusive day", () => {
    expect(presetRange("today", wed)).toEqual({ from: "2026-09-09", to: "2026-09-09" });
  });

  it("starts the week on Monday", () => {
    // v_payments_weekly uses date_trunc('week', ...), which is Monday in Postgres. A
    // Sunday-start UI would silently disagree with the data it filters.
    expect(presetRange("week", wed)).toEqual({ from: "2026-09-07", to: "2026-09-09" });
  });

  it("treats Monday itself as the whole week so far", () => {
    const mon = new Date(2026, 8, 7, 9, 0);
    expect(presetRange("week", mon)).toEqual({ from: "2026-09-07", to: "2026-09-07" });
  });

  it("treats Sunday as the END of its week, not the start", () => {
    const sun = new Date(2026, 8, 13, 9, 0);
    expect(presetRange("week", sun)).toEqual({ from: "2026-09-07", to: "2026-09-13" });
  });

  it("runs the month from the first to today", () => {
    expect(presetRange("month", wed)).toEqual({ from: "2026-09-01", to: "2026-09-09" });
  });

  it("offers exactly three presets", () => {
    expect([...PRESETS]).toEqual(["today", "week", "month"]);
  });
});

describe("validateRange", () => {
  it("accepts a normal range", () => {
    const r = validateRange("2026-09-01", "2026-09-09");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toEqual({ from: "2026-09-01", to: "2026-09-09" });
  });

  it("accepts a single day", () => {
    expect(validateRange("2026-09-09", "2026-09-09").ok).toBe(true);
  });

  it("rejects a backwards range rather than sending it", () => {
    // The query would succeed and return nothing, which reads as "no sales" instead of
    // "bad input". A false answer is worse than an error.
    const r = validateRange("2026-09-10", "2026-09-09");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("range.backwards");
  });

  it("rejects a blank or unparseable date", () => {
    expect(validateRange("", "2026-09-09").ok).toBe(false);
    expect(validateRange("2026-09-09", "not-a-date").ok).toBe(false);
    expect(validateRange("2026-13-01", "2026-09-09").ok).toBe(false);
  });
});

describe("toBounds", () => {
  it("makes the end exclusive so the last day is fully included", () => {
    // completed_at is a timestamp. An inclusive '2026-09-09' bound would drop every bill
    // rung up after midnight on the 9th -- which is all of them.
    const b = toBounds({ from: "2026-09-09", to: "2026-09-09" });
    expect(b.fromTs).toBe(new Date(2026, 8, 9, 0, 0, 0).toISOString());
    expect(b.toTs).toBe(new Date(2026, 8, 10, 0, 0, 0).toISOString());
  });

  it("crosses a month boundary correctly", () => {
    const b = toBounds({ from: "2026-08-31", to: "2026-09-01" });
    expect(b.fromTs).toBe(new Date(2026, 7, 31, 0, 0, 0).toISOString());
    expect(b.toTs).toBe(new Date(2026, 8, 2, 0, 0, 0).toISOString());
  });

  it("crosses a year boundary correctly", () => {
    const b = toBounds({ from: "2026-12-31", to: "2026-12-31" });
    expect(b.toTs).toBe(new Date(2027, 0, 1, 0, 0, 0).toISOString());
  });
});
