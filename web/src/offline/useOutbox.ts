import { useCallback, useEffect, useRef, useState } from "react";
import { supabase } from "../supabase";
import { flush, listOutbox } from "./outbox";

const MIN = 5_000, MAX = 300_000;

export function useOutbox(vendorId: string | null) {
  const [counts, setCounts] = useState({ waiting: 0, attention: 0 });
  const delay = useRef(MIN);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const busy = useRef(false);

  const recount = useCallback(async () => {
    if (!vendorId) return;
    const all = await listOutbox(vendorId);
    const waiting = all.filter((b) => b.state === "waiting").length;
    setCounts({ waiting, attention: all.length - waiting });
    return waiting;
  }, [vendorId]);

  const run = useCallback(async () => {
    if (!vendorId || busy.current) return;
    busy.current = true;
    try {
      if (timer.current) clearTimeout(timer.current);
      if (navigator.onLine) {
        await supabase.auth.getSession(); // refreshes an expired token before sending
        const r = await flush(vendorId);
        delay.current = r.stoppedOffline ? Math.min(delay.current * 2, MAX) : MIN;
      }
      const waiting = await recount();
      if (waiting) timer.current = setTimeout(() => void run(), delay.current);
    } finally { busy.current = false; }
  }, [vendorId, recount]);

  useEffect(() => {
    void run();
    const on = () => void run();
    window.addEventListener("online", on);
    window.addEventListener("focus", on);
    window.addEventListener("outbox-changed", on);
    return () => {
      window.removeEventListener("online", on);
      window.removeEventListener("focus", on);
      window.removeEventListener("outbox-changed", on);
      if (timer.current) clearTimeout(timer.current);
    };
  }, [run]);

  return { ...counts, flushNow: () => void run() };
}
