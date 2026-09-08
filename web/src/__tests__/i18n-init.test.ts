import { describe, it, expect } from "vitest";
import i18n from "../i18n";

// main.tsx imports "./i18n" before rendering, because i18next initialises as a side
// effect of that import. Without it every t() call returns its raw key -- a first paint
// reading "nav.bill" instead of "नवीन बिल". A reviewer flagged this as unverifiable from
// a diff, so it is verified here instead: importing the module must be enough to make
// translation work, with nothing else awaited.
describe("i18n initialises on import", () => {
  it("resolves keys rather than echoing them", () => {
    expect(i18n.isInitialized).toBe(true);
    expect(i18n.t("nav.bill")).not.toBe("nav.bill");
  });

  it("honours the browser's language when it is one we support", () => {
    // NOT a Marathi assertion. resolveLang's order is: stored choice, then a supported
    // browser language, and only then the mr default. jsdom reports en-US, so en wins
    // here -- and that is the intended contract, since a phone set to English is a
    // stated user preference, not an absence of one.
    expect(i18n.language).toBe("en");
    expect(i18n.t("nav.bill")).toBe("New bill");
  });

  it("carries the Marathi resource, whatever the active language", () => {
    // The mr default only fires when nothing else matches, so this checks the content
    // is loaded and correct rather than that it is currently selected.
    expect(i18n.getResource("mr", "translation", "nav.bill")).toBe("नवीन बिल");
  });

  it("has every key the shell renders, in the active language", () => {
    // A key present in en.json but missing from mr.json would silently fall back and
    // show English to a Marathi user. These are the keys the stage-1 UI actually calls.
    for (const key of [
      "app.name", "app.signIn", "app.signOut", "app.email", "app.password",
      "app.signingIn", "app.language", "nav.bill", "nav.pending", "nav.items",
      "nav.customers", "nav.staff", "nav.dashboards", "session.unmappedTitle",
      "offline.banner", "soon.body",
    ]) {
      expect(i18n.getResource("mr", "translation", key), `missing mr: ${key}`).toBeTruthy();
    }
  });

  it("interpolates the email into the unmapped message", () => {
    const out = i18n.t("session.unmapped", { email: "a@b.test" });
    expect(out).toContain("a@b.test");
    expect(out).not.toContain("{{email}}");
  });
});
