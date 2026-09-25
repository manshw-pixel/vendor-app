import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup, within } from "@testing-library/react";
import i18n from "../i18n";
vi.mock("../data", () => ({ recordOfflineBill: vi.fn(async () => ({ data: null, error: null })) }));
vi.mock("../components/SessionProvider", () => ({
  useSession: () => ({ kind: "ready", userId: "u1", vendorId: "v1", vendorName: "V", name: "R", role: "recorder" }),
}));
const { memoryKV, setKV } = await import("../offline/kv");
const ob = await import("../offline/outbox");
const { default: Outbox } = await import("../screens/Outbox");

beforeEach(async () => {
  cleanup();
  await i18n.changeLanguage("en");
  setKV(memoryKV());
  const b = await ob.enqueue({ vendorId: "v1", customerId: "c1", customerLabel: "Asha · A-1",
    lines: [] as any, mode: "cash", redeemPoints: 0, collectDue: 20, total: 80, take: 100 });
  await ob.flush("v1", async () => ({ data: null, error: { code: "P0001", message: "day is closed" } }));
  void b;
});

describe("outbox screen", () => {
  it("shows a bill that needs attention with its reason and a retry", async () => {
    render(<Outbox />);
    expect(await screen.findByText(/Offline #1/)).toBeTruthy();
    expect(screen.getByText(/already closed/)).toBeTruthy();
    expect(screen.queryByText(/day is closed/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /retry/i }));
    await waitFor(async () => expect(await ob.listOutbox("v1")).toHaveLength(0));
    await waitFor(() => expect(screen.queryByText(/Offline #1/)).toBeNull());
  });

  it("shows the amount to take, not the gross total", async () => {
    render(<Outbox />);
    await screen.findByText(/Offline #1/);
    expect(screen.getByText(/100/)).toBeTruthy();
    expect(screen.queryByText(/₹\s*80|80\.00/)).toBeNull();
  });

  it("discards a needs-attention bill only after confirming", async () => {
    render(<Outbox />);
    await screen.findByText(/Offline #1/);
    fireEvent.click(screen.getByRole("button", { name: /^discard$/i }));
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText(/will not be recorded/)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: /cancel/i }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(await ob.listOutbox("v1")).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: /^discard$/i }));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: /^discard$/i }));
    await waitFor(async () => expect(await ob.listOutbox("v1")).toHaveLength(0));
    await waitFor(() => expect(screen.queryByText(/Offline #1/)).toBeNull());
  });

  it("offers no discard on a bill that is still waiting", async () => {
    setKV(memoryKV());
    await ob.enqueue({ vendorId: "v1", customerId: "c1", customerLabel: "B", lines: [] as any,
      mode: "cash", redeemPoints: 0, collectDue: 0, total: 50 });
    render(<Outbox />);
    await screen.findByText(/Offline #1/);
    expect(screen.queryByRole("button", { name: /discard/i })).toBeNull();
  });
});
