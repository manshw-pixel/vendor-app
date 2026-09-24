/**
 * How a bill was paid. Pure and dependency-free so any screen can import it without a test
 * having to mock it -- Pending.test.tsx replaces "../data" wholesale, which would leave a
 * constant exported from there undefined.
 *
 * Order is the display order everywhere: the Pending buttons, the close screen, the
 * dashboard split.
 */
export type PaymentMode = "cash" | "upi" | "card" | "credit";
export const PAYMENT_MODES: readonly PaymentMode[] = ["cash", "upi", "card", "credit"];

/** A reporting label only: a done bill with no payment row (completed before 0021). */
export type SplitMode = PaymentMode | "unrecorded";
