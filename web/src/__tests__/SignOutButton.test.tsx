import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

const signOut = vi.fn<(...a: unknown[]) => unknown>();
vi.mock("../supabase", () => ({ supabase: { auth: { signOut: (...a: unknown[]) => signOut(...a) } } }));

const { default: i18n } = await import("../i18n");
const { SignOutButton } = await import("../components/SignOutButton");

beforeEach(async () => { await i18n.changeLanguage("en"); signOut.mockReset(); });
afterEach(cleanup);

const click = () => fireEvent.click(screen.getByRole("button", { name: i18n.t("app.signOut") }));

describe("SignOutButton", () => {
  it("signs out once and shows no alert on success", async () => {
    signOut.mockResolvedValue({ error: null });
    render(<SignOutButton />);
    click();
    await vi.waitFor(() => expect(signOut).toHaveBeenCalledOnce());
    expect(screen.queryByRole("alert")).toBeNull();
  });
  it("falls back to a local sign-out when the global one errors", async () => {
    signOut.mockResolvedValueOnce({ error: new Error("offline") }).mockResolvedValueOnce({ error: null });
    render(<SignOutButton />);
    click();
    await vi.waitFor(() => expect(signOut).toHaveBeenCalledTimes(2));
    expect(signOut.mock.calls[1]?.[0]).toEqual({ scope: "local" });
    expect(screen.queryByRole("alert")).toBeNull();
  });
  it("reports failure and re-enables the button when both fail", async () => {
    signOut.mockResolvedValue({ error: new Error("nope") });
    render(<SignOutButton />);
    click();
    expect((await screen.findByRole("alert")).textContent).toBe(i18n.t("app.signOutFailed"));
    expect((screen.getByRole("button", { name: i18n.t("app.signOut") }) as HTMLButtonElement).disabled).toBe(false);
  });
  it("ignores a second click while pending", () => {
    signOut.mockReturnValue(new Promise(() => {}));
    render(<SignOutButton />);
    click();
    click();
    expect(signOut).toHaveBeenCalledOnce();
  });
});
