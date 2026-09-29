import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import i18n from "../i18n";
import { BottomNav } from "../components/BottomNav";
import { routesForRole } from "../routes";
import type { Role } from "../config";

beforeEach(async () => { await i18n.changeLanguage("en"); });
afterEach(cleanup);

function Where() { return <p data-testid="where">{useLocation().pathname}</p>; }

function renderNav(role: Role, at = "/bill", lowStock = 0, offline = false) {
  return render(
    <MemoryRouter initialEntries={[at]}>
      <BottomNav routes={routesForRole(role, { offline })} lowStock={lowStock} />
      <Routes><Route path="*" element={<Where />} /></Routes>
    </MemoryRouter>,
  );
}

describe("BottomNav", () => {
  it("recorder: four tab links, no More", () => {
    renderNav("recorder");
    expect(screen.getAllByRole("link").map((l) => l.textContent)).toEqual(
      ["New bill", "Customers", "Requests", "Stock in/out"]);
    expect(screen.queryByRole("button", { name: "More" })).toBeNull();
  });
  it("admin: four tabs plus More", () => {
    renderNav("admin");
    expect(screen.getAllByRole("link")).toHaveLength(4);
    expect(screen.getByRole("button", { name: "More" })).toBeTruthy();
  });
  it("offline admin: Bill and Outbox, no More", () => {
    renderNav("admin", "/bill", 0, true);
    expect(screen.getAllByRole("link").map((l) => l.textContent)).toEqual(["New bill", "Waiting to sync"]);
    expect(screen.queryByRole("button", { name: "More" })).toBeNull();
  });
  it("More opens a grouped sheet; choosing a route navigates and closes it", () => {
    renderNav("admin");
    fireEvent.click(screen.getByRole("button", { name: "More" }));
    const sheet = screen.getByRole("dialog", { name: "More" });
    expect(within(sheet).getByText("Shop setup")).toBeTruthy();
    expect(within(sheet).getByText("Reports")).toBeTruthy();
    expect(within(sheet).getByText("End of day")).toBeTruthy();
    fireEvent.click(within(sheet).getByRole("link", { name: "Settings" }));
    expect(screen.getByTestId("where").textContent).toBe("/settings");
    expect(screen.queryByRole("dialog")).toBeNull();
  });
  it("More is marked current on a route that lives in it", () => {
    renderNav("admin", "/items");
    expect(screen.getByRole("button", { name: "More" }).getAttribute("aria-current")).toBe("page");
  });
  it("low stock: dot on More, badge on Items inside the sheet (admin)", () => {
    renderNav("admin", "/bill", 3);
    expect(screen.getByTestId("more-dot")).toBeTruthy();
    expect(screen.queryByTestId("low-stock-badge")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "More" }));
    expect(screen.getByTestId("low-stock-badge").textContent).toBe("3");
  });
});

describe("BottomNav More sheet can be dismissed without choosing", () => {
  it("closes with the Close button", () => {
    renderNav("admin", "/bill");
    fireEvent.click(screen.getByRole("button", { name: "More" }));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByTestId("where").textContent).toBe("/bill");
  });
  it("closes when the backdrop is tapped, not when the sheet is", () => {
    renderNav("admin", "/bill");
    fireEvent.click(screen.getByRole("button", { name: "More" }));
    fireEvent.click(screen.getByText("Shop setup"));
    expect(screen.getByRole("dialog")).toBeTruthy();
    fireEvent.click(screen.getByRole("dialog"));
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
