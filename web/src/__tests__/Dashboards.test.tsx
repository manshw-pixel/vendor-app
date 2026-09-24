import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import type { TopItem, Pair, RequestCount, Voided } from "../history";
import i18n from "../i18n";

// collected_between returns ONE aggregate row, and `total` arrives as a string because
// PostgREST serialises Postgres numeric as text. The mock mirrors that exactly -- a mock
// returning a JS number would hide a missing Number() coercion in the screen.
const collectedBetween = vi.fn(async (..._a: unknown[]): Promise<{
  data: { total: string; bill_count: number; cost: string; profit: string; uncosted_lines: string }[] | null;
  error: { code?: string; message?: string } | null;
}> => ({ data: [{ total: "350.50", bill_count: 2, cost: "200.00", profit: "150.50", uncosted_lines: "0" }], error: null }));
const topItemsBetween = vi.fn(async (..._a: unknown[]): Promise<{
  data: TopItem[] | null; error: null;
}> => ({
  data: [{
    item_id: "i1", name_en: "Onion", name_hi: "प्याज", name_mr: "कांदा", unit: "kg",
    total_qty_kg: 12, total_revenue: 480, total_cost: "300.00", margin: "180.00", uncosted_lines: "0",
  }],
  error: null,
}));
const pairsBetween = vi.fn(async (..._a: unknown[]): Promise<{ data: Pair[] | null; error: null }> =>
  ({
    data: [{
      item_a: "i1", item_b: "i2",
      name_a_en: "Onion", name_a_hi: "प्याज", name_a_mr: "कांदा",
      name_b_en: "Tomato", name_b_hi: "टमाटर", name_b_mr: "टोमॅटो",
      bill_count: 4,
    }],
    error: null,
  }));
const requestsBetween = vi.fn(async (..._a: unknown[]): Promise<{
  data: RequestCount[] | null; error: null;
}> => ({ data: [], error: null }));
const voidedBetween = vi.fn(async (..._a: unknown[]): Promise<{
  data: Voided[] | null;
  error: { code?: string; message?: string } | null;
}> => ({ data: [{ void_count: "0", voided_total: "0" }], error: null }));
const paymentSplitBetween = vi.fn(async (..._a: unknown[]): Promise<{
  data: { mode: string; total: string; bill_count: string }[] | null;
  error: { code?: string; message?: string } | null;
}> => ({ data: [
  { mode: "cash", total: "200.00", bill_count: "1" },
  { mode: "credit", total: "40.00", bill_count: "1" },
  { mode: "credit_open", total: "40.00", bill_count: "1" },
  { mode: "upi", total: "110.50", bill_count: "1" },
], error: null }));

vi.mock("../history", async () => {
  const actual = await vi.importActual<typeof import("../history")>("../history");
  return {
    ...actual,
    collectedBetween: (...a: unknown[]) => collectedBetween(...a),
    topItemsBetween: (...a: unknown[]) => topItemsBetween(...a),
    pairsBetween: (...a: unknown[]) => pairsBetween(...a),
    requestsBetween: (...a: unknown[]) => requestsBetween(...a),
    voidedBetween: (...a: unknown[]) => voidedBetween(...a),
    paymentSplitBetween: (...a: unknown[]) => paymentSplitBetween(...a),
  };
});

function stubPairs(data: Pair[]) {
  pairsBetween.mockResolvedValueOnce({ data, error: null });
}
function stubRequests(data: RequestCount[]) {
  requestsBetween.mockResolvedValueOnce({ data, error: null });
}

const loadDuesList = vi.fn(async (..._a: unknown[]) => ({
  data: [
    { customer_id: "c1", name: "A", flat_no: "1", mobile: "9", balance: 1000, oldest_unpaid: "2026-09-01" },
    { customer_id: "c2", name: "B", flat_no: "2", mobile: "8", balance: 240.5, oldest_unpaid: "2026-09-10" },
    { customer_id: "c3", name: "C", flat_no: "3", mobile: "7", balance: -50, oldest_unpaid: null },
  ],
  error: null as { message?: string; code?: string } | null,
}));
vi.mock("../dues", () => ({ loadDuesList: (...a: unknown[]) => loadDuesList(...a) }));

const { default: Dashboards } = await import("../screens/Dashboards");

beforeEach(() => vi.clearAllMocks());

describe("the dashboard", () => {
  it("totals the collected money through rupees()", async () => {
    render(<Dashboards />);
    expect(await screen.findByText(/₹350\.50/)).toBeTruthy();
  });

  it("counts the completed bills", async () => {
    render(<Dashboards />);
    expect((await screen.findByTestId("dash-bill-count")).textContent).toContain("2");
  });

  it("lists top items", async () => {
    render(<Dashboards />);
    // Scoped to the top-items row: the pairs mock also names an item "Onion", and a
    // bare findByText(/Onion|.../) is ambiguous between the two sections once both
    // render (jsdom resolves the test language to "en", not "mr" -- see
    // i18n-init.test.ts -- so itemName() renders the literal English name here too).
    const row = await screen.findByTestId("dash-top-i1");
    expect(within(row).getByText(/Onion|कांदा|प्याज/)).toBeTruthy();
  });

  it("names the top item's quantity in its own unit", async () => {
    topItemsBetween.mockResolvedValueOnce({
      data: [{ item_id: "i2", name_en: "Lemon", name_hi: "नींबू", name_mr: "लिंबू", unit: "piece",
               total_qty_kg: 4, total_revenue: 400, total_cost: "0", margin: "0", uncosted_lines: "0" }],
      error: null });
    render(<Dashboards />);
    const row = await screen.findByTestId("dash-top-i2");
    expect(within(row).getByText(/4 pcs/)).toBeTruthy();
    expect(within(row).getByText(/₹400\.00/)).toBeTruthy();
  });

  it("lists bought-together pairs", async () => {
    render(<Dashboards />);
    expect(await screen.findByTestId("dash-pair-i1-i2")).toBeTruthy();
  });

  it("refetches every card when the range changes", async () => {
    // The whole point of 0007: the filter must reach the analytics cards too, not just
    // the money. A filter governing half a screen is worse than none.
    render(<Dashboards />);
    await screen.findByTestId("dash-bill-count");
    fireEvent.click(screen.getByTestId("range-month"));
    await waitFor(() => {
      expect(collectedBetween).toHaveBeenCalledTimes(2);
      expect(topItemsBetween).toHaveBeenCalledTimes(2);
      expect(pairsBetween).toHaveBeenCalledTimes(2);
    });
  });

  it("says nothing in this period rather than showing an error", async () => {
    collectedBetween.mockResolvedValueOnce({
      data: [{ total: "0", bill_count: 0, cost: "0", profit: "0", uncosted_lines: "0" }], error: null });
    topItemsBetween.mockResolvedValueOnce({ data: [], error: null });
    pairsBetween.mockResolvedValueOnce({ data: [], error: null });
    render(<Dashboards />);
    expect((await screen.findAllByText(/nothing in this period|काहीही नाही|कुछ नहीं/i)).length)
      .toBeGreaterThan(0);
  });

  it("says it is loading rather than showing a confident zero", async () => {
    // Before the fetches land the cards would otherwise read "0.00", "0" and "Nothing in
    // this period" -- a wrong answer indistinguishable from a genuinely empty month.
    let release: (v: {
      data: { total: string; bill_count: number; cost: string; profit: string; uncosted_lines: string }[] | null;
      error: null;
    }) => void = () => {};
    collectedBetween.mockImplementationOnce(() => new Promise((r) => { release = r; }));
    render(<Dashboards />);
    expect(screen.getByTestId("dash-loading")).toBeTruthy();
    release({ data: [{ total: "1", bill_count: 1, cost: "0", profit: "1", uncosted_lines: "0" }], error: null });
    await waitFor(() => expect(screen.queryByTestId("dash-loading")).toBeNull());
  });

  it("ignores a slow response for a range the user has already moved off", async () => {
    // Tap "This month", then "Today" a beat later. The month query is the larger one and
    // resolves last; unguarded, it paints a month's totals under a Today filter.
    render(<Dashboards />);
    await screen.findByText(/350\.50/);   // the mount fetch settles first

    let releaseMonth: (v: {
      data: { total: string; bill_count: number; cost: string; profit: string; uncosted_lines: string }[] | null;
      error: null;
    }) => void = () => {};
    collectedBetween
      .mockImplementationOnce(() => new Promise((r) => { releaseMonth = r; }))
      .mockResolvedValueOnce({
        data: [{ total: "11", bill_count: 1, cost: "3", profit: "8", uncosted_lines: "0" }], error: null });

    fireEvent.click(screen.getByTestId("range-month"));   // slow, deferred
    fireEvent.click(screen.getByTestId("range-today"));   // fast, wins
    await screen.findByText(/₹11\.00/);

    releaseMonth({
      data: [{ total: "9999", bill_count: 999, cost: "0", profit: "9999", uncosted_lines: "0" }], error: null });
    await waitFor(() => expect(screen.queryByText(/9,999/)).toBeNull());
    expect(screen.getByText(/₹11\.00/)).toBeTruthy();
  });

  it("shows the underlying message instead of discarding it", async () => {
    // The screen had PostgREST's own words -- "Could not find the function
    // public.collected_between" -- and rendered only "Something went wrong", so the one
    // string that identified the cause never reached the person who could act on it.
    collectedBetween.mockResolvedValueOnce({
      data: null,
      error: {
        code: "PGRST202",
        message: "Could not find the function public.collected_between(p_from, p_to) in the schema cache",
      },
    });
    render(<Dashboards />);
    expect(await screen.findByTestId("dash-problem-detail")).toBeTruthy();
    expect(screen.getByTestId("dash-problem-detail").textContent).toContain("collected_between");
  });

  it("renders pair names in the active language", async () => {
    // The regression this fixes: bought_together_between used to return only name_en, so
    // a Marathi admin saw Marathi in Top Items and English in the card directly below.
    await i18n.changeLanguage("mr");
    stubPairs([{
      item_a: "a1", item_b: "b1",
      name_a_en: "Onion", name_a_hi: "प्याज", name_a_mr: "कांदा",
      name_b_en: "Tomato", name_b_hi: "टमाटर", name_b_mr: "टोमॅटो",
      bill_count: 4,
    }]);

    render(<Dashboards />);
    const row = await screen.findByTestId("dash-pair-a1-b1");
    expect(row.textContent).toContain("कांदा");
    expect(row.textContent).toContain("टोमॅटो");
    expect(row.textContent).not.toContain("Onion");
    await i18n.changeLanguage("en");
  });

  it("shows cost and profit through rupees()", async () => {
    render(<Dashboards />);
    expect((await screen.findByTestId("dash-cost")).textContent).toContain("₹200.00");
    expect((await screen.findByTestId("dash-profit")).textContent).toContain("₹150.50");
  });

  it("says how many lines had no purchase cost", async () => {
    collectedBetween.mockResolvedValueOnce({
      data: [{ total: "100", bill_count: 1, cost: "0", profit: "100", uncosted_lines: "3" }], error: null });
    render(<Dashboards />);
    expect((await screen.findByTestId("dash-uncosted")).textContent).toContain("3");
  });

  it("hides the uncosted note when every line had a cost", async () => {
    render(<Dashboards />);
    await screen.findByTestId("dash-profit");
    expect(screen.queryByTestId("dash-uncosted")).toBeNull();
  });

  it("shows each top item's margin", async () => {
    render(<Dashboards />);
    const row = await screen.findByTestId("dash-top-i1");
    expect(row.textContent).toContain("₹180.00");
  });

  it("shows a dash for a top item whose margin is unknown", async () => {
    topItemsBetween.mockResolvedValueOnce({
      data: [{ item_id: "i1", name_en: "Onion", name_hi: "प्याज", name_mr: "कांदा", unit: "kg",
               total_qty_kg: 12, total_revenue: 480, total_cost: null, margin: null, uncosted_lines: "4" }],
      error: null });
    render(<Dashboards />);
    const margin = await screen.findByTestId("dash-top-margin-i1");
    expect(margin.textContent).toBe("—");
  });

  it("lists what customers asked for that the shop does not stock", async () => {
    stubRequests([
      { item_name: "dragon fruit", request_count: 11, last_requested_at: "2026-09-15T10:00:00Z" },
      { item_name: "kiwi", request_count: 3, last_requested_at: "2026-09-14T10:00:00Z" },
    ]);

    render(<Dashboards />);
    const card = await screen.findByTestId("dash-req-dragon fruit");
    expect(card.textContent).toContain("dragon fruit");
    expect(card.textContent).toContain("11");
  });

  it("hides the voided line when nothing was voided", async () => {
    render(<Dashboards />);
    await screen.findByTestId("dash-bill-count");
    expect(screen.queryByTestId("dash-voided")).toBeNull();
  });

  it("shows how many bills were voided and for how much", async () => {
    voidedBetween.mockResolvedValueOnce({
      data: [{ void_count: "2", voided_total: "450.00" }], error: null });
    render(<Dashboards />);
    const line = await screen.findByTestId("dash-voided");
    expect(line.textContent).toContain("2");
    expect(line.textContent).toContain("₹450.00");
  });

  it("surfaces an error from voidedBetween like the other cards", async () => {
    voidedBetween.mockResolvedValueOnce({
      data: null,
      error: {
        code: "PGRST202",
        message: "Could not find the function public.voided_between(p_from, p_to) in the schema cache",
      },
    });
    render(<Dashboards />);
    expect(await screen.findByTestId("dash-problem-detail")).toBeTruthy();
    expect(screen.getByTestId("dash-problem-detail").textContent).toContain("voided_between");
  });

  it("splits the money collected by payment mode", async () => {
    render(<Dashboards />);
    expect((await screen.findByTestId("dash-split-cash")).textContent).toMatch(/200\.00/);
    expect(screen.getByTestId("dash-split-upi").textContent).toMatch(/110\.50/);
    expect(screen.getByTestId("dash-split-card").textContent).toMatch(/0\.00/);
    expect(screen.getByTestId("dash-split-credit").textContent).toMatch(/40\.00/);
    expect(screen.queryByTestId("dash-split-unrecorded")).toBeNull();
    expect(screen.getByTestId("dash-split-note").textContent)
      .toBe("Includes dues received; credit shows what is still unpaid");
  });

  it("shows Not recorded only when there are such bills", async () => {
    paymentSplitBetween.mockResolvedValueOnce({
      data: [{ mode: "unrecorded", total: "90.00", bill_count: "2" }], error: null,
    });
    render(<Dashboards />);
    expect((await screen.findByTestId("dash-split-unrecorded")).textContent).toMatch(/90\.00/);
  });

  it("shows outstanding dues: what is owed and by how many customers", async () => {
    render(<Dashboards />);
    const card = await screen.findByTestId("dash-dues");
    await waitFor(() => expect(card.textContent).toMatch(/1,240\.50/));
    expect(card.textContent).toMatch(/2 customers/);
  });

  it("reads outstanding dues once, not on every range change", async () => {
    render(<Dashboards />);
    await screen.findByTestId("dash-dues");
    fireEvent.click(screen.getByTestId("range-today"));
    await waitFor(() => expect(collectedBetween).toHaveBeenCalledTimes(2));
    expect(loadDuesList).toHaveBeenCalledTimes(1);
  });

  it("merges dues into the split and shows credit still uncollected", async () => {
    paymentSplitBetween.mockResolvedValueOnce({ data: [
      { mode: "cash", total: "200.00", bill_count: "1" },
      { mode: "credit", total: "40.00", bill_count: "1" },
      { mode: "credit_open", total: "10.00", bill_count: "1" },
      { mode: "dues_cash", total: "30.00", bill_count: "1" },
      { mode: "upi", total: "110.50", bill_count: "1" },
    ], error: null });
    render(<Dashboards />);
    await waitFor(() => expect(screen.getByTestId("dash-split-cash").textContent).toMatch(/230\.00/));
    expect(screen.getByTestId("dash-incl-cash").textContent).toMatch(/30\.00/);
    expect(screen.getByTestId("dash-split-credit").textContent).toMatch(/10\.00/);
    expect(screen.getByTestId("dash-split-credit").textContent).not.toMatch(/40\.00/);
    expect(screen.getByTestId("dash-split-upi").textContent).toMatch(/110\.50/);
    expect(screen.queryByTestId("dash-incl-upi")).toBeNull();
  });
});
