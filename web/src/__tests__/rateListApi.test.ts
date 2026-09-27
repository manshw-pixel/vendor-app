import { describe, it, expect, vi } from "vitest";

const invoke = vi.fn();
const rpc = vi.fn(async (..._a: unknown[]) => ({ data: { updated: [], created: [], unchanged: 0 }, error: null }));
const select = vi.fn(async (..._a: unknown[]) => ({ data: [{ alias: "kanda", item_id: "i1" }], error: null }));
const from = vi.fn((..._a: unknown[]) => ({ select }));
vi.mock("../supabase", () => ({ supabase: { functions: { invoke: (...a: unknown[]) => invoke(...a) }, rpc: (...a: unknown[]) => rpc(...a), from: (...a: unknown[]) => from(...a) } }));

const api = await import("../rateListApi");
const images = [{ media_type: "image/jpeg" as const, data: "QUJD" }];

describe("rateListApi", () => {
  it("reads rows through the Edge Function", async () => {
    invoke.mockResolvedValueOnce({ data: { rows: [{ name_as_written: "Onion" }] }, error: null });
    const r = await api.readRateList(images);
    expect(invoke).toHaveBeenCalledWith("read-rate-list", { body: { images } });
    expect(r.rows?.[0]?.name_as_written).toBe("Onion");
    expect(r.error).toBeNull();
  });
  it("maps a read failure to its message key", async () => {
    invoke.mockResolvedValueOnce({ data: null, error: { message: "x", context: new Response(JSON.stringify({ error: "read_failed" }), { status: 502 }) } });
    const r = await api.readRateList(images);
    expect(r.rows).toBeNull();
    expect(r.error?.key).toBe("rateList.readFailed");
  });
  it("applies through the RPC", async () => {
    await api.applyPriceList([{ kind: "update", item_id: "i1", price: 44 }]);
    expect(rpc).toHaveBeenCalledWith("apply_price_list", { p_rows: [{ kind: "update", item_id: "i1", price: 44 }] });
  });
  it("lists aliases", async () => {
    const r = await api.listAliases();
    expect(from).toHaveBeenCalledWith("item_aliases");
    expect(select).toHaveBeenCalledWith("alias, item_id");
    expect(r.data?.[0]?.alias).toBe("kanda");
  });
});
