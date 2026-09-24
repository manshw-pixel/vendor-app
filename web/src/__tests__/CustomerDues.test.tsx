import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import i18n from "../i18n";
import type { DuesEntry } from "../dues";

const entry = (e: Partial<DuesEntry>): DuesEntry => ({
  kind: "repayment", id: "e1", at: "2026-09-24T05:00:00Z", business_date: "2026-09-24", amount: 40,
  mode: "cash", note: null, by_name: "Sunil", token_no: null, reversed_at: null, reversed_by_name: null,
  reverse_reason: null, day_closed: false, ...e,
});
const ENTRIES: DuesEntry[] = [
  entry({ id: "r1" }),
  entry({ id: "r0", business_date: "2026-09-22", day_closed: true, mode: "upi" }),
  entry({ id: "o1", kind: "opening", mode: null, note: "khata" }),
  entry({ id: "rv", reversed_at: "2026-09-24T06:00:00Z", reversed_by_name: "Admin", reverse_reason: "typo" }),
  entry({ id: "b1", kind: "credit_bill", mode: null, token_no: 17, amount: 240 }),
];

const loadCustomerDues = vi.fn();
const recordRepayment = vi.fn();
const recordOpeningBalance = vi.fn();
const reverseDuesEntry = vi.fn();
vi.mock("../dues", () => ({
  loadCustomerDues: (...a: unknown[]) => loadCustomerDues(...a),
  recordRepayment: (...a: unknown[]) => recordRepayment(...a),
  recordOpeningBalance: (...a: unknown[]) => recordOpeningBalance(...a),
  reverseDuesEntry: (...a: unknown[]) => reverseDuesEntry(...a),
}));

let role: "admin" | "biller" = "biller";
vi.mock("../components/SessionProvider", () => ({
  useSession: () => ({ kind: "ready", userId: "u1", vendorId: "v1", vendorName: "V", name: "S", role }),
}));

const { default: CustomerDues } = await import("../screens/CustomerDues");

function renderAs(r: "admin" | "biller") {
  role = r;
  return render(
    <MemoryRouter initialEntries={["/dues/c1"]}>
      <Routes><Route path="/dues/:customerId" element={<CustomerDues />} /></Routes>
    </MemoryRouter>,
  );
}

beforeEach(async () => {
  vi.clearAllMocks();
  await i18n.changeLanguage("en");
  loadCustomerDues.mockResolvedValue({ data: { balance: 160, entries: ENTRIES }, error: null });
  recordRepayment.mockResolvedValue({ error: null });
  recordOpeningBalance.mockResolvedValue({ error: null });
  reverseDuesEntry.mockResolvedValue({ error: null });
});

describe("Customer dues", () => {
  it("shows the balance and the timeline, with a receipt link on credit bills", async () => {
    renderAs("biller");
    expect((await screen.findByTestId("cd-balance")).textContent).toMatch(/160\.00/);
    expect(loadCustomerDues).toHaveBeenCalledWith("c1");
    expect(screen.getByTestId("cd-entry-b1").textContent).toMatch(/token 17/);
    expect(screen.getByTestId("cd-entry-b1").querySelector("a")?.getAttribute("href")).toBe("/receipt/b1");
    expect(screen.getByTestId("cd-entry-rv").textContent).toMatch(/Reversed: typo/);
    expect(screen.getByTestId("cd-entry-rv").className).toMatch(/line-through/);
  });

  it("records a payment: amount pre-filled, a mode required, then reloads", async () => {
    renderAs("biller");
    fireEvent.click(await screen.findByTestId("cd-receive"));
    expect(screen.getByTestId("cd-amount")).toHaveProperty("value", "160");
    expect(screen.getByTestId("cd-receive-confirm")).toHaveProperty("disabled", true);
    fireEvent.change(screen.getByTestId("cd-amount"), { target: { value: "100" } });
    fireEvent.click(screen.getByTestId("cd-mode-upi"));
    fireEvent.click(screen.getByTestId("cd-receive-confirm"));
    await waitFor(() => expect(recordRepayment).toHaveBeenCalledWith("c1", 100, "upi", ""));
    await waitFor(() => expect(loadCustomerDues).toHaveBeenCalledTimes(2));
  });

  it("will not submit more than the balance", async () => {
    renderAs("biller");
    fireEvent.click(await screen.findByTestId("cd-receive"));
    fireEvent.change(screen.getByTestId("cd-amount"), { target: { value: "160.01" } });
    fireEvent.click(screen.getByTestId("cd-mode-cash"));
    expect(screen.getByTestId("cd-receive-confirm")).toHaveProperty("disabled", true);
    expect(screen.getByText(/more than they owe/)).toBeTruthy();
  });

  it("hides Received payment when nothing is owed", async () => {
    loadCustomerDues.mockResolvedValue({ data: { balance: 0, entries: [] }, error: null });
    renderAs("biller");
    await screen.findByTestId("cd-balance");
    expect(screen.queryByTestId("cd-receive")).toBeNull();
  });

  it("shows a server refusal from recording", async () => {
    recordRepayment.mockResolvedValue({ error: { message: "more than the balance", code: "P0001" } });
    renderAs("biller");
    fireEvent.click(await screen.findByTestId("cd-receive"));
    fireEvent.click(screen.getByTestId("cd-mode-cash"));
    fireEvent.click(screen.getByTestId("cd-receive-confirm"));
    expect(await screen.findByText(i18n.t("dues.overBalance"))).toBeTruthy();
  });

  it("offers Add opening balance to an admin only, with a note required", async () => {
    renderAs("biller");
    await screen.findByTestId("cd-balance");
    expect(screen.queryByTestId("cd-opening")).toBeNull();

    renderAs("admin");
    fireEvent.click((await screen.findAllByTestId("cd-opening"))[0]!);
    fireEvent.change(screen.getByTestId("cd-opening-amount"), { target: { value: "500" } });
    expect(screen.getByTestId("cd-opening-confirm")).toHaveProperty("disabled", true);
    fireEvent.change(screen.getByTestId("cd-opening-note"), { target: { value: "old khata" } });
    fireEvent.click(screen.getByTestId("cd-opening-confirm"));
    await waitFor(() => expect(recordOpeningBalance).toHaveBeenCalledWith("c1", 500, "old khata"));
  });

  it("offers Reverse on open repayments; not on a closed day's, a reversed one, a bill, or (for a biller) an opening", async () => {
    renderAs("biller");
    await screen.findByTestId("cd-balance");
    expect(screen.queryByTestId("cd-reverse-r1")).not.toBeNull();
    expect(screen.queryByTestId("cd-reverse-r0")).toBeNull();
    expect(screen.queryByTestId("cd-reverse-rv")).toBeNull();
    expect(screen.queryByTestId("cd-reverse-b1")).toBeNull();
    expect(screen.queryByTestId("cd-reverse-o1")).toBeNull();

    fireEvent.click(screen.getByTestId("cd-reverse-r1"));
    expect(screen.getByTestId("cd-reverse-accept")).toHaveProperty("disabled", true);
    fireEvent.change(screen.getByTestId("cd-reverse-reason"), { target: { value: "wrong customer" } });
    fireEvent.click(screen.getByTestId("cd-reverse-accept"));
    await waitFor(() => expect(reverseDuesEntry).toHaveBeenCalledWith("r1", "wrong customer"));
  });

  it("offers an admin Reverse on an opening", async () => {
    renderAs("admin");
    expect(await screen.findByTestId("cd-reverse-o1")).toBeTruthy();
  });
});
