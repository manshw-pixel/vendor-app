import { supabase } from "./supabase";
import { codeFrom } from "./functionErrors";
import type { Unit } from "./units";
import type { ExtractedRow, ApplyRow, Alias } from "./rateListMatch";
import type { ErrorCode, RateImage } from "../../supabase/functions/read-rate-list/guards";
import { MAX_IMAGE_CHARS } from "../../supabase/functions/read-rate-list/guards";

/**
 * The only module that calls the read-rate-list Edge Function, the apply_price_list RPC and
 * the item_aliases table. Kept out of rateListMatch.ts (pure logic, unit-tested without a
 * network) for the same reason adminApi.ts is split from adminRules.ts.
 */

const KEYS: Record<ErrorCode, string> = {
  not_admin: "error.notAllowed",
  bad_request: "error.unknown",
  read_failed: "rateList.readFailed",
  not_configured: "rateList.notConfigured",
};

export type ApplyResult = {
  // PostgREST may return these numeric fields as strings; callers wrap them with Number().
  updated: { item_id: string; name_en: string; name_hi: string; name_mr: string; unit: Unit; old_price: number; new_price: number }[];
  created: { item_id: string; name_en: string; name_hi: string; name_mr: string; unit: Unit; price: number }[];
  unchanged: number;
};

/**
 * Sends photos of a rate list to the read-rate-list Edge Function for extraction.
 */
export async function readRateList(
  images: RateImage[],
): Promise<{ rows: ExtractedRow[] | null; error: { key: string; detail: string } | null }> {
  const { data, error } = await supabase.functions.invoke("read-rate-list", { body: { images } });
  if (error) {
    return { rows: null, error: { key: await codeFrom(error, KEYS), detail: error.message ?? "" } };
  }
  return { rows: (data as { rows: ExtractedRow[] }).rows, error: null };
}

/**
 * All item aliases, used to match a rate-list line to an existing item by a name other than
 * its recorded ones.
 */
export async function listAliases(): Promise<{ data: Alias[] | null; error: unknown }> {
  const { data, error } = await supabase.from("item_aliases").select("alias, item_id");
  return { data: data as Alias[] | null, error };
}

/**
 * Applies the reviewed rows: updates existing items' prices and creates new items.
 */
export async function applyPriceList(rows: ApplyRow[]): Promise<{ data: ApplyResult | null; error: unknown }> {
  const { data, error } = await supabase.rpc("apply_price_list", { p_rows: rows });
  return { data: data as ApplyResult | null, error };
}

/**
 * Downscales a photo before it is sent to the Edge Function, so the base64 payload stays
 * under MAX_IMAGE_CHARS. Retries at smaller sides because a photo that is still too big at
 * 1600px (dense detail, or a phone's default JPEG quality) needs another pass, not a failure.
 */
export async function downscale(file: File, maxSide = 1600): Promise<RateImage> {
  const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  try {
    for (const side of [maxSide, 1200, 900]) {
      const scale = Math.min(1, side / Math.max(bitmap.width, bitmap.height));
      const width = Math.max(1, Math.round(bitmap.width * scale));
      const height = Math.max(1, Math.round(bitmap.height * scale));
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new Error("canvas unavailable");
      ctx.drawImage(bitmap, 0, 0, width, height);
      const dataUrl = canvas.toDataURL("image/jpeg", 0.8);
      const data = dataUrl.replace(/^data:image\/jpeg;base64,/, "");
      if (data.length <= MAX_IMAGE_CHARS || side === 900) {
        return { media_type: "image/jpeg", data };
      }
    }
    throw new Error("unreachable");
  } finally {
    bitmap.close();
  }
}
