/**
 * Formats a rupee amount for display.
 *
 * rupees() only formats -- it never rounds. Rounding to paise is billing.ts's job
 * (lineTotal/runningTotal, matching bill_items.line_total's numeric(10,2)), and doing it
 * again here would risk the displayed figure drifting from the stored one if the two
 * rounding rules ever disagreed. This function trusts the number it is given.
 *
 * en-IN both fixes the two decimal places every rupee amount needs and groups digits the
 * Indian way (1,23,456 rather than 123,456) -- this is an app for Indian shops.
 */
export function rupees(n: number): string {
  return `₹${n.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
