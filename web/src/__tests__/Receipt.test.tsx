import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { Link } from "react-router-dom";
import type { Receipt as ReceiptData } from "../receipt";
import i18n from "../i18n";

const loadReceipt = vi.fn();
vi.mock("../receipt", () => ({ loadReceipt: (...a: unknown[]) => loadReceipt(...a) }));

const Receipt = (await import("../screens/Receipt")).default;

const FULL: ReceiptData = {
  token_no: 147,
  completed_at: "2026-09-17T14:12:00.000Z",
  net: 166,
  gross: 216,
  redeemed_points: 50,
  lines: [
    { id: "l1", qty_kg: 1.5, unit_price: 40, line_total: 60,
      items: { name_en: "Tomato", name_hi: "टमाटर", name_mr: "टोमॅटो", unit: "kg" } },
    { id: "l2", qty_kg: 3, unit_price: 30, line_total: 90,
      items: { name_en: "Lemon", name_hi: "नींबू", name_mr: "लिंबू", unit: "piece" } },
  ],
  customer: { name: "Sunita Kale", flat_no: "B-304" },
  biller_name: "Sunil",
  shop: { name: "Taji Bhaji", address: "Shop 12, Kothrud", phone: "9876543210" },
  points_earned: 0,
  balance: { balance: 260, days_left: 15 },
  voided: null,
  payment_mode: null,
  due_collected: 0,
};

const renderAt = () =>
  render(
    <MemoryRouter initialEntries={["/receipt/b1"]}>
      <Routes><Route path="/receipt/:billId" element={<Receipt />} /></Routes>
    </MemoryRouter>,
  );

beforeEach(() => {
  vi.clearAllMocks();
  loadReceipt.mockResolvedValue({ data: FULL, error: null });
});

describe("Receipt", () => {
  it("prints the token, the shop header and the customer", async () => {
    renderAt();
    expect((await screen.findByTestId("receipt-token")).textContent).toMatch(/147/);
    expect(screen.getByTestId("receipt-shop").textContent).toMatch(/Taji Bhaji/);
    expect(screen.getByTestId("receipt-shop").textContent).toMatch(/Shop 12, Kothrud/);
    expect(screen.getByTestId("receipt-customer").textContent).toMatch(/Sunita Kale/);
    expect(screen.getByTestId("receipt-customer").textContent).toMatch(/B-304/);
  });

  it("shows the subtotal as the gross, not the stored net", async () => {
    renderAt();
    expect((await screen.findByTestId("receipt-subtotal")).textContent).toMatch(/216.00/);
    expect(screen.getByTestId("receipt-total").textContent).toMatch(/166.00/);
  });

  // Split from the brief's single combined test, which rendered the component TWICE and
  // asserted queryAllByTestId(...).toHaveLength(1) across two separate mounted trees --
  // an assertion that could pass even if the feature were broken, because it never
  // compares the two mounts to each other. Two independent fixtures, two independent
  // assertions, same intent.
  it("shows the redemption line when points were spent", async () => {
    renderAt();
    expect(await screen.findByTestId("receipt-redeemed")).toBeTruthy();
  });

  it("omits the redemption line when no points were spent", async () => {
    loadReceipt.mockResolvedValue({ data: { ...FULL, redeemed_points: 0, gross: 166 }, error: null });
    renderAt();
    await screen.findByTestId("receipt-total");
    expect(screen.queryByTestId("receipt-redeemed")).toBeNull();
  });

  it("omits the expiry line when the balance is zero", async () => {
    loadReceipt.mockResolvedValue({
      data: { ...FULL, balance: { balance: 0, days_left: null } }, error: null,
    });
    renderAt();
    await screen.findByTestId("receipt-token");
    expect(screen.queryByTestId("receipt-expires")).toBeNull();
  });

  it("renders a walk-in bill with no customer and no points block", async () => {
    // Every existing screen joins customers optionally; the slip must too.
    loadReceipt.mockResolvedValue({
      data: { ...FULL, customer: null, balance: null, points_earned: 0 }, error: null,
    });
    renderAt();
    await screen.findByTestId("receipt-token");
    expect(screen.queryByTestId("receipt-customer")).toBeNull();
    expect(screen.queryByTestId("receipt-points")).toBeNull();
  });

  it("still renders when the biller name is missing", async () => {
    loadReceipt.mockResolvedValue({ data: { ...FULL, biller_name: null }, error: null });
    renderAt();
    expect((await screen.findByTestId("receipt-token")).textContent).toMatch(/147/);
    expect(screen.queryByTestId("receipt-served-by")).toBeNull();
  });

  it("omits a shop line that is blank", async () => {
    loadReceipt.mockResolvedValue({
      data: { ...FULL, shop: { name: "Taji Bhaji", address: null, phone: null } }, error: null,
    });
    renderAt();
    const shop = await screen.findByTestId("receipt-shop");
    expect(shop.textContent).toMatch(/Taji Bhaji/);
    expect(screen.queryByTestId("receipt-shop-address")).toBeNull();
  });

  it("names each line's quantity in the item's own unit", async () => {
    renderAt();
    expect((await screen.findByTestId("receipt-line-l1")).textContent).toContain("1.5 kg x 40.00");
    expect(screen.getByTestId("receipt-line-l2").textContent).toContain("3 pcs x 30.00");
  });

  it("names the item in the active language", async () => {
    renderAt();
    // The test environment's navigator.language isn't controlled here (see Bill.test.tsx
    // for the same pattern), so this only pins down that itemName's chosen name shows up
    // -- not which of the three languages resolveLang lands on in jsdom.
    expect((await screen.findByTestId("receipt-line-l1")).textContent ?? "").toMatch(
      /Tomato|टमाटर|टोमॅटो/,
    );
  });

  it("calls window.print when Print is pressed", async () => {
    const print = vi.spyOn(window, "print").mockImplementation(() => {});
    renderAt();
    (await screen.findByTestId("receipt-print")).click();
    expect(print).toHaveBeenCalled();
  });

  it("shows a VOIDED banner with the reason when the bill was voided", async () => {
    loadReceipt.mockResolvedValue({
      data: { ...FULL, voided: { at: "2026-09-18T09:00:00.000Z", reason: "typed twice" } },
      error: null,
    });
    renderAt();
    const banner = await screen.findByTestId("receipt-voided");
    expect(banner.textContent).toMatch(/VOIDED/);
    expect(banner.textContent).toMatch(/typed twice/);
  });

  it("shows no VOIDED banner for a normal receipt", async () => {
    renderAt();
    await screen.findByTestId("receipt-token");
    expect(screen.queryByTestId("receipt-voided")).toBeNull();
  });

  it("prints how the bill was paid", async () => {
    loadReceipt.mockResolvedValue({ data: { ...FULL, payment_mode: "upi" }, error: null });
    renderAt();
    expect((await screen.findByTestId("receipt-mode")).textContent).toMatch(/UPI/);
  });

  it("prints 'On credit' with the amount due, and no Paid row, for a credit bill", async () => {
    // A credit bill was not paid: the slip must not say "Paid 166.00". The due row
    // carries the amount after points instead, and the mode is not printed twice.
    loadReceipt.mockResolvedValue({ data: { ...FULL, payment_mode: "credit" }, error: null });
    renderAt();
    const due = await screen.findByTestId("receipt-credit-due");
    expect(due.textContent).toContain(i18n.t("receipt.onCredit"));
    expect(due.textContent).toMatch(/166.00/);
    expect(screen.queryByTestId("receipt-paid")).toBeNull();
    expect(screen.queryByTestId("receipt-mode")).toBeNull();
    const slip = document.querySelector(".receipt-slip")!.textContent ?? "";
    expect(slip).not.toContain(i18n.t("receipt.paid"));
  });

  it.each(["cash", "upi", "card"] as const)("still prints the Paid row for a %s bill", async (mode) => {
    loadReceipt.mockResolvedValue({ data: { ...FULL, payment_mode: mode }, error: null });
    renderAt();
    const paid = await screen.findByTestId("receipt-paid");
    expect(paid.textContent).toContain(i18n.t("receipt.paid"));
    expect(paid.textContent).toMatch(/166.00/);
    expect(screen.queryByTestId("receipt-credit-due")).toBeNull();
  });

  it("prints no mode line for a bill completed before modes existed", async () => {
    renderAt();
    await screen.findByTestId("receipt-total");
    expect(screen.queryByTestId("receipt-mode")).toBeNull();
  });

  it("prints the previous due paid and the total collected", async () => {
    await i18n.changeLanguage("en");
    loadReceipt.mockResolvedValue({ data: { ...FULL, payment_mode: "cash", due_collected: 240 }, error: null });
    renderAt();
    expect((await screen.findByTestId("receipt-due-paid")).textContent).toMatch(/Previous due paid.*240\.00/);
    expect(screen.getByTestId("receipt-total-collected").textContent).toMatch(/Total collected.*406\.00/);
    expect(screen.getByTestId("receipt-paid").textContent).toMatch(/166\.00/);   // the sale is unchanged
  });

  it("on a voided slip, prints the due paid but no total collected", async () => {
    await i18n.changeLanguage("en");
    loadReceipt.mockResolvedValue({
      data: { ...FULL, payment_mode: "cash", due_collected: 240,
              voided: { at: "2026-09-18T09:00:00.000Z", reason: "typed twice" } },
      error: null,
    });
    renderAt();
    expect((await screen.findByTestId("receipt-due-paid")).textContent).toMatch(/Previous due paid.*240\.00/);
    expect(screen.queryByTestId("receipt-total-collected")).toBeNull();
  });

  it("prints neither line when no due was collected", async () => {
    await i18n.changeLanguage("en");
    loadReceipt.mockResolvedValue({ data: { ...FULL, payment_mode: "cash" }, error: null });
    renderAt();
    await screen.findByTestId("receipt-paid");
    expect(screen.queryByTestId("receipt-due-paid")).toBeNull();
    expect(screen.queryByTestId("receipt-total-collected")).toBeNull();
  });

  it("says so when the bill cannot be loaded", async () => {
    loadReceipt.mockResolvedValue({ data: null, error: { message: "gone" } });
    renderAt();
    expect(await screen.findByTestId("receipt-problem")).toBeTruthy();
  });

  it("clears a prior bill's error when navigating to a different, valid bill id", async () => {
    // Regression for a stale-state bug: without resetting `data`/`problem` on billId
    // change, a failed load for one bill could sit on screen, unresolved, over a good
    // load for the next -- or worse, a slow first response could land after a second
    // navigation and render bill A's slip under bill B's URL.
    loadReceipt.mockImplementation(async (billId: string) =>
      billId === "b1"
        ? { data: null, error: { message: "gone" } }
        : { data: { ...FULL, token_no: 999 }, error: null },
    );

    render(
      <MemoryRouter initialEntries={["/receipt/b1"]}>
        <Routes>
          <Route
            path="/receipt/:billId"
            element={
              <>
                <Link to="/receipt/b2" data-testid="go-b2">next</Link>
                <Receipt />
              </>
            }
          />
        </Routes>
      </MemoryRouter>,
    );

    expect(await screen.findByTestId("receipt-problem")).toBeTruthy();

    screen.getByTestId("go-b2").click();

    await waitFor(() => expect(screen.queryByTestId("receipt-problem")).toBeNull());
    expect((await screen.findByTestId("receipt-token")).textContent).toMatch(/999/);
  });
});
