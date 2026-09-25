import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

vi.mock("../data", () => ({
  listItems: vi.fn(), listCustomers: vi.fn(), createCustomer: vi.fn(), findCustomerByMobile: vi.fn(),
  createBill: vi.fn(), replaceBillLines: vi.fn(), issueToken: vi.fn(), billToken: vi.fn(),
  offlineBalances: vi.fn(), recordOfflineBill: vi.fn(),
}));
vi.mock("../components/SessionProvider", () => ({
  useSession: () => ({ kind: "ready", userId: "u1", vendorId: "v1", vendorName: "V", name: "R", role: "biller" }),
}));
vi.mock("../offline/useOnline", () => ({ useOnline: () => false }));

const { memoryKV, setKV } = await import("../offline/kv");
const { saveSnapshot } = await import("../offline/catalogue");
const { listOutbox } = await import("../offline/outbox");
const { default: Bill } = await import("../screens/Bill");
const data = await import("../data");

beforeEach(async () => {
  setKV(memoryKV());
  await saveSnapshot({ vendorId: "v1", cachedAt: Date.now(),
    items: [{ id: "i1", name_en: "Onion", name_hi: "प्याज", name_mr: "कांदा", price: 40, stock_kg: 100, is_active: true, unit: "kg", low_stock_at: 10 } as any],
    customers: [{ id: "c1", name: "Asha", flat_no: "A-1", mobile: "+9198" } as any],
    balances: { c1: { points: 10, due: 50 } } });
});

describe("offline bill", () => {
  it("records a sale into the outbox without touching the network", async () => {
    render(<MemoryRouter><Bill /></MemoryRouter>);
    fireEvent.click(await screen.findByText("Asha"));
    // The same line-adding interaction Bill.test.tsx uses.
    fireEvent.change(await screen.findByTestId("item-select"), { target: { value: "i1" } });
    fireEvent.change(screen.getByLabelText(/weight/i), { target: { value: "2" } });
    fireEvent.click(screen.getByRole("button", { name: /^add$/i }));
    fireEvent.click(screen.getByRole("button", { name: /done/i }));
    fireEvent.click(await screen.findByLabelText(/upi/i));
    fireEvent.click(screen.getByRole("button", { name: /record sale/i }));
    expect(await screen.findByText(/Offline #1/)).toBeTruthy();
    const q = await listOutbox("v1");
    expect(q).toHaveLength(1);
    expect(q[0]).toMatchObject({ customerId: "c1", customerLabel: "Asha · A-1", mode: "upi", total: 80 });
    expect(data.createBill).not.toHaveBeenCalled();
    expect(data.listItems).not.toHaveBeenCalled();
  });

  it("refuses to open without a cache", async () => {
    setKV(memoryKV());
    render(<MemoryRouter><Bill /></MemoryRouter>);
    expect(await screen.findByText(/connect once/i)).toBeTruthy();
  });

  it("hides new-customer creation offline", async () => {
    render(<MemoryRouter><Bill /></MemoryRouter>);
    expect(await screen.findByText(/needs a connection/i)).toBeTruthy();
  });
});
