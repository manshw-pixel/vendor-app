import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import type { TopItem, Pair } from "../history";

// collected_between returns ONE aggregate row, and `total` arrives as a string because
// PostgREST serialises Postgres numeric as text. The mock mirrors that exactly -- a mock
// returning a JS number would hide a missing Number() coercion in the screen.
const collectedBetween = vi.fn(async (..._a: unknown[]): Promise<{
  data: { total: string; bill_count: number }[] | null;
  error: { code?: string; message?: string } | null;
}> => ({ data: [{ total: "350.50", bill_count: 2 }], error: null }));
const topItemsBetween = vi.fn(async (..._a: unknown[]): Promise<{
  data: TopItem[] | null; error: null;
}> => ({
  data: [{
    item_id: "i1", name_en: "Onion", name_hi: "प्याज", name_mr: "कांदा",
    total_qty_kg: 12, total_revenue: 480,
  }],
  error: null,
}));
const pairsBetween = vi.fn(async (..._a: unknown[]): Promise<{ data: Pair[] | null; error: null }> =>
  ({ data: [{ item_a: "i1", item_b: "i2", name_a: "Onion", name_b: "Tomato", bill_count: 4 }], error: null }));

vi.mock("../history", async () => {
  const actual = await vi.importActual<typeof import("../history")>("../history");
  return {
    ...actual,
    collectedBetween: (...a: unknown[]) => collectedBetween(...a),
    topItemsBetween: (...a: unknown[]) => topItemsBetween(...a),
    pairsBetween: (...a: unknown[]) => pairsBetween(...a),
  };
});

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
    collectedBetween.mockResolvedValueOnce({ data: [{ total: "0", bill_count: 0 }], error: null });
    topItemsBetween.mockResolvedValueOnce({ data: [], error: null });
    pairsBetween.mockResolvedValueOnce({ data: [], error: null });
    render(<Dashboards />);
    expect((await screen.findAllByText(/nothing in this period|काहीही नाही|कुछ नहीं/i)).length)
      .toBeGreaterThan(0);
  });

  it("says it is loading rather than showing a confident zero", async () => {
    // Before the fetches land the cards would otherwise read "0.00", "0" and "Nothing in
    // this period" -- a wrong answer indistinguishable from a genuinely empty month.
    let release: (v: { data: { total: string; bill_count: number }[] | null; error: null }) => void = () => {};
    collectedBetween.mockImplementationOnce(() => new Promise((r) => { release = r; }));
    render(<Dashboards />);
    expect(screen.getByTestId("dash-loading")).toBeTruthy();
    release({ data: [{ total: "1", bill_count: 1 }], error: null });
    await waitFor(() => expect(screen.queryByTestId("dash-loading")).toBeNull());
  });

  it("ignores a slow response for a range the user has already moved off", async () => {
    // Tap "This month", then "Today" a beat later. The month query is the larger one and
    // resolves last; unguarded, it paints a month's totals under a Today filter.
    render(<Dashboards />);
    await screen.findByText(/350\.50/);   // the mount fetch settles first

    let releaseMonth: (v: { data: { total: string; bill_count: number }[] | null; error: null }) => void = () => {};
    collectedBetween
      .mockImplementationOnce(() => new Promise((r) => { releaseMonth = r; }))
      .mockResolvedValueOnce({ data: [{ total: "11", bill_count: 1 }], error: null });

    fireEvent.click(screen.getByTestId("range-month"));   // slow, deferred
    fireEvent.click(screen.getByTestId("range-today"));   // fast, wins
    await screen.findByText(/₹11\.00/);

    releaseMonth({ data: [{ total: "9999", bill_count: 999 }], error: null });
    await waitFor(() => expect(screen.queryByText(/9,999/)).toBeNull());
    expect(screen.getByText(/₹11\.00/)).toBeTruthy();
  });
});
