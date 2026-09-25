import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, renderHook } from "@testing-library/react";

vi.mock("../supabase", () => ({
  supabase: { auth: { getSession: vi.fn().mockResolvedValue({ data: { session: null } }) } },
}));
vi.mock("../offline/outbox", () => ({ flush: vi.fn(), listOutbox: vi.fn() }));

const { flush, listOutbox } = await import("../offline/outbox");
const { useOutbox } = await import("../offline/useOutbox");

const waiting = () => [{ state: "waiting" } as any];

beforeEach(() => {
  vi.useFakeTimers();
  vi.mocked(flush).mockReset();
  vi.mocked(listOutbox).mockReset();
  vi.mocked(listOutbox).mockResolvedValue(waiting());
  Object.defineProperty(navigator, "onLine", { value: true, configurable: true });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("useOutbox", () => {
  it("flushes once on mount", async () => {
    vi.mocked(flush).mockResolvedValue({ sent: 1, attention: 0, stoppedOffline: false });
    await act(async () => {
      renderHook(() => useOutbox("v1"));
      await vi.runOnlyPendingTimersAsync();
    });
    expect(flush).toHaveBeenCalledTimes(1);
  });

  it("doubles the retry delay on stoppedOffline and resets to 5s after success", async () => {
    vi.mocked(flush)
      .mockResolvedValueOnce({ sent: 0, attention: 0, stoppedOffline: true }) // -> delay 10s
      .mockResolvedValueOnce({ sent: 1, attention: 0, stoppedOffline: false }) // success -> delay 5s
      .mockResolvedValue({ sent: 0, attention: 0, stoppedOffline: true });

    await act(async () => {
      renderHook(() => useOutbox("v1"));
      await vi.runOnlyPendingTimersAsync();
    });
    expect(flush).toHaveBeenCalledTimes(1);

    // Scheduled delay is 10s (5s*2) after the first stoppedOffline run: 5s isn't enough yet.
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
    expect(flush).toHaveBeenCalledTimes(1);

    await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
    expect(flush).toHaveBeenCalledTimes(2);

    // Second run succeeded, so delay reset to 5s for the next schedule.
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
    expect(flush).toHaveBeenCalledTimes(3);
  });

  it("does not start a concurrent flush while one is in flight", async () => {
    let resolveFlush!: (r: { sent: number; attention: number; stoppedOffline: boolean }) => void;
    vi.mocked(flush).mockReturnValue(
      new Promise((resolve) => { resolveFlush = resolve; }),
    );

    let hook!: ReturnType<typeof renderHook<ReturnType<typeof useOutbox>, unknown>>;
    await act(async () => {
      hook = renderHook(() => useOutbox("v1"));
    });
    expect(flush).toHaveBeenCalledTimes(1);

    act(() => { hook.result.current.flushNow(); });
    expect(flush).toHaveBeenCalledTimes(1); // still in flight; second trigger is a no-op

    await act(async () => {
      resolveFlush({ sent: 1, attention: 0, stoppedOffline: false });
      await Promise.resolve();
    });
    expect(flush).toHaveBeenCalledTimes(1);
  });

  it("clears its timer on unmount, so no flush fires afterward", async () => {
    vi.mocked(flush).mockResolvedValue({ sent: 0, attention: 0, stoppedOffline: true });

    let unmount!: () => void;
    await act(async () => {
      ({ unmount } = renderHook(() => useOutbox("v1")));
      await vi.runOnlyPendingTimersAsync();
    });
    expect(flush).toHaveBeenCalledTimes(1);

    unmount();

    await act(async () => { await vi.advanceTimersByTimeAsync(300_000); });
    expect(flush).toHaveBeenCalledTimes(1);
  });
});
