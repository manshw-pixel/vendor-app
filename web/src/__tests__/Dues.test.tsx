import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import i18n from "../i18n";
import type { DuesRow } from "../dues";

const ROWS: DuesRow[] = [
  { customer_id: "c2", name: "Ravi", flat_no: "B-7", mobile: "+919822222222", balance: 1240, oldest_unpaid: "2026-09-12" },
  { customer_id: "c1", name: "Asha", flat_no: "A-1", mobile: "+919811111111", balance: 40, oldest_unpaid: "2026-09-20" },
  { customer_id: "c3", name: "Meena", flat_no: "C-3", mobile: "+919833333333", balance: -300, oldest_unpaid: null },
];
const loadDuesList = vi.fn();
const loadUnassignedCredit = vi.fn();
const assignCreditCustomer = vi.fn();
vi.mock("../dues", () => ({
  loadDuesList: (...a: unknown[]) => loadDuesList(...a),
  loadUnassignedCredit: (...a: unknown[]) => loadUnassignedCredit(...a),
  assignCreditCustomer: (...a: unknown[]) => assignCreditCustomer(...a),
}));
const listCustomers = vi.fn();
vi.mock("../data", () => ({ listCustomers: (...a: unknown[]) => listCustomers(...a) }));

let role: "admin" | "biller" = "biller";
vi.mock("../components/SessionProvider", () => ({
  useSession: () => ({ kind: "ready", userId: "u1", vendorId: "v1", vendorName: "V", name: "S", role }),
}));

const { default: Dues } = await import("../screens/Dues");

function renderAs(r: "admin" | "biller") {
  role = r;
  return render(<MemoryRouter><Dues /></MemoryRouter>);
}

beforeEach(async () => {
  vi.clearAllMocks();
  await i18n.changeLanguage("en");
  loadDuesList.mockResolvedValue({ data: ROWS, error: null });
  loadUnassignedCredit.mockResolvedValue({ data: [], error: null });
  listCustomers.mockResolvedValue({ data: [], error: null });
});

describe("Dues list", () => {
  it("shows the total owed, each customer's balance and since-date, overpaid last", async () => {
    renderAs("biller");
    expect((await screen.findByTestId("dues-total")).textContent).toMatch(/1,280\.00.*2/);
    const rows = screen.getAllByTestId(/^dues-row-/);
    expect(rows.map((r) => r.getAttribute("data-testid"))).toEqual(["dues-row-c2", "dues-row-c1", "dues-row-c3"]);
    expect(rows[0]!.textContent).toMatch(/1,240\.00/);
    expect(rows[0]!.textContent).toMatch(/since (12 Sep|Sep 12)/);
    expect(rows[2]!.textContent).toMatch(/Overpaid ₹300\.00/);
  });

  it("links each row to that customer's page", async () => {
    renderAs("biller");
    expect((await screen.findByTestId("dues-row-c2")).closest("a")?.getAttribute("href")).toBe("/dues/c2");
  });

  it("filters by name, flat or mobile", async () => {
    renderAs("biller");
    fireEvent.change(await screen.findByTestId("dues-search"), { target: { value: "b-7" } });
    expect(screen.getAllByTestId(/^dues-row-/).map((r) => r.getAttribute("data-testid"))).toEqual(["dues-row-c2"]);
  });

  it("says nobody owes anything when the list is empty", async () => {
    loadDuesList.mockResolvedValue({ data: [], error: null });
    renderAs("biller");
    expect(await screen.findByText(/Nobody owes anything/)).toBeTruthy();
  });

  it("shows a load failure instead of an empty list", async () => {
    loadDuesList.mockResolvedValue({ data: null, error: { message: "Failed to fetch" } });
    renderAs("biller");
    expect(await screen.findByTestId("dues-problem")).toBeTruthy();
    expect(screen.queryByText(/Nobody owes anything/)).toBeNull();
  });

  it("never shows unassigned credit to a biller", async () => {
    loadUnassignedCredit.mockResolvedValue({ data: [{ bill_id: "b9", token_no: 4, completed_at: "2026-09-20T05:00:00Z", amount: 90 }], error: null });
    renderAs("biller");
    await screen.findByTestId("dues-total");
    expect(loadUnassignedCredit).not.toHaveBeenCalled();
    expect(screen.queryByTestId("dues-unassigned")).toBeNull();
  });

  it("shows an admin the unassigned credit and assigns a customer to a bill", async () => {
    loadUnassignedCredit.mockResolvedValue({ data: [{ bill_id: "b9", token_no: 4, completed_at: "2026-09-20T05:00:00Z", amount: 90 }], error: null });
    listCustomers.mockResolvedValue({ data: [{ id: "c1", name: "Asha", flat_no: "A-1", mobile: "9" }], error: null });
    assignCreditCustomer.mockResolvedValue({ error: null });
    renderAs("admin");
    fireEvent.click(await screen.findByTestId("dues-unassigned"));
    expect(screen.getByTestId("dues-unassigned")).toHaveProperty("textContent", expect.stringMatching(/\(1\).*90\.00/));
    fireEvent.click(screen.getByTestId("dues-assign-b9"));
    fireEvent.click(await screen.findByTestId("dues-assign-pick-c1"));
    await waitFor(() => expect(assignCreditCustomer).toHaveBeenCalledWith("b9", "c1"));
    await waitFor(() => expect(loadDuesList).toHaveBeenCalledTimes(2));
  });

  it("hides the unassigned row when there is none", async () => {
    renderAs("admin");
    await screen.findByTestId("dues-total");
    await waitFor(() => expect(loadUnassignedCredit).toHaveBeenCalled());
    expect(screen.queryByTestId("dues-unassigned")).toBeNull();
  });

  it("calls assignCreditCustomer once when a pick is tapped twice quickly", async () => {
    loadUnassignedCredit.mockResolvedValue({ data: [{ bill_id: "b9", token_no: 4, completed_at: "2026-09-20T05:00:00Z", amount: 90 }], error: null });
    listCustomers.mockResolvedValue({ data: [{ id: "c1", name: "Asha", flat_no: "A-1", mobile: "9" }], error: null });
    let resolveAssign: (v: { error: null }) => void = () => {};
    assignCreditCustomer.mockImplementation(() => new Promise((resolve) => { resolveAssign = resolve; }));
    renderAs("admin");
    fireEvent.click(await screen.findByTestId("dues-unassigned"));
    fireEvent.click(screen.getByTestId("dues-assign-b9"));
    const pick = await screen.findByTestId("dues-assign-pick-c1");
    fireEvent.click(pick);
    fireEvent.click(pick);
    resolveAssign({ error: null });
    await waitFor(() => expect(loadDuesList).toHaveBeenCalledTimes(2));
    expect(assignCreditCustomer).toHaveBeenCalledTimes(1);
  });
});
