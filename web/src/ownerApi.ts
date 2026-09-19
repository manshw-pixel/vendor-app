import { supabase } from "./supabase";
import { codeFrom } from "./functionErrors";
import type {
  CreateVendorRequest,
  ErrorCode as CreateErrorCode,
} from "../../supabase/functions/owner-create-vendor/guards";
import type {
  ErrorCode as SuspendErrorCode,
  SuspendRequest,
} from "../../supabase/functions/owner-suspend-vendor/guards";

/** One row of owner_vendor_summary(). Numerics arrive from PostgREST as strings. */
export type VendorSummary = {
  id: string;
  name: string;
  created_at: string;
  suspended_at: string | null;
  staff_count: string | number;
  bills_month: string | number;
  sales_month: string | number;
  last_bill_at: string | null;
};

export async function listVendorSummary(): Promise<{
  data: VendorSummary[] | null;
  error: { code?: string; message?: string } | null;
}> {
  const { data, error } = await supabase.rpc("owner_vendor_summary");
  return { data: (data as VendorSummary[] | null) ?? null, error };
}

const CREATE_KEYS: Record<CreateErrorCode, string> = {
  not_owner: "error.notAllowed",
  email_taken: "error.emailTaken",
  weak_password: "error.weakPassword",
  bad_request: "error.unknown",
  vendor_failed: "owner.vendorNotCreated",
  create_failed: "owner.adminNotCreated",
  // The admin account exists but is not linked; the compensating delete may have failed.
  link_failed: "owner.vendorPartlyCreated",
};

/** Creates a shop and its first admin through owner-create-vendor. */
export async function createVendor(
  value: CreateVendorRequest,
): Promise<{ error: { key: string; detail: string } | null }> {
  const { error } = await supabase.functions.invoke("owner-create-vendor", { body: value });
  if (!error) return { error: null };
  return { error: { key: await codeFrom(error, CREATE_KEYS), detail: error.message ?? "" } };
}

const SUSPEND_KEYS: Record<SuspendErrorCode, string> = {
  not_owner: "error.notAllowed",
  bad_request: "error.unknown",
  not_found: "owner.vendorNotFound",
  update_failed: "error.unknown",
};

export type SuspendOutcome = { banned: number; failed: number; bans_skipped?: boolean };

/** Suspends or reinstates a shop through owner-suspend-vendor. */
export async function setVendorSuspended(
  vendorId: string,
  action: SuspendRequest["action"],
): Promise<{ error: { key: string; detail: string } | null; outcome: SuspendOutcome | null }> {
  const body: SuspendRequest = { vendor_id: vendorId, action };
  const { data, error } = await supabase.functions.invoke("owner-suspend-vendor", { body });
  if (!error) return { error: null, outcome: (data as SuspendOutcome | null) ?? null };
  return {
    error: { key: await codeFrom(error, SUSPEND_KEYS), detail: error.message ?? "" },
    outcome: null,
  };
}
