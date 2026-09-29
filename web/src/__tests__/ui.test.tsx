import { describe, it, expect, afterEach, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { Button } from "../ui/Button";
import { Card } from "../ui/Card";
import { Banner } from "../ui/Banner";

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
});
