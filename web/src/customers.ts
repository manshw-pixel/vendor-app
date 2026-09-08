export type Customer = {
  id: string;
  name: string;
  flat_no: string;
  mobile: string;
};

/** Filters an already-fetched list. The list is per-vendor because RLS scoped the query
 *  that produced it -- there is no vendor filter to apply here, and adding one would be
 *  a weaker second copy of customers_read. */
export function matchCustomers(all: readonly Customer[], query: string): Customer[] {
  const q = query.trim().toLowerCase();
  if (q === "") return [...all];
  return all.filter((c) =>
    c.name.toLowerCase().includes(q) ||
    c.flat_no.toLowerCase().includes(q) ||
    c.mobile.includes(q),
  );
}

const REQUIRED = ["name", "flat_no", "mobile"] as const;

export function validateCustomer(
  input: { name: string; flat_no: string; mobile: string },
): { ok: true } | { ok: false; missing: ("name" | "flat_no" | "mobile")[] } {
  // #11 makes all three mandatory. Report every missing field at once: a recorder with a
  // customer waiting should not learn about them one submit at a time.
  const missing = REQUIRED.filter((f) => input[f].trim() === "");
  return missing.length ? { ok: false, missing: [...missing] } : { ok: true };
}

export function isDuplicateMobile(error: { code?: string; message?: string } | null): boolean {
  if (!error || error.code !== "23505") return false;
  return /customers_vendor_id_mobile_key|customers.*mobile/i.test(error.message ?? "");
}
