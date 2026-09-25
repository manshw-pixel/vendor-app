import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { cleanup, render, screen, fireEvent } from "@testing-library/react";
import i18n from "../i18n";
import { UpdateBanner } from "../components/Shell";
import { setUpdateReady } from "../offline/updateReady";

function fakeRegistration(): ServiceWorkerRegistration {
  const waiting = { postMessage: vi.fn() };
  return { waiting } as unknown as ServiceWorkerRegistration;
}

beforeEach(async () => { await i18n.changeLanguage("en"); });
afterEach(cleanup);

describe("UpdateBanner", () => {
  it("renders nothing when no update is pending", () => {
    const { container } = render(<UpdateBanner />);
    expect(container.innerHTML).toBe("");
  });

  it("appears on mount when a registration was already recorded before mounting", () => {
    setUpdateReady(fakeRegistration());
    render(<UpdateBanner />);
    expect(screen.getByText("A new version is ready.")).toBeTruthy();
  });

  it("never reloads on its own -- only posts skip-waiting when the button is clicked", () => {
    const addEventListener = vi.fn();
    vi.stubGlobal("navigator", { ...navigator, serviceWorker: { addEventListener } });
    const reg = fakeRegistration();
    setUpdateReady(reg);
    render(<UpdateBanner />);
    expect(reg.waiting?.postMessage).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button"));
    expect(reg.waiting?.postMessage).toHaveBeenCalledWith("skip-waiting");
    expect(addEventListener).toHaveBeenCalledWith("controllerchange", expect.any(Function), { once: true });
    vi.unstubAllGlobals();
  });
});
