import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { useState } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import i18n from "../i18n";
import { Basket } from "../screens/bill/Basket";
import type { Draft } from "../billing";

const LINES: Draft[] = [
  { itemId: "i1", name: "Onion", unitPrice: 40, qtyKg: 2, unit: "kg" },
  { itemId: "i2", name: "Potato", unitPrice: 30, qtyKg: 1, unit: "kg" },
];

function Harness({ frozen = false }: { frozen?: boolean }) {
  const [lines, setLines] = useState<Draft[]>(LINES);
  return (
    <Basket lines={lines} frozen={frozen}
            onRemove={(i) => setLines((p) => p.filter((_, n) => n !== i))}
            onRestore={(i, l) => setLines((p) => [...p.slice(0, i), l, ...p.slice(i)])} />
  );
}
const names = () => screen.getAllByTestId("basket-line-name").map((n) => n.textContent);

beforeEach(async () => { await i18n.changeLanguage("en"); });
afterEach(() => { cleanup(); vi.useRealTimers(); });

describe("Basket removal", () => {
  it("tapping the row does not remove it; the ✕ button does", () => {
    render(<Harness />);
    fireEvent.click(screen.getByText("Onion"));
    expect(names()).toEqual(["Onion", "Potato"]);
    fireEvent.click(screen.getByRole("button", { name: "Remove Onion" }));
    expect(names()).toEqual(["Potato"]);
  });
  it("Undo puts the line back where it was", () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "Remove Onion" }));
    expect(screen.getByTestId("undo-strip").textContent).toMatch(/Onion removed/);
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    expect(names()).toEqual(["Onion", "Potato"]);
    expect(screen.queryByTestId("undo-strip")).toBeNull();
  });
  it("only the latest removal is undoable", () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "Remove Onion" }));
    fireEvent.click(screen.getByRole("button", { name: "Remove Potato" }));
    expect(screen.getByTestId("undo-strip").textContent).toMatch(/Potato removed/);
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    expect(names()).toEqual(["Potato"]);
  });
  it("the strip goes away after 6 seconds", () => {
    vi.useFakeTimers();
    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "Remove Onion" }));
    act(() => { vi.advanceTimersByTime(5900); });
    expect(screen.getByTestId("undo-strip")).toBeTruthy();
    act(() => { vi.advanceTimersByTime(200); });
    expect(screen.queryByTestId("undo-strip")).toBeNull();
  });
  it("frozen: no remove buttons", () => {
    render(<Harness frozen />);
    expect(screen.queryByRole("button", { name: /remove/i })).toBeNull();
  });
});
