import { describe, it, expect, vi, afterEach } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { SessionProvider, useSession } from "../components/SessionProvider";
import { ChangePassword } from "../components/ChangePassword";

/**
 * Regression test for the race described in the final review: GoTrueClient's updateUser()
 * fires its USER_UPDATED event -- and so SessionProvider's incidental re-read of
 * app_users -- BEFORE updateUser()'s own promise returns, i.e. before ChangePassword's
 * complete_password_change RPC has even run. A build that relies on that incidental event
 * alone reads must_change_password while it is still true and never recovers: nothing
 * re-reads afterwards, so the person is stuck on the form with no error.
 *
 * This mocks the same shape of race without needing the real auth-js internals: updateUser
 * synchronously fires the captured onAuthStateChange callback -- triggering the incidental
 * read -- before its own promise resolves, exactly as the real client does.
 */

const { onAuthStateChangeCb, appUserRow, selectCallCount } = vi.hoisted(() => ({
  onAuthStateChangeCb: { current: null as ((e: string, s: unknown) => void) | null },
  appUserRow: { calls: [] as boolean[] }, // must_change_password value returned per call, in order
  selectCallCount: { value: 0 },
}));

const user = { id: "u1", email: "rina@shop.test" };

vi.mock("../supabase", () => ({
  supabase: {
    auth: {
      getSession: vi.fn(async () => ({ data: { session: { user } } })),
      getUser: vi.fn(async () => ({ data: { user } })),
      onAuthStateChange: vi.fn((cb: (e: string, s: unknown) => void) => {
        onAuthStateChangeCb.current = cb;
        return { data: { subscription: { unsubscribe: vi.fn() } } };
      }),
      // Mirrors GoTrueClient.updateUser: notifies subscribers (the incidental re-read)
      // before this promise settles, not after.
      updateUser: vi.fn(async () => {
        onAuthStateChangeCb.current?.("USER_UPDATED", { user });
        return { error: null };
      }),
      signOut: vi.fn(),
    },
    rpc: vi.fn(async () => ({ error: null })),
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () => {
            const mustChange = appUserRow.calls[selectCallCount.value] ?? false;
            selectCallCount.value += 1;
            return {
              data: { name: "Rina", role: "biller", vendor_id: "v1", vendors: { name: "Shop" }, must_change_password: mustChange },
              error: null,
            };
          },
        }),
      }),
    }),
  },
}));

function Probe() {
  const s = useSession();
  return <div data-testid="probe">{s.kind}</div>;
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  appUserRow.calls = [];
  selectCallCount.value = 0;
  onAuthStateChangeCb.current = null;
});

describe("ChangePassword against a real SessionProvider", () => {
  it("reaches ready after one submit, not stuck on the gate by the incidental read's timing", async () => {
    // Call 0: SessionProvider's initial load -- gated, so ChangePassword renders.
    // Call 1: the incidental read updateUser's event fires, BEFORE the RPC has run --
    //         still gated, exactly the stale read the old code was fooled by.
    // Call 2: ChangePassword's own explicit reload, issued AFTER the RPC succeeded.
    appUserRow.calls = [true, true, false];

    render(
      <SessionProvider>
        <Probe />
        <ChangePassword email="rina@shop.test" />
      </SessionProvider>,
    );

    await screen.findByTestId("newpw");
    fireEvent.change(screen.getByTestId("newpw"), { target: { value: "sunflower9" } });
    fireEvent.change(screen.getByTestId("newpw-confirm"), { target: { value: "sunflower9" } });
    fireEvent.click(screen.getByTestId("newpw-save"));

    // On the old code, nothing ever re-reads after the incidental (call 1, still gated)
    // resolves, so this would time out with the probe stuck on "mustChangePassword".
    await waitFor(() => expect(screen.getByTestId("probe").textContent).toBe("ready"));
  });
});
