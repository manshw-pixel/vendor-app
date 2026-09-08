/**
 * Formats a rupee amount for display.
 *
 * Formats to two decimal places; it does not define this app's rounding rule. Callers
 * must pass values already rounded to paise -- billing.ts's lineTotal/runningTotal do
 * this, matching bill_items.line_total's numeric(10,2). Note toLocaleString will round a
 * third decimal for display, so passing an unrounded value would show a figure that
 * quietly disagrees with the stored row.
 *
 * en-IN both fixes the two decimal places every rupee amount needs and groups digits the
 * Indian way (1,23,456 rather than 123,456) -- this is an app for Indian shops.
 */
export function rupees(n: number): string {
  return `₹${n.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
