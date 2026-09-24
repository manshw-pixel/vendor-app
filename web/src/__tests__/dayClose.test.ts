import { describe, it, expect, vi, beforeEach } from "vitest";

const rpc = vi.fn();
const order = vi.fn();
const select = vi.fn((..._a: unknown[]) => ({ order }));
const from = vi.fn((..._a: unknown[]) => ({ select }));
vi.mock("../supabase", () => ({ supabase: { rpc: (...a: unknown[]) => rpc(...a), from: (...a: unknown[]) => from(...a) } }));

const { loadDaySummary, closeDay, reopenDay, loadRecentCloses, loadUnclosedDays } = await import("../dayClose");

beforeEach(() => { rpc.mockReset(); order.mockReset(); from.mockClear(); select.mockClear(); });

describe("loadDaySummary", () => {
  it("asks for today by omitting the date, and coerces numerics", async () => {
    rpc.mockResolvedValue({ data: [{
      business_date: "2026-09-23", cash: "200.00", cash_count: 1, upi: "80.00", upi_count: "1",
      card: "0", card_count: 0, credit: "40.00", credit_count: 1, unrecorded: "0", unrecorded_count: 0,
      expected_cash: "200.00", pending_tokens: "2",
    }], error: null });
    const { data } = await loadDaySummary();
    expect(rpc).toHaveBeenCalledWith("day_summary", {});
    expect(data?.split.cash).toEqual({ total: 200, count: 1 });
    expect(data?.split.upi).toEqual({ total: 80, count: 1 });
    expect(data?.expected_cash).toBe(200);
    expect(data?.pending_tokens).toBe(2);
  });
  it("passes a date when given one", async () => {
    rpc.mockResolvedValue({ data: [], error: null });
    await loadDaySummary("2026-09-20");
    expect(rpc).toHaveBeenCalledWith("day_summary", { p_date: "2026-09-20" });
  });
  it("coerces the dues columns", async () => {
    rpc.mockResolvedValue({ data: [{ business_date: "2026-09-24", cash: "10", cash_count: "1",
      upi: "0", upi_count: "0", card: "0", card_count: "0", credit: "0", credit_count: "0",
      unrecorded: "0", unrecorded_count: "0", expected_cash: "310", pending_tokens: "0",
      dues_cash: "300.00", dues_cash_count: "2", dues_upi: "5.50", dues_upi_count: "1",
      dues_card: "0", dues_card_count: "0" }], error: null });
    const { data } = await loadDaySummary();
    expect(data?.dues).toEqual({ cash: { total: 300, count: 2 }, upi: { total: 5.5, count: 1 }, card: { total: 0, count: 0 } });
  });
});

describe("writes", () => {
  it("sends a blank note as null", async () => {
    rpc.mockResolvedValue({ data: null, error: null });
    await closeDay("2026-09-23", 200, "   ");
    expect(rpc).toHaveBeenCalledWith("close_day", { p_date: "2026-09-23", p_counted_cash: 200, p_note: null });
  });
  it("reopens with a reason", async () => {
    rpc.mockResolvedValue({ data: null, error: null });
    await reopenDay("2026-09-23", "late sale");
    expect(rpc).toHaveBeenCalledWith("reopen_day", { p_date: "2026-09-23", p_reason: "late sale" });
  });
});

describe("reads", () => {
  it("coerces recent closes and flattens the closer's name", async () => {
    order.mockReturnValue({ limit: async () => ({ data: [{
      id: "c1", business_date: "2026-09-22", expected_cash: "200.00", counted_cash: "190.00",
      difference: "-10.00", note: "x", closed_at: "t", reopened_at: null, reopen_reason: null,
      closer: { name: "Sunil" },
    }], error: null }) });
    const { data } = await loadRecentCloses();
    expect(from).toHaveBeenCalledWith("day_closes");
    expect(data?.[0]).toMatchObject({ difference: -10, counted_cash: 190, closer: "Sunil" });
  });
  it("returns unclosed days as date strings", async () => {
    rpc.mockResolvedValue({ data: [{ business_date: "2026-09-22" }, { business_date: "2026-09-21" }], error: null });
    const { data } = await loadUnclosedDays();
    expect(rpc).toHaveBeenCalledWith("unclosed_days");
    expect(data).toEqual(["2026-09-22", "2026-09-21"]);
  });
});
