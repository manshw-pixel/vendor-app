// Pure logic for read-rate-list. No Deno or network APIs here, so the web vitest suite can
// import and test it -- there is no Deno runtime locally (see admin-create-user).

export type ErrorCode = "not_admin" | "bad_request" | "read_failed" | "not_configured";
export type RateImage = { media_type: "image/jpeg" | "image/png" | "image/webp"; data: string };
export type ExtractedRow = {
  name_as_written: string; sold_by_as_written: string; price: number;
  name_en: string; name_hi: string; name_mr: string; confidence: "high" | "low";
};

export const MAX_IMAGES = 5;
export const MAX_IMAGE_CHARS = 2_000_000;
export const DEFAULT_MODEL = "gemini-2.5-flash";
const TYPES = ["image/jpeg", "image/png", "image/webp"];

export function validateReadRequest(body: unknown):
  { ok: true; images: RateImage[] } | { ok: false; code: "bad_request" } {
  const bad = { ok: false as const, code: "bad_request" as const };
  const images = (body as { images?: unknown } | null)?.images;
  if (!Array.isArray(images) || images.length < 1 || images.length > MAX_IMAGES) return bad;
  for (const i of images) {
    const m = i as { media_type?: unknown; data?: unknown };
    if (typeof m?.media_type !== "string" || !TYPES.includes(m.media_type)) return bad;
    if (typeof m.data !== "string" || m.data.length === 0 || m.data.length > MAX_IMAGE_CHARS) return bad;
  }
  return { ok: true, images: images as RateImage[] };
}

const PROMPT = `You are reading a vegetable and fruit vendor's daily rate list (printed, handwritten, a board, or a phone screenshot; English, Hindi or Marathi).
Return one entry per item line. For each:
- name_as_written: the item name exactly as written.
- sold_by_as_written: the quantity/unit the price is for, exactly as written (e.g. "1 kg", "250 g", "12 pc", "1 box", "bunch"), or "" if none is written.
- price: the price as a number exactly as written, with no conversion.
- name_en, name_hi, name_mr: the item's common name in English, Hindi (Devanagari) and Marathi (Devanagari).
- confidence: "low" if any part was hard to read, else "high".
Skip headings, dates, totals and anything that is not an item with a price.`;

const SCHEMA = {
  type: "ARRAY",
  items: {
    type: "OBJECT",
    properties: {
      name_as_written: { type: "STRING" }, sold_by_as_written: { type: "STRING" }, price: { type: "NUMBER" },
      name_en: { type: "STRING" }, name_hi: { type: "STRING" }, name_mr: { type: "STRING" },
      confidence: { type: "STRING", enum: ["high", "low"] },
    },
    required: ["name_as_written", "sold_by_as_written", "price", "name_en", "name_hi", "name_mr", "confidence"],
  },
};

export function geminiRequest(images: RateImage[]): unknown {
  return {
    contents: [{ parts: [{ text: PROMPT }, ...images.map((i) => ({ inline_data: { mime_type: i.media_type, data: i.data } }))] }],
    // thinkingBudget 0: transcribing a list needs no reasoning, and 2.5 Flash's default
    // thinking made a single photo take ~36 s.
    generationConfig: {
      responseMimeType: "application/json", responseSchema: SCHEMA, temperature: 0,
      thinkingConfig: { thinkingBudget: 0 },
    },
  };
}

export function geminiUrl(model: string): string {
  return `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
}

const str = (v: unknown) => (typeof v === "string" ? v : "");

export function parseGeminiResponse(json: unknown):
  { ok: true; rows: ExtractedRow[] } | { ok: false; code: "read_failed" } {
  const fail = { ok: false as const, code: "read_failed" as const };
  const text = (json as { candidates?: { content?: { parts?: { text?: unknown }[] } }[] } | null)
    ?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (typeof text !== "string") return fail;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.replace(/^\s*```(?:json)?\s*/i, "").replace(/\s*```\s*$/, ""));
  } catch {
    return fail;
  }
  if (!Array.isArray(parsed)) return fail;
  const rows: ExtractedRow[] = [];
  for (const p of parsed) {
    const o = (p ?? {}) as Record<string, unknown>;
    const price = typeof o.price === "number" ? o.price : Number(o.price);
    const name = str(o.name_as_written).trim();
    if (!name || !Number.isFinite(price) || price <= 0) continue;
    rows.push({
      name_as_written: name, sold_by_as_written: str(o.sold_by_as_written), price,
      name_en: str(o.name_en), name_hi: str(o.name_hi), name_mr: str(o.name_mr),
      confidence: o.confidence === "high" ? "high" : "low",
    });
  }
  return { ok: true, rows };
}
