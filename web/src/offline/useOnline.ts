import { useEffect, useState } from "react";

/** navigator.onLine is only ever a NEGATIVE signal worth trusting: false means there is
 *  certainly no network, true means only that an interface is up. That is enough for the
 *  one decision it makes here -- refusing to promise a token the shop cannot get. */
export function useOnline(): boolean {
  const [online, setOnline] = useState(() => navigator.onLine);
  useEffect(() => {
    const up = () => setOnline(true);
    const down = () => setOnline(false);
    window.addEventListener("online", up);
    window.addEventListener("offline", down);
    return () => {
      window.removeEventListener("online", up);
      window.removeEventListener("offline", down);
    };
  }, []);
  return online;
}
