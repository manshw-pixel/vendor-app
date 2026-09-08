import { describe, it, expect } from "vitest";
import { resolveLang, itemName, LANGS } from "../i18n/locales";

describe("resolveLang", () => {
  it("prefers a stored choice", () => {
    expect(resolveLang("hi", ["en-GB"])).toBe("hi");
  });

  it("ignores a stored value that is not a supported language", () => {
    expect(resolveLang("fr", ["en-GB"])).toBe("en");
  });

  it("falls back to a supported browser language", () => {
    expect(resolveLang(null, ["mr-IN", "en-GB"])).toBe("mr");
  });

  it("defaults to Marathi when nothing matches", () => {
    // Marathi is the default because the shop staff are the primary users; English is
    // the fallback only when the browser explicitly asks for it.
    expect(resolveLang(null, ["fr-FR"])).toBe("mr");
  });

  it("supports exactly mr, hi and en", () => {
    expect([...LANGS]).toEqual(["mr", "hi", "en"]);
  });
});

describe("itemName", () => {
  const onion = { name_en: "Onion", name_hi: "प्याज", name_mr: "कांदा" };

  it("uses the column for the active language", () => {
    expect(itemName(onion, "mr")).toBe("कांदा");
    expect(itemName(onion, "hi")).toBe("प्याज");
    expect(itemName(onion, "en")).toBe("Onion");
  });

  it("falls back to English when a translation is empty", () => {
    // name_hi and name_mr default to '' in 0001_schema.sql, so an untranslated item is
    // the normal case, not an error.
    expect(itemName({ name_en: "Beetroot", name_hi: "", name_mr: "" }, "mr")).toBe("Beetroot");
  });
});
