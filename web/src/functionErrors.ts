/**
 * Turns a supabase-js Edge Function error into an i18n key.
 *
 * supabase-js reports a non-2xx as a FunctionsHttpError whose body has to be read off
 * error.context. Shared by adminApi.ts and ownerApi.ts.
 *
 * Takes the map as an argument because each function has its own ErrorCode union; a
 * shared map would have to be the union of all, and a code from one would then silently
 * resolve against another's key.
 */
export async function codeFrom(
  error: { message?: string; context?: unknown },
  keys: Record<string, string>,
): Promise<string> {
  if (/failed to fetch|networkerror|load failed/i.test(error.message ?? "")) {
    return "error.offline";
  }
  const res = error.context;
  if (!(res instanceof Response)) return "error.unknown";
  try {
    const body = (await res.clone().json()) as { error?: string };
    const code = body.error;
    return (code && keys[code]) || "error.unknown";
  } catch {
    // A 502 from the platform or a gateway is HTML, not our JSON. Not knowing the cause
    // is itself the honest answer here.
    return "error.unknown";
  }
}
