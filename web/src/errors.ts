/**
 * Turns a PostgREST / Postgres error into a translation key plus the raw text.
 *
 * Two things this must keep straight, because conflating them hides bugs:
 *   - a policy-BLOCKED WRITE arrives as an error (42501);
 *   - a policy-FILTERED READ arrives as zero rows, not an error at all.
 * Callers rendering an empty list must say "nothing yet", never "not allowed".
 */
export function describeError(
  error: { message?: string; code?: string } | null,
): { key: string; detail: string } | null {
  if (!error) return null;
  const detail = error.message ?? "";

  if (error.code === "42501" || /row-level security/i.test(detail)) {
    return { key: "error.notAllowed", detail };
  }
  if (error.code === "23505" && /customers/.test(detail)) {
    return { key: "error.customerExists", detail };
  }
  if (error.code === "23505") {
    return { key: "error.duplicate", detail };
  }
  if (/failed to fetch|networkerror|load failed/i.test(detail)) {
    return { key: "error.offline", detail };
  }
  return { key: "error.unknown", detail };
}
