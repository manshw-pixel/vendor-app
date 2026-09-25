/** Turns the server's refusal of a synced offline bill into something the biller can act
 *  on. Unknown messages pass through unchanged -- raw text beats a vague "something went
 *  wrong" when someone has to report it. */
export function friendlyOutboxError(message: string, t: (key: string) => string): string {
  if (/day is closed/i.test(message)) return t("offline.err.dayClosed");
  if (/no longer exists/i.test(message)) return t("offline.err.gone");
  if (/jwt|auth|401/i.test(message)) return t("offline.err.signIn");
  return message;
}
