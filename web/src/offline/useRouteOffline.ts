import { useSession } from "../components/SessionProvider";
import { useOnline } from "./useOnline";

/** Whether routing should offer only the offline routes: no network, or a session opened
 *  from the device cache that the server has not re-checked yet. */
export function useRouteOffline(): boolean {
  const online = useOnline();
  const s = useSession();
  return !online || (s.kind === "ready" && !!s.fromCache);
}
