import { describe, it, expect, beforeEach } from "vitest";
import { recallSession, rememberSession } from "../offline/sessionCache";
import type { AppUserRow } from "../session";
const row = { name: "R", role: "recorder", vendor_id: "v1", vendors: { name: "V", suspended_at: null }, must_change_password: false } as const;
beforeEach(() => localStorage.clear());
describe("session cache", () => {
  it("round-trips the last ready session", () => {
    rememberSession("u1", "r@x", row as unknown as AppUserRow);
    expect(recallSession()).toEqual({ userId: "u1", email: "r@x", row });
  });
  it("returns null on garbage", () => {
    localStorage.setItem("vendor-app:last-session", "{bad");
    expect(recallSession()).toBeNull();
  });
});
