import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, renderHook } from "@testing-library/react";

vi.mock("../offline/catalogue", () => ({ refreshSnapshot: vi.fn() }));
const { refreshSnapshot } = await import("../offline/catalogue");
const { useSnapshotRefresh } = await import("../offline/useSnapshotRefresh");

const setOnline = (v: boolean) => Object.defineProperty(navigator, "onLine", { value: v, configurable: true });

beforeEach(() => {
  vi.mocked(refreshSnapshot).mockReset();
  vi.mocked(refreshSnapshot).mockResolvedValue(null);
  setOnline(true);
});

describe("useSnapshotRefresh", () => {
  it("refreshes on mount when online", async () => {
    await act(async () => { renderHook(() => useSnapshotRefresh("v1", false)); });
    expect(refreshSnapshot).toHaveBeenCalledWith("v1");
  });

  it("does not refresh on mount when offline, then refreshes on the online event", async () => {
    setOnline(false);
    await act(async () => { renderHook(() => useSnapshotRefresh("v1", false)); });
    expect(refreshSnapshot).not.toHaveBeenCalled();
    setOnline(true);
    await act(async () => { window.dispatchEvent(new Event("online")); });
    expect(refreshSnapshot).toHaveBeenCalledTimes(1);
  });

  it("refreshes on window focus only when online", async () => {
    await act(async () => { renderHook(() => useSnapshotRefresh("v1", false)); });
    await act(async () => { window.dispatchEvent(new Event("focus")); });
    expect(refreshSnapshot).toHaveBeenCalledTimes(2);
    setOnline(false);
    await act(async () => { window.dispatchEvent(new Event("focus")); });
    expect(refreshSnapshot).toHaveBeenCalledTimes(2);
  });

  it("skips when the session came from cache, or there is no vendor", async () => {
    await act(async () => { renderHook(() => useSnapshotRefresh("v1", true)); });
    await act(async () => { renderHook(() => useSnapshotRefresh(null, false)); });
    await act(async () => { window.dispatchEvent(new Event("focus")); });
    expect(refreshSnapshot).not.toHaveBeenCalled();
  });

  it("swallows a failed refresh", async () => {
    vi.mocked(refreshSnapshot).mockRejectedValue(new Error("boom"));
    await act(async () => { renderHook(() => useSnapshotRefresh("v1", false)); });
    expect(refreshSnapshot).toHaveBeenCalled();
  });

  it("stops listening on unmount", async () => {
    let h: { unmount: () => void } | undefined;
    await act(async () => { h = renderHook(() => useSnapshotRefresh("v1", false)); });
    h!.unmount();
    await act(async () => { window.dispatchEvent(new Event("focus")); });
    expect(refreshSnapshot).toHaveBeenCalledTimes(1);
  });
});
