import { describe, it, expect } from "vitest";
import { pickStrip } from "../components/Shell";

type Strip = ReturnType<typeof pickStrip>;

// All 16 combinations of [offline, attention, unclosed, update].
// Rule: offline (no network / bills waiting) > unclosed > update > attention-only.
function expected(offline: boolean, attention: boolean, unclosed: boolean, update: boolean): Strip {
  if (offline) return "offline";
  if (unclosed) return "unclosed";
  if (update) return "update";
  if (attention) return "offline";
  return null;
}

describe("pickStrip", () => {
  const cases: [boolean, boolean, boolean, boolean, Strip][] = [];
  for (const offline of [false, true])
    for (const attention of [false, true])
      for (const unclosed of [false, true])
        for (const update of [false, true])
          cases.push([offline, attention, unclosed, update, expected(offline, attention, unclosed, update)]);

  it("covers 16 combinations", () => expect(cases).toHaveLength(16));

  it.each(cases)("offline=%s attention=%s unclosed=%s update=%s -> %s",
    (offline, attention, unclosed, update, want) => {
      expect(pickStrip({ offline, attention, unclosed, update })).toBe(want);
    });

  it("spot checks", () => {
    expect(pickStrip({ offline: false, attention: true, unclosed: true, update: false })).toBe("unclosed");
    expect(pickStrip({ offline: false, attention: true, unclosed: false, update: true })).toBe("update");
    expect(pickStrip({ offline: false, attention: true, unclosed: false, update: false })).toBe("offline");
    expect(pickStrip({ offline: true, attention: true, unclosed: true, update: true })).toBe("offline");
  });
});
