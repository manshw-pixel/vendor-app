import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../data", () => ({
  listItems: vi.fn(async () => ({ data: [{ id: "i1", name_en: "Onion", price: 40 }], error: null })),
  listCustomers: vi.fn(async () => ({ data: [{ id: "c1", name: "Asha", flat_no: "A-1" }], error: null })),
  offlineBalances: vi.fn(async () => ({ data: [{ customer_id: "c1", points: 12, due: "30.00" }], error: null })),
}));

const { memoryKV, setKV } = await import("../offline/kv");
const cat = await import("../offline/catalogue");
const data = await import("../data");

beforeEach(() => { setKV(memoryKV()); vi.clearAllMocks(); });

describe("catalogue snapshot", () => {
  it("refresh stores items, customers and numeric balances per vendor", async () => {
    const s = await cat.refreshSnapshot("v1");
    expect(s?.balances).toEqual({ c1: { points: 12, due: 30 } });
    expect((await cat.loadSnapshot("v1"))?.items?.[0]?.id).toBe("i1");
    expect(await cat.loadSnapshot("v2")).toBeUndefined();
  });

  it("a failed read keeps the previous snapshot", async () => {
    await cat.refreshSnapshot("v1");
    (data.listItems as any).mockResolvedValueOnce({ data: null, error: { message: "Failed to fetch" } });
    expect(await cat.refreshSnapshot("v1")).toBeNull();
    expect((await cat.loadSnapshot("v1"))?.items).toHaveLength(1);
  });

  it("is stale after 24 hours", () => {
    const s = { vendorId: "v1", cachedAt: 0, items: [], customers: [], balances: {} };
    expect(cat.isStale(s, 24 * 3600e3 - 1)).toBe(false);
    expect(cat.isStale(s, 24 * 3600e3 + 1)).toBe(true);
  });

  it("memoryKV lists keys by prefix", async () => {
    const kv = memoryKV();
    await kv.set("a:1", 1); await kv.set("a:2", 2); await kv.set("b:1", 3);
    expect((await kv.keys("a:")).sort()).toEqual(["a:1", "a:2"]);
  });
});
