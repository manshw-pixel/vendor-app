import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import i18n from "../i18n";

const loadUnclosedDays = vi.fn();
vi.mock("../dayClose", () => ({
  loadUnclosedDays: (...a: unknown[]) => loadUnclosedDays(...a),
  DAY_CLOSES_CHANGED: "day-closes-changed",
}));

const { UnclosedBanner } = await import("../components/UnclosedBanner");

const renderAs = (role: "admin" | "biller" | "recorder") =>
  render(<MemoryRouter><UnclosedBanner role={role} /></MemoryRouter>);

beforeEach(async () => {
  vi.clearAllMocks();
  await i18n.changeLanguage("en");
  loadUnclosedDays.mockResolvedValue({ data: ["2026-09-22"], error: null });
});

describe("UnclosedBanner", () => {
  it("names the unclosed day and links to the close screen", async () => {
    renderAs("biller");
    const banner = await screen.findByTestId("unclosed-banner");
    expect(banner.textContent).toMatch(/22/);
    expect(screen.getByRole("link").getAttribute("href")).toBe("/close");
  });

  it("names the oldest day and counts the rest", async () => {
    loadUnclosedDays.mockResolvedValue({ data: ["2026-09-22", "2026-09-21", "2026-09-20"], error: null });
    renderAs("admin");
    const banner = await screen.findByTestId("unclosed-banner");
    expect(banner.textContent).toMatch(/20/);
    expect(banner.textContent).toMatch(/2 more/);
  });

  it("never shows, or even asks, for a recorder", async () => {
    renderAs("recorder");
    await new Promise((r) => setTimeout(r, 0));
    expect(loadUnclosedDays).not.toHaveBeenCalled();
    expect(screen.queryByTestId("unclosed-banner")).toBeNull();
  });

  it("shows nothing when every day is closed or the read fails", async () => {
    loadUnclosedDays.mockResolvedValue({ data: null, error: { message: "boom" } });
    renderAs("admin");
    await waitFor(() => expect(loadUnclosedDays).toHaveBeenCalled());
    expect(screen.queryByTestId("unclosed-banner")).toBeNull();
  });

  it("re-reads when a day is closed", async () => {
    renderAs("biller");
    await screen.findByTestId("unclosed-banner");
    loadUnclosedDays.mockResolvedValue({ data: [], error: null });
    act(() => { window.dispatchEvent(new Event("day-closes-changed")); });
    await waitFor(() => expect(screen.queryByTestId("unclosed-banner")).toBeNull());
  });
});
