import { describe, it, expect } from "vitest";
import {
  validateReadRequest, geminiRequest, geminiUrl, parseGeminiResponse, MAX_IMAGES, DEFAULT_MODEL,
} from "../../../supabase/functions/read-rate-list/guards";

const img = { media_type: "image/jpeg", data: "QUJD" } as const;

describe("validateReadRequest", () => {
  it("accepts 1..5 jpeg/png/webp images", () => {
    expect(validateReadRequest({ images: [img] }).ok).toBe(true);
    expect(validateReadRequest({ images: Array(MAX_IMAGES).fill(img) }).ok).toBe(true);
  });
  it.each([
    [{}], [{ images: [] }], [{ images: Array(MAX_IMAGES + 1).fill(img) }],
    [{ images: [{ media_type: "image/gif", data: "QUJD" }] }], [{ images: [{ media_type: "image/jpeg", data: "" }] }],
    [{ images: [{ media_type: "image/jpeg", data: "x".repeat(2_000_001) }] }], [null],
  ])("refuses %j", (body) => {
    expect(validateReadRequest(body)).toEqual({ ok: false, code: "bad_request" });
  });
});

describe("geminiRequest / geminiUrl", () => {
  it("asks for JSON with a schema and inlines every image", () => {
    const body = geminiRequest([img, img]) as {
      contents: { parts: Array<{ text?: string; inline_data?: { mime_type: string; data: string } }> }[];
      generationConfig: { responseMimeType: string; responseSchema: unknown; temperature: number; thinkingConfig: { thinkingBudget: number } };
    };
    const parts = body.contents[0]!.parts;
    expect(parts.filter((p) => p.inline_data).length).toBe(2);
    expect(parts[0]!.text).toMatch(/rate list/i);
    expect(body.generationConfig.responseMimeType).toBe("application/json");
    expect(body.generationConfig.temperature).toBe(0);
    // Reading a list needs no reasoning; thinking made one photo take 36 s.
    expect(body.generationConfig.thinkingConfig.thinkingBudget).toBe(0);
    expect(JSON.stringify(body.generationConfig.responseSchema)).toContain("sold_by_as_written");
  });
  it("puts the model in the path and no key in the URL", () => {
    expect(geminiUrl(DEFAULT_MODEL)).toBe(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent");
  });
});

const reply = (text: string) => ({ candidates: [{ content: { parts: [{ text }] } }] });
const good = { name_as_written: "Onion", sold_by_as_written: "1 kg", price: 40, name_en: "Onion", name_hi: "प्याज", name_mr: "कांदा", confidence: "high" };

describe("parseGeminiResponse", () => {
  it("returns rows from the JSON text", () => {
    expect(parseGeminiResponse(reply(JSON.stringify([good])))).toEqual({ ok: true, rows: [{ ...good, struck_out: "" }] });
  });
  it("keeps the struck-out words the reader reports", () => {
    const r = parseGeminiResponse(reply(JSON.stringify([{ ...good, name_as_written: "Apple Green", struck_out: " Queen " }])));
    expect(r.ok && [r.rows[0]!.name_as_written, r.rows[0]!.struck_out]).toEqual(["Apple Green", "Queen"]);
  });
  it("tolerates a markdown fence", () => {
    expect(parseGeminiResponse(reply("```json\n" + JSON.stringify([good]) + "\n```")).ok).toBe(true);
  });
  it("drops rows with no name or a non-positive price, and coerces a numeric-string price", () => {
    const r = parseGeminiResponse(reply(JSON.stringify([
      good, { ...good, name_as_written: " " }, { ...good, price: 0 }, { ...good, price: "35" },
    ])));
    expect(r.ok && r.rows.map((x) => x.price)).toEqual([40, 35]);
  });
  it("defaults missing optional strings and an unknown confidence to low", () => {
    const r = parseGeminiResponse(reply(JSON.stringify([{ name_as_written: "Kiwi", price: 10 }])));
    expect(r.ok && r.rows[0]).toEqual({ name_as_written: "Kiwi", sold_by_as_written: "", price: 10, name_en: "", name_hi: "", name_mr: "", confidence: "low", struck_out: "" });
  });
  it("returns an empty list for []", () => {
    expect(parseGeminiResponse(reply("[]"))).toEqual({ ok: true, rows: [] });
  });
  it.each([[{}], [{ candidates: [] }], [reply("not json")], [reply("{\"a\":1}")], [null]])("fails on %j", (j) => {
    expect(parseGeminiResponse(j)).toEqual({ ok: false, code: "read_failed" });
  });
});

describe("struck-out names and unavailable items", () => {
  const prompt = () => JSON.stringify(geminiRequest([{ media_type: "image/jpeg", data: "x" }]));
  it("tells the model to drop struck-out words and skip dash-priced items", () => {
    expect(prompt()).toContain("struck out");
    expect(prompt()).toContain("different colour");
    expect(prompt()).toContain('\\"-\\"');
  });
  it("drops a row whose price came back as a dash or zero", () => {
    const wrap = (rows: unknown[]) => ({ candidates: [{ content: { parts: [{ text: JSON.stringify(rows) }] } }] });
    const r = parseGeminiResponse(wrap([{ ...good, price: "-" }, { ...good, price: 0 }, good]));
    expect(r.ok && r.rows.length).toBe(1);
  });
});
