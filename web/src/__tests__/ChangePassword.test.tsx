import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

const updateUser = vi.fn(async (..._a: unknown[]): Promise<{ error: { message?: string } | null }> =>
  ({ error: null }));
const rpc = vi.fn(async (..._a: unknown[]): Promise<{ error: { message?: string } | null }> =>
  ({ error: null }));
const signOut = vi.fn(async () => ({ error: null }));

vi.mock("../supabase", () => ({
  supabase: {
    auth: { updateUser: (...a: unknown[]) => updateUser(...a), signOut: () => signOut() },
    rpc: (...a: unknown[]) => rpc(...a),
  },
}));

const { ChangePassword } = await import("../components/ChangePassword");

beforeEach(() => vi.clearAllMocks());

function fill(pw: string, confirm = pw) {
  fireEvent.change(screen.getByTestId("newpw"), { target: { value: pw } });
  fireEvent.change(screen.getByTestId("newpw-confirm"), { target: { value: confirm } });
}

describe("the forced password change", () => {
  it("sets the new password", async () => {
    render(<ChangePassword email="rina@shop.test" />);
    fill("sunflower9");
    fireEvent.click(screen.getByTestId("newpw-save"));
    await waitFor(() => expect(updateUser).toHaveBeenCalledWith({ password: "sunflower9" }));
  });

  it("clears the flag only AFTER the password actually changed", async () => {
    // The reverse order clears the flag and leaves the admin's password live -- the exact
    // window this screen exists to close.
    render(<ChangePassword email="rina@shop.test" />);
    fill("sunflower9");
    fireEvent.click(screen.getByTestId("newpw-save"));
    await waitFor(() => expect(rpc).toHaveBeenCalledWith("complete_password_change"));
    expect(updateUser.mock.invocationCallOrder[0]!)
      .toBeLessThan(rpc.mock.invocationCallOrder[0]!);
  });

  it("does not clear the flag when the password change failed", async () => {
    updateUser.mockResolvedValueOnce({ error: { message: "too weak" } });
    render(<ChangePassword email="rina@shop.test" />);
    fill("sunflower9");
    fireEvent.click(screen.getByTestId("newpw-save"));
    await waitFor(() => expect(updateUser).toHaveBeenCalled());
    expect(rpc).not.toHaveBeenCalled();
  });

  it("refuses two entries that do not match", async () => {
    render(<ChangePassword email="rina@shop.test" />);
    fill("sunflower9", "sunflower8");
    fireEvent.click(screen.getByTestId("newpw-save"));
    expect(await screen.findByTestId("newpw-error")).toBeTruthy();
    expect(updateUser).not.toHaveBeenCalled();
  });

  it("refuses a password below the floor", async () => {
    render(<ChangePassword email="rina@shop.test" />);
    fill("short");
    fireEvent.click(screen.getByTestId("newpw-save"));
    expect(await screen.findByTestId("newpw-error")).toBeTruthy();
    expect(updateUser).not.toHaveBeenCalled();
  });

  it("offers a way out that is not using the app", async () => {
    // The screen has no cancel by design, so sign out is the only exit. Without it a
    // person handed the wrong password is stuck on a screen they cannot satisfy.
    render(<ChangePassword email="rina@shop.test" />);
    fireEvent.click(screen.getByTestId("newpw-signout"));
    await waitFor(() => expect(signOut).toHaveBeenCalled());
  });
});
