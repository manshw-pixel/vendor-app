import { useState } from "react";
import { describe, it, expect, afterEach, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { Button } from "../ui/Button";
import { Card } from "../ui/Card";
import { Banner } from "../ui/Banner";
import { SegmentedControl } from "../ui/SegmentedControl";

afterEach(cleanup);

describe("Button", () => {
  it("defaults to primary md and passes native props through", () => {
    const onClick = vi.fn();
    render(<Button data-testid="b" onClick={onClick} disabled={false}>Go</Button>);
    const b = screen.getByTestId("b");
    expect(b.className).toMatch(/bg-brand/);
    expect(b.className).toMatch(/min-h-\[44px\]/);
    expect(b.getAttribute("type")).toBe("button");
    fireEvent.click(b);
    expect(onClick).toHaveBeenCalledOnce();
  });
  it("secondary is outlined, lg is taller, and disabled blocks clicks", () => {
    const onClick = vi.fn();
    render(<Button variant="secondary" size="lg" disabled onClick={onClick}>X</Button>);
    const b = screen.getByRole("button", { name: "X" });
    expect(b.className).toMatch(/border/);
    expect(b.className).toMatch(/min-h-\[52px\]/);
    fireEvent.click(b);
    expect(onClick).not.toHaveBeenCalled();
  });
  it("warn is amber-toned", () => {
    render(<Button variant="warn">W</Button>);
    const b = screen.getByRole("button", { name: "W" });
    expect(b.className).toMatch(/amber/);
  });
  it("keeps an explicit type", () => {
    render(<Button type="submit">S</Button>);
    expect(screen.getByRole("button").getAttribute("type")).toBe("submit");
  });
});

describe("Card and Banner", () => {
  it("Card renders its title as a heading", () => {
    render(<Card title="Basket"><p>x</p></Card>);
    expect(screen.getByRole("heading", { name: "Basket" })).toBeTruthy();
  });
  it("error Banner is an alert; info is a status", () => {
    render(<><Banner tone="error">bad</Banner><Banner tone="info">fyi</Banner></>);
    expect(screen.getByRole("alert").textContent).toBe("bad");
    expect(screen.getByRole("status").textContent).toBe("fyi");
  });
  it("role overrides a tone's default, e.g. an assertive warn Banner", () => {
    render(<Banner tone="warn" role="alert">careful</Banner>);
    expect(screen.getByRole("alert").textContent).toBe("careful");
    expect(screen.queryByRole("status")).toBeNull();
  });
});

describe("SegmentedControl keyboard", () => {
  function Harness({ initial = "a" }: { initial?: string }) {
    const [v, setV] = useState(initial);
    return (
      <SegmentedControl label="pick" value={v} onChange={setV}
        options={[{ value: "a", label: "A" }, { value: "b", label: "B" }, { value: "c", label: "C" }]} />
    );
  }
  const radios = () => screen.getAllByRole("radio");

  it("only the checked radio is in the tab order", () => {
    render(<Harness />);
    expect(radios().map((r) => r.tabIndex)).toEqual([0, -1, -1]);
  });
  it("falls back to the first radio when value matches nothing", () => {
    render(<Harness initial="zzz" />);
    expect(radios().map((r) => r.tabIndex)).toEqual([0, -1, -1]);
  });
  it("ArrowRight selects and focuses the next radio", () => {
    render(<Harness />);
    fireEvent.keyDown(radios()[0]!, { key: "ArrowRight" });
    expect(radios()[1]!.getAttribute("aria-checked")).toBe("true");
    expect(document.activeElement).toBe(radios()[1]);
  });
  it("ArrowLeft wraps from first to last", () => {
    render(<Harness />);
    fireEvent.keyDown(radios()[0]!, { key: "ArrowLeft" });
    expect(radios()[2]!.getAttribute("aria-checked")).toBe("true");
    expect(document.activeElement).toBe(radios()[2]);
  });
  it("End and Home jump to last and first", () => {
    render(<Harness />);
    fireEvent.keyDown(radios()[0]!, { key: "End" });
    expect(radios()[2]!.getAttribute("aria-checked")).toBe("true");
    fireEvent.keyDown(radios()[2]!, { key: "Home" });
    expect(radios()[0]!.getAttribute("aria-checked")).toBe("true");
    expect(document.activeElement).toBe(radios()[0]);
  });
});
