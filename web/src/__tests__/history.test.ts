import { describe, it, expect, vi, beforeEach } from "vitest";

type ChainKey = "select" | "eq" | "gte" | "lt" | "order" | "limit" | "or";
type ChainFn = ReturnType<typeof vi.fn<(...a: unknown[]) => void>>;
const chain = {} as Record<ChainKey, ChainFn>;
const make = () => {
  const o: Record<string, unknown> = {};
  for (const k of ["select", "eq", "gte", "lt", "order", "limit", "or"] as ChainKey[]) {
    chain[k] = chain[k] ?? vi.fn();
    const fn = chain[k];
    o[k] = (...a: unknown[]) => { fn(...a); return o; };
  }
  (o as { then: unknown }).then = (res: (v: unknown) => unknown) =>
    Promise.resolve({ data: [], error: null }).then(res);
  return o;
};
const from = vi.fn((..._a: unknown[]) => make());
const rpc = vi.fn(async (..._a: unknown[]) => ({ data: [], error: null }));

vi.mock("../supabase", () => ({
  supabase: { from: (...a: unknown[]) => from(...a), rpc: (...a: unknown[]) => rpc(...a) },
}));

const { listCompleted, billLines, collectedBetween, topItemsBetween, pairsBetween, PAGE_SIZE } =
  await import("../history");

const RANGE = { from: "2026-09-09", to: "2026-09-09" };

beforeEach(() => { vi.clearAllMocks(); });

describe("listCompleted", () => {
  it("reads bills, filtered to done and to the window", async () => {
    await listCompleted(RANGE, null);
    expect(from).toHaveBeenCalledWith("bills");
    expect(chain.eq).toHaveBeenCalledWith("status", "done");
    // Half-open: gte the start instant, lt the instant the day after `to` begins.
    expect(chain.gte).toHaveBeenCalledWith("completed_at", expect.any(String));
    expect(chain.lt).toHaveBeenCalledWith("completed_at", expect.any(String));
  });

  it("asks for one more row than the page size", async () => {
    // The extra row is how the screen learns there IS a next page without a count query.
    await listCompleted(RANGE, null);
    expect(chain.limit).toHaveBeenCalledWith(PAGE_SIZE + 1);
  });

  it("orders by completed_at and id, both descending", async () => {
    // id breaks ties: completed_at is not unique, and an unstable order would drop or
    // repeat a row at the page boundary.
    await listCompleted(RANGE, null);
    expect(chain.order).toHaveBeenCalledWith("completed_at", { ascending: false });
    expect(chain.order).toHaveBeenCalledWith("id", { ascending: false });
  });

  it("pages with a keyset, not an offset", async () => {
    await listCompleted(RANGE, { completedAt: "2026-09-09T10:00:00.000Z", id: "b9" });
    // Asserted whole, not by fragments. The BROKEN clause
    // "completed_at.lt.X,id.lt.Y" contains both fragments too, and it drops every bill
    // with a smaller id at any earlier instant -- sales silently missing from history.
    // Only the full string pins the disjunction's structure.
    const clause = chain.or.mock.calls[0]?.[0] as string;
    expect(clause).toBe(
      "completed_at.lt.2026-09-09T10:00:00.000Z," +
        "and(completed_at.eq.2026-09-09T10:00:00.000Z,id.lt.b9)",
    );
  });
});

describe("billLines", () => {
  it("reads the lines of one bill with their item names", async () => {
    await billLines("b1");
    expect(from).toHaveBeenCalledWith("bill_items");
    expect(chain.eq).toHaveBeenCalledWith("bill_id", "b1");
  });
});

describe("collectedBetween", () => {
  it("aggregates in the database instead of summing rows in the browser", async () => {
    // Two things this must not be. Not v_payments_daily: that view buckets with
    // date_trunc in the SERVER's timezone (UTC on Supabase) while the shops are at
    // UTC+5:30, so a UTC day boundary would push the first 5.5 hours of every Indian day
    // into the day before. And not a select-then-sum: PostgREST truncates at db-max-rows
    // (1000) with NO error, so a busy month's takings would silently stop growing.
    await collectedBetween(RANGE);
    expect(rpc).toHaveBeenCalledWith("collected_between", {
      p_from: expect.any(String), p_to: expect.any(String),
    });
    expect(from).not.toHaveBeenCalledWith("v_payments_daily");
    expect(from).not.toHaveBeenCalledWith("bills");
  });
});

describe("the analytics RPCs", () => {
  it("calls top_items_between with the parameter names the migration declares", async () => {
    await topItemsBetween(RANGE);
    expect(rpc).toHaveBeenCalledWith("top_items_between", {
      p_from: expect.any(String), p_to: expect.any(String),
    });
  });

  it("calls bought_together_between with the parameter names the migration declares", async () => {
    await pairsBetween(RANGE);
    expect(rpc).toHaveBeenCalledWith("bought_together_between", {
      p_from: expect.any(String), p_to: expect.any(String),
    });
  });
});
