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
  // bills.recorder_id/biller_id reference app_users with no ON DELETE clause
  // (0001_schema.sql:75-76), i.e. NO ACTION -- a restrict. Deleting anyone who has ever
  // recorded or completed a bill fails here, which is the common case in a working shop,
  // not an edge case, so it needs its own message rather than falling through to unknown.
  // Gated on "app_users" the same way the 23505 branch above is gated on "customers" --
  // describeError is shared with the billing flow, and any OTHER foreign-key violation
  // (e.g. a bill_items insert racing a vanished item row) must not claim staff history.
  if (error.code === "23503" && /app_users/.test(detail)) {
    return { key: "error.staffHasHistory", detail };
  }
  // clear_vendor_data (the "Clear all data" button) deletes points_ledger before a
  // concurrent complete_bill inserts a redemption row against a bill it is still
  // completing. The insert then fails this constraint and the whole transaction rolls
  // back -- nothing is actually lost -- but with no branch of its own it fell through to
  // the generic message on the one button in the app with no undo. Gated on
  // "points_ledger", the table/constraint actually named in that error, after the
  // app_users branch above so the common staff-has-history case is unaffected.
  if (error.code === "23503" && /points_ledger/.test(detail)) {
    return { key: "error.clearRace", detail };
  }
  // A function the database does not have. This is what every dashboard card returned in
  // production while migration 0007 sat unpushed: three identical "something went wrong"
  // messages for a cause with a one-command remedy. Matched on the message as well as the
  // code, because PostgREST has not always used PGRST202 for it and the wording has
  // outlived the code across versions.
  if (error.code === "PGRST202" || /could not find the function/i.test(detail)) {
    return { key: "error.migrationMissing", detail };
  }
  if (/failed to fetch|networkerror|load failed/i.test(detail)) {
    return { key: "error.offline", detail };
  }
  return { key: "error.unknown", detail };
}
