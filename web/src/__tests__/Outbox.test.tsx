import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
vi.mock("../data", () => ({ recordOfflineBill: vi.fn() }));
vi.mock("../components/SessionProvider", () => ({
  useSession: () => ({ kind: "ready", userId: "u1", vendorId: "v1", vendorName: "V", name: "R", role: "recorder" }),
}));
const { memoryKV, setKV } = await import("../offline/kv");
const ob = await import("../offline/outbox");
const { default: Outbox } = await import("../screens/Outbox");

beforeEach(async () => {
  setKV(memoryKV());
  const b = await ob.enqueue({ vendorId: "v1", customerId: "c1", customerLabel: "Asha · A-1",
    lines: [] as any, mode: "cash", redeemPoints: 0, collectDue: 0, total: 80 });
  await ob.flush("v1", async () => ({ data: null, error: { code: "P0001", message: "day is closed" } }));
  void b;
});

describe("outbox screen", () => {
  it("shows a bill that needs attention with its reason and a retry", async () => {
    render(<Outbox />);
    expect(await screen.findByText(/Offline #1/)).toBeTruthy();
    expect(screen.getByText(/day is closed/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /retry/i }));
    await waitFor(async () => expect((await ob.listOutbox("v1"))[0]?.state ?? "gone").not.toBe("attention"));
  });
});
