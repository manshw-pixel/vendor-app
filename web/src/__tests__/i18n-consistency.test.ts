import { describe, it, expect } from "vitest";
import en from "../i18n/en.json";
import hi from "../i18n/hi.json";
import mr from "../i18n/mr.json";

type Tree = { [k: string]: string | Tree };
const flat = (o: Tree, p = ""): [string, string][] =>
  Object.entries(o).flatMap(([k, v]) => (typeof v === "string" ? [[p + k, v]] : flat(v, `${p}${k}.`)));
const placeholders = (s: string) => (s.match(/{{\s*\w+\s*}}/g) ?? []).map((x) => x.replace(/\s/g, "")).sort();

const EN = Object.fromEntries(flat(en as Tree));

// Machine checks only. Whether the wording is natural still needs a native speaker:
// see docs/i18n-review/.
describe("translation consistency", () => {
  for (const [lang, tree] of [["hi", hi], ["mr", mr]] as const) {
    it(`${lang} keeps every {{placeholder}} the English uses`, () => {
      const bad = flat(tree as Tree).filter(([k, v]) => placeholders(v).join() !== placeholders(EN[k] ?? "").join());
      expect(bad).toEqual([]);
    });
  }

  it("Hindi ends sentences with a danda, not a full stop", () => {
    expect(flat(hi as Tree).filter(([, v]) => v.endsWith("."))).toEqual([]);
  });

  it("Marathi does not mix terminators (the convention itself awaits a native speaker)", () => {
    const ends = new Set(flat(mr as Tree).map(([, v]) => v.slice(-1)).filter((c) => c === "." || c === "।"));
    expect(ends.size).toBeLessThanOrEqual(1);
  });
});
