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
      "staff.email", "staff.password", "staff.passwordHint", "staff.badEmail",
      "staff.badPassword", "staff.adminCreates",
      "changePw.title", "changePw.body", "changePw.new", "changePw.confirm",
      "changePw.save", "changePw.tooShort", "changePw.mismatch", "changePw.failed",
      "error.emailTaken", "error.weakPassword", "error.staffNotCreated",
      "session.notLinkedHelp",
    ]) {
      expect(i18n.getResource("mr", "translation", key), `missing mr: ${key}`).toBeTruthy();
    }
  });

  it("interpolates the email into the unmapped message", () => {
    const out = i18n.t("session.unmapped", { email: "a@b.test" });
    expect(out).toContain("a@b.test");
    expect(out).not.toContain("{{email}}");
  });

  it("has retired every key the uuid flow used", () => {
    // Left behind, these read as live copy to the next person to open the file, and one of
    // them (staff.badId) taught an admin to expect a value the app no longer asks for.
    for (const key of ["staff.badId", "staff.userId", "staff.signUpFirst",
                       "error.staffExists", "session.sendIdToAdmin"]) {
      for (const lang of ["en", "hi", "mr"]) {
        expect(i18n.getResource(lang, "translation", key), `${lang} still has ${key}`)
          .toBeUndefined();
      }
    }
  });

  it("keeps the same key set across en, hi and mr", () => {
    // A key added to one file and forgotten in another either shows the raw key (if
    // missing from en, the fallback language) or silently falls back to English (if
    // missing from hi/mr) -- and mr is the app's default, so its gaps are the ones a
    // majority of users would actually hit.
    function keys(obj: unknown, prefix = ""): Set<string> {
      const out = new Set<string>();
      for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
        if (v && typeof v === "object") {
          for (const nested of keys(v, `${prefix}${k}.`)) out.add(nested);
        } else {
          out.add(`${prefix}${k}`);
        }
      }
      return out;
    }
    const en = keys(i18n.getResourceBundle("en", "translation"));
    for (const lang of ["hi", "mr"]) {
      const other = keys(i18n.getResourceBundle(lang, "translation"));
      const missing = [...en].filter((k) => !other.has(k));
      const extra = [...other].filter((k) => !en.has(k));
      expect(missing, `${lang} missing: ${missing.join(", ")}`).toEqual([]);
      expect(extra, `${lang} has extra: ${extra.join(", ")}`).toEqual([]);
    }
  });
});
