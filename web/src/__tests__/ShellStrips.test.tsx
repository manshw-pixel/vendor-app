import { describe, it, expect } from "vitest";
import { pickStrip } from "../components/Shell";

describe("pickStrip", () => {
  const cases: [boolean, boolean, boolean, ReturnType<typeof pickStrip>][] = [
    [false, false, false, null],
    [false, false, true, "update"],
    [false, true, false, "unclosed"],
    [false, true, true, "unclosed"],
    [true, false, false, "offline"],
    [true, false, true, "offline"],
    [true, true, false, "offline"],
    [true, true, true, "offline"],
  ];
  it.each(cases)("offline=%s unclosed=%s update=%s -> %s", (offline, unclosed, update, want) => {
    expect(pickStrip({ offline, unclosed, update })).toBe(want);
  });
});
