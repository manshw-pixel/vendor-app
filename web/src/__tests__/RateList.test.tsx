import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import i18n from "../i18n";
import type { ExtractedRow } from "../rateListMatch";

const readRateList = vi.fn();
const listAliases = vi.fn(async () => ({ data: [], error: null }));
const applyPriceList = vi.fn();

vi.mock("../rateListApi", () => ({
  readRateList: (...a: unknown[]) => readRateList(...a),
  listAliases: () => listAliases(),
  applyPriceList: (...a: unknown[]) => applyPriceList(...a),
  downscale: async () => ({ media_type: "image/jpeg", data: "QUJD" }),
}));

vi.mock("../admin", () => ({
  listAllItems: async () => ({
    data: [
      { id: "onion", name_en: "Onion", name_hi: "प्याज", name_mr: "कांदा", price: 40, stock_kg: 5,
        is_active: true, last_cost: null, unit: "kg", low_stock_at: 10, sold: false },
      { id: "banana", name_en: "Banana", name_hi: "केला", name_mr: "केळी", price: 60, stock_kg: 5,
        is_active: true, last_cost: null, unit: "dozen", low_stock_at: 10, sold: false },
    ],
    error: null,
  }),
}));

let role = "admin";
vi.mock("../components/SessionProvider", () => ({
  useSession: () => ({ kind: "ready", userId: "u1", vendorId: "v1", vendorName: "Shop", name: "A", role }),
}));

const { default: RateList } = await import("../screens/RateList");

const row = (o: Partial<ExtractedRow>): ExtractedRow => ({
  name_as_written: "Onion", sold_by_as_written: "1 kg", price: 44,
  name_en: "Onion", name_hi: "प्याज", name_mr: "कांदा", confidence: "high", ...o,
});
const onion = row({});
const box = row({ name_as_written: "Mango", sold_by_as_written: "1 box", price: 500,
  name_en: "Mango", name_hi: "आम", name_mr: "आंबा" });

async function readWith(rows: ExtractedRow[]) {
  readRateList.mockResolvedValue({ rows, error: null });
  fireEvent.change(screen.getByTestId("rate-list-file"),
    { target: { files: [new File(["x"], "a.jpg", { type: "image/jpeg" })] } });
  fireEvent.click(screen.getByTestId("rate-list-read"));
  await screen.findByTestId("rate-row-0");
}

const renderIt = () => render(<MemoryRouter><RateList /></MemoryRouter>);

beforeEach(async () => {
  vi.clearAllMocks();
  role = "admin";
  await i18n.changeLanguage("en");
  applyPriceList.mockResolvedValue({
    data: {
      updated: [{ item_id: "onion", name_en: "Onion", name_hi: "प्याज", name_mr: "कांदा", unit: "kg",
        old_price: "40", new_price: "44" }],
      created: [{ item_id: "m", name_en: "Mango", name_hi: "आम", name_mr: "आंबा", unit: "piece", price: "500" }],
      unchanged: 0,
    },
    error: null,
  });
});

describe("the rate-list screen", () => {
  it("sends a changed price as an update", async () => {
    renderIt();
    await readWith([onion]);
    expect(screen.getByTestId("rate-row-0").textContent).toContain("₹40.00");
    expect((screen.getByTestId("rate-price-0") as HTMLInputElement).value).toBe("44");
    fireEvent.click(screen.getByTestId("rate-review"));
    fireEvent.click(screen.getByTestId("rate-apply"));
    await waitFor(() => expect(applyPriceList).toHaveBeenCalled());
    expect(applyPriceList.mock.calls[0]?.[0]).toEqual([{ kind: "update", item_id: "onion", price: 44 }]);
  });

  it("sends a new line as a create with the normalised unit", async () => {
    renderIt();
    await readWith([box]);
    expect((screen.getByTestId("rate-name-en-0") as HTMLInputElement).value).toBe("Mango");
    expect((screen.getByTestId("rate-name-hi-0") as HTMLInputElement).value).toBe("आम");
    expect((screen.getByTestId("rate-name-mr-0") as HTMLInputElement).value).toBe("आंबा");
    fireEvent.click(screen.getByTestId("rate-review"));
    fireEvent.click(screen.getByTestId("rate-apply"));
    await waitFor(() => expect(applyPriceList).toHaveBeenCalled());
    const sent = applyPriceList.mock.calls[0]?.[0] as { kind: string; unit: string }[];
    expect(sent[0]).toMatchObject({ kind: "create", unit: "piece" });
  });

  it("blocks review when a new item lacks a name", async () => {
    renderIt();
    await readWith([box]);
    fireEvent.change(screen.getByTestId("rate-name-hi-0"), { target: { value: "" } });
    expect((screen.getByTestId("rate-review") as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText("A new item needs all three names.")).toBeTruthy();
  });

  it("leaves a unit mismatch unticked until a price is typed", async () => {
    renderIt();
    await readWith([row({ name_as_written: "Banana", name_en: "Banana", name_hi: "केला", name_mr: "केळी",
      sold_by_as_written: "1 pc", price: 5 })]);
    const tick = screen.getByTestId("rate-include-0") as HTMLInputElement;
    expect(tick.checked).toBe(false);
    fireEvent.change(screen.getByTestId("rate-price-0"), { target: { value: "65" } });
    expect((screen.getByTestId("rate-include-0") as HTMLInputElement).checked).toBe(true);
  });

  it("returns to the picker when no rows are read", async () => {
    renderIt();
    readRateList.mockResolvedValue({ rows: [], error: null });
    fireEvent.change(screen.getByTestId("rate-list-file"),
      { target: { files: [new File(["x"], "a.jpg", { type: "image/jpeg" })] } });
    fireEvent.click(screen.getByTestId("rate-list-read"));
    expect(await screen.findByText("No prices found in this photo.")).toBeTruthy();
    expect(screen.getByTestId("rate-list-file")).toBeTruthy();
  });

  it("confirms before writing, and Back keeps edits", async () => {
    renderIt();
    await readWith([onion, box]);
    fireEvent.change(screen.getByTestId("rate-price-0"), { target: { value: "45" } });
    fireEvent.click(screen.getByTestId("rate-review"));
    expect(screen.getByText("These changes will be made")).toBeTruthy();
    expect(screen.getByTestId("rate-confirm-updates").textContent).toMatch(/Onion.*₹40\.00.*₹45\.00/);
    expect(screen.getByTestId("rate-confirm-creates").textContent).toContain("Mango");
    expect(applyPriceList).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId("rate-confirm-back"));
    expect((screen.getByTestId("rate-price-0") as HTMLInputElement).value).toBe("45");
    expect(applyPriceList).not.toHaveBeenCalled();
  });

  it("shows the result after applying, and can start again", async () => {
    renderIt();
    await readWith([onion, box]);
    fireEvent.click(screen.getByTestId("rate-review"));
    fireEvent.click(screen.getByTestId("rate-apply"));
    expect(await screen.findByText("Changes completed")).toBeTruthy();
    expect(screen.getByTestId("rate-result-updated").textContent).toMatch(/Onion.*₹40\.00.*₹44\.00/);
    expect(screen.getByTestId("rate-result-created").textContent).toContain("Mango");
    fireEvent.click(screen.getByText("Update another list"));
    expect(screen.getByTestId("rate-list-file")).toBeTruthy();
  });

  it("renders nothing for a biller", () => {
    role = "biller";
    const { container } = renderIt();
    expect(container.innerHTML).toBe("");
  });
});
