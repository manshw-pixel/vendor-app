import { describe, it, expect, vi, beforeEach } from "vitest";
vi.mock("../data", () => ({ recordOfflineBill: vi.fn() }));
const { memoryKV, setKV } = await import("../offline/kv");
const ob = await import("../offline/outbox");

const base = (vendorId = "v1") => ({
  vendorId, customerId: "c1", customerLabel: "Asha · A-1",
  lines: [{ itemId: "i1", qtyKg: 2, unitPrice: 40 }] as any, mode: "cash" as const,
  redeemPoints: 0, collectDue: 0, total: 80,
});

beforeEach(() => setKV(memoryKV()));

describe("outbox", () => {
  it("numbers bills per vendor and lists them in order", async () => {
    const a = await ob.enqueue(base()); const b = await ob.enqueue(base()); const c = await ob.enqueue(base("v2"));
    expect([a.seq, b.seq, c.seq]).toEqual([1, 2, 1]);
    expect((await ob.listOutbox("v1")).map((x) => x.clientId)).toEqual([a.clientId, b.clientId]);
  });

  it("never sends or lists another vendor's bills", async () => {
    await ob.enqueue(base("v2"));
    const send = vi.fn();
    const r = await ob.flush("v1", send);
    expect(send).not.toHaveBeenCalled();
    expect(r.sent).toBe(0);
    expect(await ob.listOutbox("v2")).toHaveLength(1);
  });

  it("stops on a network error and keeps the bill waiting", async () => {
    await ob.enqueue(base()); await ob.enqueue(base());
    const send = vi.fn(async () => ({ data: null, error: { message: "TypeError: Failed to fetch" } }));
    const r = await ob.flush("v1", send);
    expect(send).toHaveBeenCalledTimes(1);
    expect(r).toEqual({ sent: 0, attention: 0, stoppedOffline: true });
    expect((await ob.listOutbox("v1")).every((b) => b.state === "waiting")).toBe(true);
  });

  it("marks a rejection for attention and carries on", async () => {
    const a = await ob.enqueue(base()); await ob.enqueue(base());
    const send = vi.fn()
      .mockResolvedValueOnce({ data: null, error: { code: "P0002", message: "an item on this bill no longer exists" } })
      .mockResolvedValueOnce({ data: { bill_id: "b2", token_no: 9, issues: [] }, error: null });
    const r = await ob.flush("v1", send);
    expect(r).toEqual({ sent: 1, attention: 1, stoppedOffline: false });
    const left = await ob.listOutbox("v1");
    expect(left).toHaveLength(1);
    expect(left[0]).toMatchObject({ clientId: a.clientId, state: "attention", error: "an item on this bill no longer exists" });
  });

  it("skips attention bills until retried", async () => {
    const a = await ob.enqueue(base());
    await ob.flush("v1", vi.fn(async () => ({ data: null, error: { code: "P0001", message: "day is closed" } })));
    const send = vi.fn(async () => ({ data: { bill_id: "b", token_no: 1, issues: [] }, error: null }));
    await ob.flush("v1", send);
    expect(send).not.toHaveBeenCalled();
    await ob.retry("v1", a.clientId);
    await ob.flush("v1", send);
    expect(send).toHaveBeenCalledTimes(1);
    expect(await ob.listOutbox("v1")).toHaveLength(0);
  });

  it("treats a 23505 unique-violation as a pause (not attention) and leaves the bill waiting", async () => {
    await ob.enqueue(base()); await ob.enqueue(base());
    const send = vi.fn(async () => ({ data: null, error: { code: "23505", message: "duplicate key value violates unique constraint" } }));
    const r = await ob.flush("v1", send);
    expect(send).toHaveBeenCalledTimes(1);
    expect(r).toEqual({ sent: 0, attention: 0, stoppedOffline: true });
    expect((await ob.listOutbox("v1")).every((b) => b.state === "waiting")).toBe(true);
  });

  it("isNetworkError itself does not treat 23505 as a network error", () => {
    expect(ob.isNetworkError({ code: "23505", message: "duplicate key" })).toBe(false);
  });

  it("assigns distinct seqs to concurrent enqueues", async () => {
    const [a, b] = await Promise.all([ob.enqueue(base()), ob.enqueue(base())]);
    expect([a.seq, b.seq].sort()).toEqual([1, 2]);
  });
});
