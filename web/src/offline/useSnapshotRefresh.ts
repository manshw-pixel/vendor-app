import { useEffect } from "react";
import { refreshSnapshot } from "./catalogue";

/** Keeps this device's catalogue snapshot (prices, stock, balances) fresh for every role,
 *  not just when Bill happens to mount online: on mount, on window focus, and when the
 *  network comes back -- each only while online. A session restored from cache has no
 *  verified token, so it does not try. Failures are ignored: the old snapshot stays. */
export function useSnapshotRefresh(vendorId: string | null, fromCache: boolean): void {
  useEffect(() => {
    if (!vendorId || fromCache) return;
    const refresh = () => {
      if (!navigator.onLine) return;
      void refreshSnapshot(vendorId).catch(() => {});
    };
    refresh();
    window.addEventListener("focus", refresh);
    window.addEventListener("online", refresh);
    return () => {
      window.removeEventListener("focus", refresh);
      window.removeEventListener("online", refresh);
    };
  }, [vendorId, fromCache]);
}
