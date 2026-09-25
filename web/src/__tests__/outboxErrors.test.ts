import { describe, it, expect } from "vitest";
import { friendlyOutboxError } from "../offline/outboxErrors";

const t = (k: string) => `T:${k}`;
describe("friendlyOutboxError", () => {
  it("maps known refusals to friendly keys", () => {
    expect(friendlyOutboxError("day is closed", t)).toBe("T:offline.err.dayClosed");
    expect(friendlyOutboxError("item x no longer exists", t)).toBe("T:offline.err.gone");
    expect(friendlyOutboxError("JWT expired", t)).toBe("T:offline.err.signIn");
    expect(friendlyOutboxError("401 Unauthorized", t)).toBe("T:offline.err.signIn");
    expect(friendlyOutboxError("not authenticated", t)).toBe("T:offline.err.signIn");
  });
  it("falls back to the raw text", () => {
    expect(friendlyOutboxError("something odd", t)).toBe("something odd");
  });
});
