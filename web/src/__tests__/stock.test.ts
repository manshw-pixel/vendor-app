import { describe, it, expect, vi, beforeEach } from "vitest";

const rpc = vi.fn(async (..._a: unknown[]) => ({ data: null, error: null }));
vi.mock("../supabase", () => ({ supabase: { rpc: (...a: unknown[]) => rpc(...a) } }));

const { logMovement, movementsBetween } = await import("../stock");

beforeEach(() => vi.clearAllMocks());

describe("logMovement", () => {
  it("calls log_stock_movement with the exact SQL parameter names", async () => {
    await logMovement({ itemId: "i1", kind: "purchase", qtyKg: 5, unitCost: 22.5, note: "vashi" });
    expect(rpc).toHaveBeenCalledWith("log_stock_movement", {
      p_item_id: "i1", p_kind: "purchase", p_qty_kg: 5, p_unit_cost: 22.5, p_note: "vashi",
    });
  });

  it("omits p_unit_cost for a wastage so the SQL default of null applies", async () => {
    await logMovement({ itemId: "i1", kind: "wastage", qtyKg: 2, unitCost: null, note: "" });
    expect(rpc).toHaveBeenCalledWith("log_stock_movement", {
      p_item_id: "i1", p_kind: "wastage", p_qty_kg: 2, p_note: "",
    });
  });
});

describe("movementsBetween", () => {
  it("calls stock_movements_between with p_from and p_to", async () => {
    await movementsBetween({ from: "2026-09-01", to: "2026-09-30" });
    expect(rpc).toHaveBeenCalledTimes(1);
    const [fn, args] = rpc.mock.calls[0] as [string, Record<string, string>];
    expect(fn).toBe("stock_movements_between");
    expect(Object.keys(args).sort()).toEqual(["p_from", "p_to"]);
  });
});
