import { describe, it, expect } from "vitest";
import { buildReview, linkRow, relinkReview, rowError, toApplyRows, type ExtractedRow, type MatchItem } from "../rateListMatch";

const items: MatchItem[] = [
  { id: "onion", name_en: "Onion", name_hi: "प्याज", name_mr: "कांदा", price: 40, unit: "kg" },
  { id: "banana", name_en: "Banana", name_hi: "केला", name_mr: "केळी", price: 60, unit: "dozen" },
  { id: "tomato", name_en: "Tomato", name_hi: "टमाटर", name_mr: "टोमॅटो", price: 30, unit: "kg" },
];
const row = (o: Partial<ExtractedRow>): ExtractedRow => ({
  name_as_written: "", sold_by_as_written: "", price: 0, name_en: "", name_hi: "", name_mr: "", confidence: "high", ...o,
});

function first<T>(arr: T[]): T {
  const v = arr[0];
  if (v === undefined) throw new Error("expected at least one element");
  return v;
}

describe("buildReview", () => {
  it("matches by English name ignoring case and spaces, and marks a changed price", () => {
    const r = first(buildReview([row({ name_as_written: "  ONION ", price: 44 })], items, []));
    expect(r.kind).toBe("update");
    if (r.kind !== "update") return;
    expect(r.item.id).toBe("onion"); expect(r.price).toBe("44"); expect(r.changed).toBe(true); expect(r.include).toBe(true);
  });

  it("matches by the Hindi or Marathi name as written", () => {
    const rs = buildReview([row({ name_as_written: "प्याज", price: 40 }), row({ name_as_written: "केळी", sold_by_as_written: "12 pc", price: 60 })], items, []);
    expect(rs.map((r) => r.kind)).toEqual(["update", "update"]);
  });

  it("marks an unchanged price not changed", () => {
    const r = first(buildReview([row({ name_as_written: "Onion", price: 40 })], items, []));
    expect(r.kind === "update" && r.changed).toBe(false);
  });

  it("matches through a saved alias, then through the model's English name", () => {
    const rs = buildReview([
      row({ name_as_written: "Kanda Nashik", price: 41 }),
      row({ name_as_written: "Tamatar", name_en: "Tomato", price: 32 }),
    ], items, [{ alias: "kanda nashik", item_id: "onion" }]);
    expect(rs.map((r) => (r.kind === "update" ? r.item.id : r.kind))).toEqual(["onion", "tomato"]);
  });

  it("converts grams to per kg for an existing kg item", () => {
    const r = first(buildReview([row({ name_as_written: "Onion", sold_by_as_written: "250 g", price: 11 })], items, []));
    expect(r.kind === "update" && r.price).toBe("44");
    expect(r.kind === "update" && r.grams).toBe(250);
  });

  it("flags a unit mismatch on an existing item and leaves it unticked", () => {
    const r = first(buildReview([row({ name_as_written: "Banana", sold_by_as_written: "1 pc", price: 6 })], items, []));
    expect(r.kind).toBe("mismatch");
    if (r.kind !== "mismatch") return;
    expect(r.listUnit).toBe("piece"); expect(r.include).toBe(false); expect(r.price).toBe("");
    expect(r.reason).toBe("unit");
  });

  it("flags a multi-quantity line on an existing item of the same unit, unticked with no price", () => {
    const r = first(buildReview([row({ name_as_written: "Onion", sold_by_as_written: "5 kg", price: 200 })], items, []));
    expect(r.kind).toBe("mismatch");
    if (r.kind !== "mismatch") return;
    expect(r.reason).toBe("quantity"); expect(r.include).toBe(false); expect(r.price).toBe("");
  });

  it("starts an unclear new line unticked with no price", () => {
    const r = first(buildReview([row({ name_as_written: "Kiwi", name_en: "Kiwi", sold_by_as_written: "6 pc", price: 30 })], items, []));
    expect(r.kind).toBe("new");
    if (r.kind !== "new") return;
    expect(r.quantity).toBe(true); expect(r.include).toBe(false); expect(r.price).toBe("");
  });

  it("proposes an unknown line as a new item with the model's names and the rule's unit", () => {
    const r = first(buildReview([row({ name_as_written: "Kiwi", sold_by_as_written: "1 box", price: 120, name_en: "Kiwi", name_hi: "कीवी", name_mr: "किवी" })], items, []));
    expect(r.kind).toBe("new");
    if (r.kind !== "new") return;
    expect(r.unit).toBe("piece"); expect(r.price).toBe("120"); expect(r.include).toBe(true);
    expect(r.names).toEqual({ name_en: "Kiwi", name_hi: "कीवी", name_mr: "किवी" }); expect(r.suggestion).toBeNull();
  });

  it("suggests a close existing item for a new line", () => {
    const r = first(buildReview([row({ name_as_written: "Tomatoes", name_en: "Tomatoes", price: 30 })], items, []));
    expect(r.kind === "new" && r.suggestion?.id).toBe("tomato");
  });

  it("keeps the last line for an item listed twice and marks the earlier a duplicate", () => {
    const rs = buildReview([row({ name_as_written: "Onion", price: 41 }), row({ name_as_written: "onion", price: 43 })], items, []);
    expect(rs[0]!.kind).toBe("duplicate");
    expect(rs[1]!.kind === "update" && rs[1]!.price).toBe("43");
  });
});

describe("linkRow, rowError and toApplyRows", () => {
  it("linking a new row to an item makes it an update carrying the written name as alias", () => {
    const r = first(buildReview([row({ name_as_written: "Tamatar Desi", price: 35 })], items, []));
    if (r.kind !== "new") throw new Error("expected new");
    const linked = linkRow(r, items[2]!);
    expect(linked.kind).toBe("update");
    expect(toApplyRows([linked])).toEqual([{ kind: "update", item_id: "tomato", price: 35, alias: "Tamatar Desi" }]);
  });

  it("linking to an item of another unit gives a mismatch", () => {
    const r = first(buildReview([row({ name_as_written: "Kela", sold_by_as_written: "1 pc", price: 6 })], items, []));
    if (r.kind !== "new") throw new Error("expected new");
    expect(linkRow(r, items[1]!).kind).toBe("mismatch");
  });

  it("sends only ticked, changed or new rows; no alias when the written name is an item name", () => {
    const rs = buildReview([
      row({ name_as_written: "Onion", price: 44 }),
      row({ name_as_written: "Tomato", price: 30 }),
      row({ name_as_written: "Kiwi", name_en: "Kiwi", name_hi: "कीवी", name_mr: "किवी", price: 120 }),
    ], items, []);
    expect(toApplyRows(rs)).toEqual([
      { kind: "update", item_id: "onion", price: 44 },
      { kind: "create", names: { name_en: "Kiwi", name_hi: "कीवी", name_mr: "किवी" }, unit: "kg", price: 120, alias: "Kiwi" },
    ]);
  });

  it("sends a ticked mismatch row as an update with the typed price", () => {
    const r = first(buildReview([row({ name_as_written: "Banana", sold_by_as_written: "1 pc", price: 6 })], items, []));
    if (r.kind !== "mismatch") throw new Error("expected mismatch");
    const ticked = { ...r, include: true, price: "7" };
    expect(toApplyRows([ticked])).toEqual([{ kind: "update", item_id: "banana", price: 7 }]);
  });

  it("reports invalid ticked rows", () => {
    const r = first(buildReview([row({ name_as_written: "Kiwi", name_en: "Kiwi", name_hi: "", name_mr: "किवी", price: 120 })], items, []));
    expect(rowError(r)).toBe("rateList.needNames");
    expect(rowError({ ...r, include: false } as typeof r)).toBeNull();
    const u = first(buildReview([row({ name_as_written: "Onion", price: 44 })], items, []));
    expect(rowError({ ...u, price: "0" } as typeof u)).toBe("rateList.badPrice");
  });

  it("relinking a new row to an item another row targets makes the earlier one a duplicate", () => {
    const rs = buildReview([
      row({ name_as_written: "Onion", price: 41 }),
      row({ name_as_written: "Pyaz Lal", price: 43 }),
    ], items, []);
    const out = relinkReview(rs, 1, items[0]!);
    expect(out[0]!.kind).toBe("duplicate");
    expect(out[1]!.kind === "update" && out[1]!.item.id).toBe("onion");
    const back = relinkReview(rs.slice().reverse().map((r, i) => ({ ...r, key: i })) as typeof rs, 0, items[0]!);
    expect(back[0]!.kind).toBe("duplicate");
    expect(back[1]!.kind).toBe("update");
  });
});

describe("low-confidence rows", () => {
  it("start unticked so the admin must choose to update them", () => {
    const items = [{ id: "1", name_en: "Onion", name_hi: "", name_mr: "", unit: "kg", price: 30 }] as never;
    const [u, n] = buildReview([
      row({ name_as_written: "Onion", name_en: "Onion", sold_by_as_written: "1 kg", price: 40, confidence: "low" }),
      row({ name_as_written: "Kiwi", name_en: "Kiwi", sold_by_as_written: "1 kg", price: 90, confidence: "low" }),
    ], items, []);
    expect([u!.kind, n!.kind]).toEqual(["update", "new"]);
    expect(u!.kind === "update" && u!.include).toBe(false);
    expect(n!.kind === "new" && n!.include).toBe(false);
  });
});
