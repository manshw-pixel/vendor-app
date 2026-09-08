import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import en from "./en.json";
import hi from "./hi.json";
import mr from "./mr.json";
import { LANG_STORAGE_KEY, resolveLang, type Lang } from "./locales";

// localStorage throws in some privacy modes; a language preference is not worth a
// blank screen.
const stored = (() => {
  try {
    return localStorage.getItem(LANG_STORAGE_KEY);
  } catch {
    return null;
  }
})();

const lng = resolveLang(stored, navigator.languages ?? [navigator.language]);

void i18n.use(initReactI18next).init({
  resources: { en: { translation: en }, hi: { translation: hi }, mr: { translation: mr } },
  lng,
  fallbackLng: "en",
  interpolation: { escapeValue: false },
});

export function setLang(lang: Lang): void {
  void i18n.changeLanguage(lang);
  try {
    localStorage.setItem(LANG_STORAGE_KEY, lang);
  } catch {
    /* preference not persisted; the app still works */
  }
  document.documentElement.lang = lang;
}

document.documentElement.lang = lng;

export default i18n;
