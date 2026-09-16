import { useEffect, useState } from "react";
import { supabase } from "./supabase";

const EVERY_MS = 5 * 60 * 1000;

/**
 * #9, the low-stock bell. Polls rather than subscribing to Realtime.
 *
 * Stock crosses 10 kg a few times a day, and an admin who learns of it four minutes
 * later restocks at the same moment as one told instantly. Realtime buys nothing
 * operationally here and costs the riskiest thing in the slice: a Realtime policy that
 * mishandles vendor_id is a cross-tenant leak, which is the single failure the RLS suite
 * exists to prevent.
 *
 * The threshold lives in v_low_stock. The client never learns the number 10.
 */
export function useLowStock(enabled: boolean): number {
  const [count, setCount] = useState(0);

  useEffect(() => {
    if (!enabled) return;
    let alive = true;

    const read = async () => {
      const { count: n, error } = await supabase
        .from("v_low_stock")
        .select("id", { count: "exact", head: true });
      // A failed poll leaves the last good count on screen rather than flashing 0 --
      // a badge that blinks to zero on a dropped connection reads as "restocked".
      if (alive && !error && typeof n === "number") setCount(n);
    };

    void read();
    const timer = setInterval(() => void read(), EVERY_MS);
    window.addEventListener("focus", read);
    return () => {
      alive = false;
      clearInterval(timer);
      window.removeEventListener("focus", read);
    };
  }, [enabled]);

  return count;
}
