import { describe, it, expect, afterEach, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { Spinner } from "../ui/Spinner";
import { EmptyState } from "../ui/EmptyState";
import { SegmentedControl } from "../ui/SegmentedControl";

afterEach(cleanup);

describe("Spinner", () => {
  it("is a status with a visible label and passes props through", () => {
    render(<Spinner label="Loading…" data-testid="dash-loading" />);
    const s = screen.getByTestId("dash-loading");
    expect(s.getAttribute("role")).toBe("status");
    expect(s.textContent).toBe("Loading…");
  });
});

describe("EmptyState", () => {
  it("shows the message and an optional action", () => {
    render(<EmptyState action={<a href="/x">Import</a>}>No items yet.</EmptyState>);
    expect(screen.getByText("No items yet.")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Import" })).toBeTruthy();
  });
});

describe("SegmentedControl", () => {
  it("is a radiogroup; the current option is checked; choosing calls onChange", () => {
    const onChange = vi.fn();
    render(
      <SegmentedControl label="Language" value="en" onChange={onChange}
        options={[{ value: "en", label: "English" }, { value: "hi", label: "हिंदी" }]} />,
    );
    const group = screen.getByRole("radiogroup", { name: "Language" });
    const radios = screen.getAllByRole("radio");
    expect(group).toBeTruthy();
    expect(radios.map((r) => r.getAttribute("aria-checked"))).toEqual(["true", "false"]);
    fireEvent.click(screen.getByRole("radio", { name: "हिंदी" }));
    expect(onChange).toHaveBeenCalledWith("hi");
  });
});
