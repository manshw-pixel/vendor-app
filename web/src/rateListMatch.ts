import type { Unit } from "./units";
import { normaliseSoldBy } from "./soldBy";

export type ExtractedRow = {
  name_as_written: string; sold_by_as_written: string; price: number;
  name_en: string; name_hi: string; name_mr: string; confidence: "high" | "low";
  /** Words the reader saw crossed out and left out of the name; absent from older function versions. */
  struck_out?: string;
};
export type MatchItem = { id: string; name_en: string; name_hi: string; name_mr: string; price: number; unit: Unit };
export type Alias = { alias: string; item_id: string };
export type ReviewRow =
  | { key: number; kind: "update"; row: ExtractedRow; item: MatchItem; price: string; grams: number | null; include: boolean; changed: boolean; similar?: boolean }
  | { key: number; kind: "mismatch"; reason: "unit" | "quantity"; row: ExtractedRow; item: MatchItem; listUnit: Unit; price: string; include: boolean }
  | { key: number; kind: "new"; row: ExtractedRow; names: { name_en: string; name_hi: string; name_mr: string }; unit: Unit; price: string; grams: number | null; quantity: boolean; suggestion: MatchItem | null; include: boolean }
  | { key: number; kind: "duplicate"; row: ExtractedRow; item: MatchItem };
export type ApplyRow =
  | { kind: "update"; item_id: string; price: number; alias?: string }
  | { kind: "create"; names: { name_en: string; name_hi: string; name_mr: string }; unit: Unit; price: number; alias?: string };

const norm = (s: string) => s.normalize("NFC").toLowerCase().replace(/\s+/g, " ").trim();

function lookupTable(items: MatchItem[], aliases: Alias[]): Map<string, MatchItem> {
  const byId = new Map(items.map((i) => [i.id, i]));
  const table = new Map<string, MatchItem>();
  for (const i of items) for (const n of [i.name_en, i.name_hi, i.name_mr]) if (norm(n)) table.set(norm(n), i);
  for (const a of aliases) {
    const i = byId.get(a.item_id);
    if (i && !table.has(norm(a.alias))) table.set(norm(a.alias), i);
  }
  return table;
}

function levenshtein(a: string, b: string): number {
  const d: number[] = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let prev = d[0] ?? 0;
    d[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = d[j] ?? 0;
      d[j] = Math.min(tmp + 1, (d[j - 1] ?? 0) + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return d[b.length] ?? 0;
}

/** Names at least this similar (1 - edit distance / longer length) count as the same item. */
export const SIMILAR = 0.8;

const similarity = (a: string, b: string) => 1 - levenshtein(a, b) / Math.max(a.length, b.length, 1);

/** Best item whose name or alias is >= SIMILAR to one of the row's names, or null. */
function similarItem(row: ExtractedRow, table: Map<string, MatchItem>): MatchItem | null {
  const names = [row.name_as_written, row.name_en, row.name_hi, row.name_mr].map(norm).filter(Boolean);
  let best: MatchItem | null = null, score = SIMILAR;
  for (const [key, item] of table) for (const n of names) {
    const s = similarity(n, key);
    if (s >= score && (best === null || s > score)) { best = item; score = s; }
  }
  return best;
}

function closest(row: ExtractedRow, items: MatchItem[]): MatchItem | null {
  const names = [row.name_as_written, row.name_en].map(norm).filter((n) => n.length >= 3);
  for (const i of items) {
    const en = norm(i.name_en);
    if (en.length < 3) continue;
    if (names.some((n) => n.includes(en) || en.includes(n) || levenshtein(n, en) <= 2)) return i;
  }
  return null;
}

const priceText = (n: number) => String(Math.round(n * 100) / 100);

function asUpdateOrMismatch(key: number, row: ExtractedRow, item: MatchItem): ReviewRow {
  const sb = normaliseSoldBy(row.sold_by_as_written, row.price);
  if (sb.unit !== item.unit || sb.unclear) {
    return { key, kind: "mismatch", reason: sb.unit !== item.unit ? "unit" : "quantity",
      row, item, listUnit: sb.unit, price: "", include: false };
  }
  return { key, kind: "update", row, item, price: priceText(sb.price), grams: sb.grams,
    include: row.confidence !== "low", changed: Math.abs(sb.price - item.price) >= 0.005 };
}

export function buildReview(rows: ExtractedRow[], items: MatchItem[], aliases: Alias[]): ReviewRow[] {
  const table = lookupTable(items, aliases);
  const matched = rows.map((row) =>
    [row.name_as_written, row.name_en, row.name_hi, row.name_mr]
      .map((n) => table.get(norm(n))).find((i) => i !== undefined) ?? null);
  const similar = rows.map((row, idx) => (matched[idx] ? false : (matched[idx] = similarItem(row, table)) !== null));
  const lastIndex = new Map<string, number>();
  matched.forEach((i, idx) => { if (i) lastIndex.set(i.id, idx); });

  return rows.map((row, key) => {
    const item = matched[key];
    if (item && lastIndex.get(item.id) !== key) return { key, kind: "duplicate", row, item };
    if (item) {
      const r = asUpdateOrMismatch(key, row, item);
      // A similar (not exact) name could be a different item -- ask before changing its price.
      return similar[key] && r.kind === "update" ? { ...r, include: false, similar: true } : r;
    }
    const sb = normaliseSoldBy(row.sold_by_as_written, row.price);
    return { key, kind: "new", row,
      names: { name_en: row.name_en.trim() || row.name_as_written.trim(), name_hi: row.name_hi.trim(), name_mr: row.name_mr.trim() },
      unit: sb.unit, price: sb.unclear ? "" : priceText(sb.price), grams: sb.grams, quantity: sb.unclear,
      suggestion: closest(row, items), include: !sb.unclear && row.confidence !== "low" };
  });
}

export function linkRow(r: ReviewRow & { kind: "new" }, item: MatchItem): ReviewRow {
  return asUpdateOrMismatch(r.key, r.row, item);
}

/** Link row `key` to `item`. If another non-duplicate row already targets that item, the
 * earlier of the two becomes a duplicate -- the same "last wins" rule as buildReview. */
export function relinkReview(review: ReviewRow[], key: number, item: MatchItem): ReviewRow[] {
  const target = review.find((r) => r.key === key);
  if (!target || target.kind !== "new") return review;
  const other = review.find((r) => r.key !== key && (r.kind === "update" || r.kind === "mismatch") && r.item.id === item.id);
  const pos = (k: number) => review.findIndex((r) => r.key === k);
  const linkedIsEarlier = other !== undefined && pos(key) < pos(other.key);
  return review.map((r): ReviewRow => {
    if (r.key === key) return linkedIsEarlier ? { key, kind: "duplicate", row: r.row, item } : linkRow(target, item);
    if (other && r.key === other.key && !linkedIsEarlier) return { key: r.key, kind: "duplicate", row: r.row, item };
    return r;
  });
}

const validPrice = (p: string) => { const n = Number(p); return p.trim() !== "" && Number.isFinite(n) && n > 0; };

export function rowError(r: ReviewRow): string | null {
  if (r.kind === "duplicate" || !r.include) return null;
  if (!validPrice(r.price)) return "rateList.badPrice";
  if (r.kind === "new" && [r.names.name_en, r.names.name_hi, r.names.name_mr].some((n) => n.trim() === "")) {
    return "rateList.needNames";
  }
  return null;
}

function aliasFor(row: ExtractedRow, item: MatchItem | null): string | undefined {
  const written = row.name_as_written.trim();
  if (!written) return undefined;
  if (item && [item.name_en, item.name_hi, item.name_mr].some((n) => norm(n) === norm(written))) return undefined;
  return written;
}

export function toApplyRows(review: ReviewRow[]): ApplyRow[] {
  const out: ApplyRow[] = [];
  for (const r of review) {
    if (r.kind === "duplicate" || !r.include) continue;
    const price = Number(r.price);
    if (r.kind === "new") {
      const alias = aliasFor(r.row, null);
      out.push({ kind: "create", names: { ...r.names }, unit: r.unit, price, ...(alias ? { alias } : {}) });
      continue;
    }
    if (Math.abs(price - r.item.price) < 0.005) continue;
    const alias = aliasFor(r.row, r.item);
    out.push({ kind: "update", item_id: r.item.id, price, ...(alias ? { alias } : {}) });
  }
  return out;
}
