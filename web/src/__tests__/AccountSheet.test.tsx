import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

const signOut = vi.fn(async (..._a: unknown[]) => ({ error: null }));
vi.mock("../supabase", () => ({ supabase: { auth: { signOut: (...a: unknown[]) => signOut(...a) } } }));

const { default: i18n } = await import("../i18n");
const { AccountSheet } = await import("../components/AccountSheet");
const { LangSwitch } = await import("../components/Shell");

beforeEach(async () => { await i18n.changeLanguage("en"); signOut.mockClear(); });
afterEach(cleanup);

describe("AccountSheet", () => {
  it("shows name, switches language, signs out", async () => {
    render(<AccountSheet name="Ravi" role="recorder" onClose={() => {}} />);
    expect(screen.getByRole("dialog").textContent).toMatch(/Ravi/);
    fireEvent.click(screen.getByRole("radio", { name: "हिंदी" }));
    expect(i18n.language).toBe("hi");
    fireEvent.click(screen.getByRole("button", { name: i18n.t("app.signOut") }));
    expect(signOut).toHaveBeenCalledOnce();
  });
  it("languages are named in their own script", () => {
    render(<AccountSheet name="Ravi" role="admin" onClose={() => {}} />);
    expect(screen.getAllByRole("radio").map((r) => r.textContent)).toEqual(["English", "हिंदी", "मराठी"]);
  });
});

describe("LangSwitch (sign-in screens)", () => {
  it("switches language before sign-in", () => {
    render(<LangSwitch />);
    fireEvent.click(screen.getByRole("radio", { name: "मराठी" }));
    expect(i18n.language).toBe("mr");
  });
});
