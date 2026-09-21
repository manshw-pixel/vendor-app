import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";

const amendSpy = vi.fn(async (..._args: unknown[]): Promise<{
  data: null; error: { message?: string; code?: string } | null;
}> => ({ data: null, error: null }));

vi.mock("../data", () => ({
  listItems: vi.fn(async () => ({
    data: [{ id: "i1", name_en: "Onion", name_hi: "प्याज", name_mr: "कांदा", price: 40, stock_kg: 100, is_active: true, unit: "kg", low_stock_at: 10 }],
    error: null,
  })),
  billDraftLines: vi.fn(async () => ({
    data: [{ itemId: "i1", name: "Onion", unitPrice: 40, qtyKg: 2, unit: "kg" }],
    error: null,
  })),
  amendPendingBill: (...args: unknown[]) => amendSpy(...args),
}));

const { default: AmendBill } = await import("../screens/AmendBill");

beforeEach(() => {
  vi.clearAllMocks();
  amendSpy.mockResolvedValue({ data: null, error: null });
});

function renderAmend(billId: string) {
  return render(
    <MemoryRouter initialEntries={[`/amend/${billId}`]}>
      <Routes>
        <Route path="/amend/:billId" element={<AmendBill />} />
        <Route path="/pending" element={<div>pending screen</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

describe("correcting a pending bill", () => {
  it("loads the bill's stored lines into the basket", async () => {
    renderAmend("b1");
    expect(await screen.findByText("Onion")).toBeTruthy();
    expect(screen.getByTestId("amend-old-total").textContent ?? "").toMatch(/80/);
  });

  it("shows the old total beside the new one as the basket changes", async () => {
    renderAmend("b1");
    await screen.findByText("Onion");
    fireEvent.click(screen.getByLabelText(/remove onion/i));
    expect(screen.getByTestId("amend-old-total").textContent ?? "").toMatch(/80/);
    expect(screen.getByTestId("amend-new-total").textContent ?? "").toMatch(/0\.00/);
  });

  it("refuses to save an empty basket", async () => {
    renderAmend("b1");
    await screen.findByText("Onion");
    fireEvent.click(screen.getByLabelText(/remove onion/i));
    expect(screen.getByTestId("amend-save")).toHaveProperty("disabled", true);
    expect(amendSpy).not.toHaveBeenCalled();
  });

  it("saves through amendPendingBill and returns to the queue", async () => {
    renderAmend("b1");
    await screen.findByText("Onion");
    fireEvent.click(screen.getByTestId("amend-save"));
    fireEvent.click(screen.getByTestId("amend-confirm"));
    await waitFor(() => expect(amendSpy).toHaveBeenCalledWith("b1", [
      { itemId: "i1", name: "Onion", unitPrice: 40, qtyKg: 2, unit: "kg" },
    ]));
  });

  it("surfaces a refusal and keeps the basket on screen", async () => {
    amendSpy.mockResolvedValue({ data: null, error: { message: "bill b1 is done, expected billed" } });
    renderAmend("b1");
    await screen.findByText("Onion");
    fireEvent.click(screen.getByTestId("amend-save"));
    fireEvent.click(screen.getByTestId("amend-confirm"));
    expect(await screen.findByTestId("amend-error")).toBeTruthy();
    expect(screen.getByText("Onion")).toBeTruthy();
  });
});
