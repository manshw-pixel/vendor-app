import { describe, it, expect, vi, beforeEach } from "vitest";

const invoke = vi.fn(async (..._a: unknown[]): Promise<{
  data: unknown; error: { message?: string; context?: Response } | null;
}> => ({ data: {}, error: null }));
const rpc = vi.fn(async (..._a: unknown[]): Promise<{ data: unknown; error: null }> =>
  ({ data: [], error: null }));

vi.mock("../supabase", () => ({
  supabase: {
    functions: { invoke: (...a: unknown[]) => invoke(...a) },
    rpc: (...a: unknown[]) => rpc(...a),
  },
}));

const { listVendorSummary, createVendor, setVendorSuspended } = await import("../ownerApi");

const value = {
  vendor: { name: "Sharma Veg", address: null, phone: null },
  admin: { name: "Ravi", email: "ravi@shop.test", password: "sunflower9" },
};

function fails(code: string, status: number): void {
  invoke.mockResolvedValueOnce({
    data: null,
    error: { message: "non-2xx", context: new Response(JSON.stringify({ error: code }), { status }) },
  });
}

beforeEach(() => vi.clearAllMocks());

describe("ownerApi", () => {
  it("lists through owner_vendor_summary", async () => {
    await listVendorSummary();
    expect(rpc).toHaveBeenCalledWith("owner_vendor_summary");
  });

  it("creates through owner-create-vendor with the request as the body", async () => {
    expect((await createVendor(value)).error).toBeNull();
    expect(invoke).toHaveBeenCalledWith("owner-create-vendor", { body: value });
  });

  it("suspends and reinstates through owner-suspend-vendor", async () => {
    await setVendorSuspended("v1", "suspend");
    expect(invoke).toHaveBeenCalledWith("owner-suspend-vendor", { body: { vendor_id: "v1", action: "suspend" } });
    await setVendorSuspended("v1", "reinstate");
    expect(invoke).toHaveBeenLastCalledWith("owner-suspend-vendor", { body: { vendor_id: "v1", action: "reinstate" } });
  });

  it("returns the ban outcome so the caller can warn on partial failure", async () => {
    invoke.mockResolvedValueOnce({ data: { banned: 1, failed: 2 }, error: null });
    const { outcome, error } = await setVendorSuspended("v1", "suspend");
    expect(error).toBeNull();
    expect(outcome).toEqual({ banned: 1, failed: 2 });
  });

  it("passes through bans_skipped when the roster read itself failed", async () => {
    invoke.mockResolvedValueOnce({ data: { banned: 0, failed: 0, bans_skipped: true }, error: null });
    const { outcome } = await setVendorSuspended("v1", "suspend");
    expect(outcome).toEqual({ banned: 0, failed: 0, bans_skipped: true });
  });

  it("maps create failure codes", async () => {
    fails("not_owner", 403);
    expect((await createVendor(value)).error?.key).toBe("error.notAllowed");
    fails("email_taken", 409);
    expect((await createVendor(value)).error?.key).toBe("error.emailTaken");
    fails("link_failed", 500);
    expect((await createVendor(value)).error?.key).toBe("owner.vendorPartlyCreated");
  });

  it("maps not_found on suspend", async () => {
    fails("not_found", 404);
    expect((await setVendorSuspended("v1", "suspend")).error?.key).toBe("owner.vendorNotFound");
  });

  it("names being offline", async () => {
    invoke.mockResolvedValueOnce({ data: null, error: { message: "Failed to fetch" } });
    expect((await createVendor(value)).error?.key).toBe("error.offline");
  });
});
