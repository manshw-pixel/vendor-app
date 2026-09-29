import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import i18n from "../i18n";
import { CheckoutBar } from "../screens/bill/CheckoutBar";

beforeEach(async () => { await i18n.changeLanguage("en"); });
afterEach(cleanup);

describe("CheckoutBar", () => {
  it("shows total and count, and Done fires", () => {
    const onDone = vi.fn();
    render(<CheckoutBar total={80} count={2} disabled={false} onDone={onDone} />);
    expect(screen.getByTestId("checkout-total").textContent).toBe("₹80.00 · 2 items");
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(onDone).toHaveBeenCalledOnce();
  });
  it("singular count and disabled Done", () => {
    render(<CheckoutBar total={5} count={1} disabled onDone={() => {}} />);
    expect(screen.getByTestId("checkout-total").textContent).toBe("₹5.00 · 1 item");
    expect(screen.getByRole("button", { name: "Done" })).toHaveProperty("disabled", true);
  });
});
