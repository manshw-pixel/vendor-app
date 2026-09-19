/**
 * Pure rules for the owner console. No supabase import, no React.
 *
 * Duplicates owner-create-vendor's guards on purpose: the round trip creates a real shop
 * and a real auth account, so an obvious slip should be named against its field first.
 * MIN_PASSWORD_LENGTH is IMPORTED rather than restated so the two cannot drift.
 */
import {
  MIN_PASSWORD_LENGTH,
  type CreateVendorRequest,
} from "../../supabase/functions/owner-create-vendor/guards";

export type NewVendorInput = {
  vendorName: string;
  address: string;
  phone: string;
  adminName: string;
  email: string;
  password: string;
};
export type NewVendorField = keyof NewVendorInput;

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function optional(raw: string): string | null {
  const s = raw.trim();
  return s === "" ? null : s;
}

export function validateNewVendor(
  input: NewVendorInput,
):
  | { ok: true; value: CreateVendorRequest }
  | { ok: false; errors: Partial<Record<NewVendorField, string>> } {
  const errors: Partial<Record<NewVendorField, string>> = {};

  if (input.vendorName.trim() === "") errors.vendorName = "owner.required";
  if (input.adminName.trim() === "") errors.adminName = "owner.required";
  const email = input.email.trim().toLowerCase();
  if (email === "") errors.email = "owner.required";
  else if (!EMAIL.test(email)) errors.email = "owner.badEmail";
  // Not trimmed: trimming silently changes the credential the owner read out loud.
  if (input.password === "") errors.password = "owner.required";
  else if (input.password.length < MIN_PASSWORD_LENGTH) errors.password = "owner.weakPassword";

  if (Object.keys(errors).length > 0) return { ok: false, errors };
  return {
    ok: true,
    value: {
      vendor: {
        name: input.vendorName.trim(),
        address: optional(input.address),
        phone: optional(input.phone),
      },
      admin: { name: input.adminName.trim(), email, password: input.password },
    },
  };
}
