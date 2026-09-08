export const LANGS = ["mr", "hi", "en"] as const;
export type Lang = (typeof LANGS)[number];

export const LANG_STORAGE_KEY = "vendor-app.lang";

const isLang = (v: string): v is Lang => (LANGS as readonly string[]).includes(v);

export function resolveLang(stored: string | null, browser: readonly string[]): Lang {
  if (stored && isLang(stored)) return stored;
  for (const tag of browser) {
    const base = tag.split("-")[0];
    if (base && isLang(base)) return base;
  }
  return "mr";
}

/**
 * Item names are DATA, not UI strings: items carries name_en, name_hi and name_mr.
 * Both translated columns default to '' , so an untranslated item is normal and must
 * fall back rather than render blank.
 */
export function itemName(
  item: { name_en: string; name_hi: string; name_mr: string },
  lang: Lang,
): string {
  const chosen = lang === "mr" ? item.name_mr : lang === "hi" ? item.name_hi : item.name_en;
  return chosen.trim() !== "" ? chosen : item.name_en;
}
