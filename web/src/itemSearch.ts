/**
 * The billing item search. Matches all three names whatever the UI language, so a
 * recorder can type in whichever script is quickest for them.
 */
export function filterItems<T extends { name_en: string; name_hi: string; name_mr: string }>(
  items: readonly T[],
  query: string,
): T[] {
  const q = query.trim().toLocaleLowerCase();
  if (q === "") return [...items];
  return items.filter((i) =>
    [i.name_en, i.name_hi, i.name_mr].some((n) => n.toLocaleLowerCase().includes(q)));
}
