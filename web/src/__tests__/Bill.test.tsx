import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

vi.mock("../data", () => ({
  listItems: vi.fn(async () => ({ data: [{ id: "i1", name_en: "Onion", name_hi: "प्याज", name_mr: "कांदा", price: 40, stock_kg: 100, is_active: true }], error: null })),
  listCustomers: vi.fn(async () => ({ data: [{ id: "c1", name: "Asha", flat_no: "A-1", mobile: "+9198" }], error: null })),
  createCustomer: vi.fn(),
  createBill: vi.fn(async () => ({ data: { id: "b1" }, error: null })),
  addLines: vi.fn(async () => ({ error: null })),
  issueToken: vi.fn(async () => ({ data: 7, error: null })),
}));

vi.mock("../components/SessionProvider", () => ({
  useSession: () => ({ kind: "ready", userId: "u1", vendorId: "v1", vendorName: "V", name: "R", role: "recorder" }),
}));

const { default: Bill } = await import("../screens/Bill");
const data = await import("../data");

beforeEach(() => vi.clearAllMocks());

describe("the bill screen", () => {
  it("issues a token through the full flow", async () => {
    render(<Bill />);

    // 1. pick the customer
    fireEvent.click(await screen.findByText("Asha"));

    // 2. add a line
    fireEvent.click(await screen.findByText(/Onion|कांदा/));
    fireEvent.change(screen.getByLabelText(/weight/i), { target: { value: "2" } });
    fireEvent.click(screen.getByRole("button", { name: /^add$/i }));

    // the running total is feedback for the recorder
    expect(await screen.findByText(/80/)).toBeTruthy();

    // 3. Done is guarded by a confirm, because the basket freezes afterwards
    fireEvent.click(screen.getByRole("button", { name: /done/i }));
    fireEvent.click(screen.getByRole("button", { name: /issue the token/i }));

    await waitFor(() => expect(data.issueToken).toHaveBeenCalledWith("b1"));
    expect(data.createBill).toHaveBeenCalledWith("v1", "c1", "u1");
    expect(data.addLines).toHaveBeenCalledWith("v1", "b1", [
      { itemId: "i1", name: expect.any(String), unitPrice: 40, qtyKg: 2 },
    ]);
    expect(await screen.findByText("7")).toBeTruthy();
  });

  it("will not issue a token for an empty basket", async () => {
    render(<Bill />);
    fireEvent.click(await screen.findByText("Asha"));
    expect(screen.getByRole("button", { name: /done/i })).toHaveProperty("disabled", true);
    expect(data.issueToken).not.toHaveBeenCalled();
  });

  it("rejects a weight with more precision than the column stores", async () => {
    render(<Bill />);
    fireEvent.click(await screen.findByText("Asha"));
    fireEvent.click(await screen.findByText(/Onion|कांदा/));
    fireEvent.change(screen.getByLabelText(/weight/i), { target: { value: "1.234" } });
    fireEvent.click(screen.getByRole("button", { name: /^add$/i }));
    expect(await screen.findByText(/two decimal places|दोन|दो/i)).toBeTruthy();
  });
});
