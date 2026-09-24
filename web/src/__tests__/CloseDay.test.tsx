import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import i18n from "../i18n";
import type { DaySummary } from "../dayClose";
import type { CloseRow } from "../closeRules";

const SUMMARY: DaySummary = {
  business_date: "2026-09-23",
  split: {
    cash: { total: 1200, count: 6 }, upi: { total: 800, count: 4 }, card: { total: 0, count: 0 },
    credit: { total: 150, count: 1 }, unrecorded: { total: 0, count: 0 },
  },
  expected_cash: 1200,
  pending_tokens: 2,
  dues: { cash: { total: 0, count: 0 }, upi: { total: 0, count: 0 }, card: { total: 0, count: 0 } },
  creditOpen: { total: 150, count: 1 },
};

const loadDaySummary = vi.fn();
const closeDay = vi.fn();
const reopenDay = vi.fn();
const loadRecentCloses = vi.fn();
const loadUnclosedDays = vi.fn();
const notifyDayClosesChanged = vi.fn();
vi.mock("../dayClose", () => ({
  loadDaySummary: (...a: unknown[]) => loadDaySummary(...a),
  closeDay: (...a: unknown[]) => closeDay(...a),
  reopenDay: (...a: unknown[]) => reopenDay(...a),
  loadRecentCloses: (...a: unknown[]) => loadRecentCloses(...a),
  loadUnclosedDays: (...a: unknown[]) => loadUnclosedDays(...a),
  notifyDayClosesChanged: () => notifyDayClosesChanged(),
}));

let role: "admin" | "biller" = "biller";
vi.mock("../components/SessionProvider", () => ({
  useSession: () => ({ kind: "ready", userId: "u1", vendorId: "v1", vendorName: "V", name: "S", role }),
}));

const { default: CloseDay } = await import("../screens/CloseDay");

const closedRow = (extra: Partial<CloseRow> = {}): CloseRow => ({
  id: "c1", business_date: "2026-09-23", expected_cash: 1200, counted_cash: 1200, difference: 0,
  note: null, closed_at: "2026-09-23T14:42:00Z", reopened_at: null, reopen_reason: null, closer: "Sunil",
  ...extra,
});

function renderAs(r: "admin" | "biller") {
  role = r;
  return render(<MemoryRouter><CloseDay /></MemoryRouter>);
}

beforeEach(async () => {
  vi.clearAllMocks();
  await i18n.changeLanguage("en");
  loadDaySummary.mockResolvedValue({ data: SUMMARY, error: null });
  loadRecentCloses.mockResolvedValue({ data: [], error: null });
  loadUnclosedDays.mockResolvedValue({ data: [], error: null });
  closeDay.mockResolvedValue({ data: {}, error: null });
  reopenDay.mockResolvedValue({ data: {}, error: null });
});

describe("Close day", () => {
  it("shows the split, expected cash and carried-over tokens", async () => {
    renderAs("biller");
    expect((await screen.findByTestId("close-expected")).textContent).toMatch(/1,200\.00/);
    expect(screen.getByTestId("close-split-upi").textContent).toMatch(/800\.00/);
    expect(screen.getByTestId("close-split-credit").textContent).toMatch(/not yet collected/i);
    expect(screen.queryByTestId("close-split-unrecorded")).toBeNull();
    expect(screen.getByTestId("close-carried").textContent).toMatch(/2/);
  });

  it("closes at zero difference without a note, after confirming", async () => {
    renderAs("biller");
    fireEvent.change(await screen.findByTestId("close-counted"), { target: { value: "1200" } });
    expect(screen.getByTestId("close-difference").className).toMatch(/green/);
    fireEvent.click(screen.getByTestId("close-submit"));
    fireEvent.click(screen.getByTestId("close-confirm"));
    await waitFor(() => expect(closeDay).toHaveBeenCalledWith("2026-09-23", 1200, ""));
    expect(notifyDayClosesChanged).toHaveBeenCalled();
  });

  it("needs a note when the cash does not match", async () => {
    renderAs("biller");
    fireEvent.change(await screen.findByTestId("close-counted"), { target: { value: "1190" } });
    expect(screen.getByTestId("close-difference").className).toMatch(/amber/);
    expect(screen.getByTestId("close-difference").textContent).toMatch(/-.*10\.00|10\.00/);
    expect(screen.getByTestId("close-submit")).toHaveProperty("disabled", true);
    fireEvent.change(screen.getByTestId("close-note"), { target: { value: "change given" } });
    expect(screen.getByTestId("close-submit")).toHaveProperty("disabled", false);
  });

  it("refuses an amount it cannot read", async () => {
    renderAs("biller");
    fireEvent.change(await screen.findByTestId("close-counted"), { target: { value: "12.345" } });
    expect(screen.getByTestId("close-submit")).toHaveProperty("disabled", true);
    expect(screen.getByTestId("close-bad-cash")).toBeTruthy();
  });

  it("shows a closed day's status and no form", async () => {
    loadRecentCloses.mockResolvedValue({ data: [closedRow()], error: null });
    renderAs("biller");
    expect((await screen.findByTestId("close-status")).textContent).toMatch(/Sunil/);
    expect(screen.queryByTestId("close-counted")).toBeNull();
  });

  it("offers Reopen to an admin only, and requires a reason", async () => {
    loadRecentCloses.mockResolvedValue({ data: [closedRow()], error: null });
    renderAs("biller");
    await screen.findByTestId("close-status");
    expect(screen.queryByTestId("close-reopen-2026-09-23")).toBeNull();

    renderAs("admin");
    fireEvent.click((await screen.findAllByTestId("close-reopen-2026-09-23"))[0]!);
    expect(screen.getByTestId("close-reopen-accept")).toHaveProperty("disabled", true);
    fireEvent.change(screen.getByTestId("close-reopen-reason"), { target: { value: "late sale" } });
    fireEvent.click(screen.getByTestId("close-reopen-accept"));
    await waitFor(() => expect(reopenDay).toHaveBeenCalledWith("2026-09-23", "late sale"));
  });

  it("loads a past unclosed day into the panel", async () => {
    loadUnclosedDays.mockResolvedValue({ data: ["2026-09-22"], error: null });
    renderAs("biller");
    fireEvent.click(await screen.findByTestId("close-pick-2026-09-22"));
    await waitFor(() => expect(loadDaySummary).toHaveBeenLastCalledWith("2026-09-22"));
  });

  it("disables day-switching while a close is in flight, and reloads whatever is selected when it finishes", async () => {
    loadUnclosedDays.mockResolvedValue({ data: ["2026-09-22"], error: null });
    let resolveClose!: (v: { data: unknown; error: null }) => void;
    closeDay.mockReturnValue(new Promise((resolve) => { resolveClose = resolve; }));
    renderAs("biller");

    fireEvent.change(await screen.findByTestId("close-counted"), { target: { value: "1200" } });
    fireEvent.click(screen.getByTestId("close-submit"));
    fireEvent.click(screen.getByTestId("close-confirm"));

    // The close RPC is still pending: the day-switching controls must not let the user
    // move to another day while it resolves, or its trailing reload would repaint the
    // wrong day.
    await waitFor(() => expect(screen.getByTestId("close-pick-2026-09-22")).toHaveProperty("disabled", true));

    loadDaySummary.mockClear();
    resolveClose({ data: {}, error: null });
    await waitFor(() => expect(notifyDayClosesChanged).toHaveBeenCalled());
    // The trailing reload after a close must ask for the date actually selected when the
    // RPC resolved (today, since switching was disabled throughout), not a stale closure.
    await waitFor(() => expect(loadDaySummary).toHaveBeenCalledWith(undefined));
  });

  it("shows a loading state rather than a blank screen when the load has no summary yet", async () => {
    loadDaySummary.mockResolvedValue({ data: null, error: null });
    renderAs("biller");
    expect(await screen.findByTestId("close-loading")).toBeTruthy();
    expect(screen.queryByTestId("close-expected")).toBeNull();
  });

  it("explains an already-closed refusal", async () => {
    closeDay.mockResolvedValue({ data: null, error: { message: "day already closed", code: "P0001" } });
    renderAs("biller");
    fireEvent.change(await screen.findByTestId("close-counted"), { target: { value: "1200" } });
    fireEvent.click(screen.getByTestId("close-submit"));
    fireEvent.click(screen.getByTestId("close-confirm"));
    // findAll: the raw detail ("day already closed") is rendered beside the message too.
    expect((await screen.findAllByText(/already closed/i)).length).toBeGreaterThan(0);
  });
  it("after a refused close, shows why and reloads the summary, keeping what was typed", async () => {
    // close_day recomputes expected cash on the server. A sale since this screen loaded
    // makes the count differ; with no note the server refuses. The screen must say so and
    // show the fresh expected figure, or every retry fails the same way.
    closeDay.mockResolvedValue({
      data: null, error: { message: "a note is required when the cash does not match", code: "22023" },
    });
    renderAs("biller");
    fireEvent.change(await screen.findByTestId("close-counted"), { target: { value: "1200" } });
    loadDaySummary.mockClear();
    loadDaySummary.mockResolvedValue({ data: { ...SUMMARY, expected_cash: 1350 }, error: null });
    fireEvent.click(screen.getByTestId("close-submit"));
    fireEvent.click(screen.getByTestId("close-confirm"));

    expect(await screen.findByText(i18n.t("close.cashChanged"))).toBeTruthy();
    expect(loadDaySummary).toHaveBeenCalledWith(undefined);
    await waitFor(() => expect(screen.getByTestId("close-expected").textContent).toMatch(/1,350\.00/));
    expect(screen.getByTestId("close-counted")).toHaveProperty("value", "1200");
    expect(screen.getByTestId("close-difference").textContent).toMatch(/150\.00/);
    // The reload must not wipe the refusal it was triggered by.
    expect(screen.getByText(i18n.t("close.cashChanged"))).toBeTruthy();
  });

  it("keeps the typed note when a close is refused", async () => {
    closeDay.mockResolvedValue({ data: null, error: { message: "day already closed", code: "P0001" } });
    renderAs("biller");
    fireEvent.change(await screen.findByTestId("close-counted"), { target: { value: "1190" } });
    fireEvent.change(screen.getByTestId("close-note"), { target: { value: "change given" } });
    loadDaySummary.mockClear();
    fireEvent.click(screen.getByTestId("close-submit"));
    fireEvent.click(screen.getByTestId("close-confirm"));
    await waitFor(() => expect(loadDaySummary).toHaveBeenCalledWith(undefined));
    expect(screen.getByTestId("close-note")).toHaveProperty("value", "change given");
    expect(screen.getByTestId("close-counted")).toHaveProperty("value", "1190");
  });

  it("merges dues into the mode lines, with a note, and keeps the cash breakdown", async () => {
    loadDaySummary.mockResolvedValue({ data: {
      ...SUMMARY, expected_cash: 1500,
      dues: { cash: { total: 300, count: 2 }, upi: { total: 100, count: 1 }, card: { total: 0, count: 0 } },
    }, error: null });
    renderAs("biller");
    const cash = (await screen.findByTestId("close-split-cash")).textContent ?? "";
    expect(cash).toMatch(/1,500\.00/);                       // 1200 sales + 300 dues
    expect(cash).toMatch(/6 bills, 2 payments/);
    expect(screen.getByTestId("close-incl-cash").textContent).toMatch(/incl\..*300\.00.*dues/);
    expect(screen.getByTestId("close-split-upi").textContent).toMatch(/900\.00/);
    expect(screen.queryByTestId("close-incl-card")).toBeNull();
    expect(screen.queryByTestId("close-dues-cash")).toBeNull();
    const breakdown = screen.getByTestId("close-expected-breakdown").textContent ?? "";
    expect(breakdown).toMatch(/Cash sales.*1,200\.00/);
    expect(breakdown).toMatch(/Dues received in cash.*300\.00/);
  });

  it("shows credit still uncollected, not credit given", async () => {
    loadDaySummary.mockResolvedValue({ data: {
      ...SUMMARY, split: { ...SUMMARY.split, credit: { total: 500, count: 3 } }, creditOpen: { total: 0, count: 0 },
    }, error: null });
    renderAs("biller");
    const credit = (await screen.findByTestId("close-split-credit")).textContent ?? "";
    expect(credit).toMatch(/0\.00/);
    expect(credit).not.toMatch(/500\.00/);
    expect(credit).toMatch(/not yet collected/i);
  });

  it("shows no breakdown on a day with no dues received", async () => {
    renderAs("biller");
    await screen.findByTestId("close-expected");
    expect(screen.queryByTestId("close-expected-breakdown")).toBeNull();
  });
});
