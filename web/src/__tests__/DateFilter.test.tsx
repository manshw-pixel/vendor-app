import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { DateFilter } from "../components/DateFilter";
import { presetRange } from "../dateRange";

const onChange = vi.fn();
const initial = { from: "2026-09-01", to: "2026-09-09" };

beforeEach(() => vi.clearAllMocks());

describe("the date filter", () => {
  it("offers the three presets", () => {
    render(<DateFilter value={initial} onChange={onChange} />);
    expect(screen.getByTestId("range-today")).toBeTruthy();
    expect(screen.getByTestId("range-week")).toBeTruthy();
    expect(screen.getByTestId("range-month")).toBeTruthy();
  });

  it("emits the range for a tapped preset", () => {
    render(<DateFilter value={initial} onChange={onChange} />);
    fireEvent.click(screen.getByTestId("range-today"));
    expect(onChange).toHaveBeenCalledWith(presetRange("today", new Date()));
  });

  it("emits a valid custom range", () => {
    render(<DateFilter value={initial} onChange={onChange} />);
    fireEvent.click(screen.getByTestId("range-custom"));
    fireEvent.change(screen.getByTestId("range-from"), { target: { value: "2026-08-01" } });
    fireEvent.change(screen.getByTestId("range-to"), { target: { value: "2026-08-31" } });
    fireEvent.click(screen.getByTestId("range-apply"));
    expect(onChange).toHaveBeenCalledWith({ from: "2026-08-01", to: "2026-08-31" });
  });

  it("refuses a backwards range instead of emitting it", () => {
    // Sending it would return zero rows, which reads as "no sales" rather than "bad
    // input" -- a false answer rather than an error.
    render(<DateFilter value={initial} onChange={onChange} />);
    fireEvent.click(screen.getByTestId("range-custom"));
    fireEvent.change(screen.getByTestId("range-from"), { target: { value: "2026-09-10" } });
    fireEvent.change(screen.getByTestId("range-to"), { target: { value: "2026-09-09" } });
    fireEvent.click(screen.getByTestId("range-apply"));
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByTestId("range-error")).toBeTruthy();
  });

  it("clears the error once a valid range is applied", () => {
    render(<DateFilter value={initial} onChange={onChange} />);
    fireEvent.click(screen.getByTestId("range-custom"));
    fireEvent.change(screen.getByTestId("range-from"), { target: { value: "2026-09-10" } });
    fireEvent.change(screen.getByTestId("range-to"), { target: { value: "2026-09-09" } });
    fireEvent.click(screen.getByTestId("range-apply"));
    fireEvent.change(screen.getByTestId("range-from"), { target: { value: "2026-09-01" } });
    fireEvent.click(screen.getByTestId("range-apply"));
    expect(screen.queryByTestId("range-error")).toBeNull();
    expect(onChange).toHaveBeenCalledWith({ from: "2026-09-01", to: "2026-09-09" });
  });
});
