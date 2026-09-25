import { supabase } from "./supabase";

/**
 * The owner's view of what record_offline_bill (0024) could not reconcile cleanly: a
 * points redemption or a due collection that turned out stale by the time the device
 * synced, a sale rebooked out of a closed day, or a clock-skewed device's time clamped
 * to the allowed window. Read via open_sync_issues, resolved via resolve_sync_issue.
 */
export type SyncIssueKind =
  | "redeem_shortfall" | "due_overcollected" | "rebooked_closed_day" | "time_clamped";

export type SyncIssue = {
  id: string; bill_id: string; token_no: number; kind: SyncIssueKind;
  amount: number | null; detail: Record<string, unknown>; created_at: string;
  customer_name: string | null;
};

type DbError = { message?: string; code?: string } | null;

export async function listSyncIssues(): Promise<{ data: SyncIssue[] | null; error: DbError }> {
  const { data, error } = await supabase.rpc("open_sync_issues");
  if (error) return { data: null, error };
  return {
    data: ((data ?? []) as Record<string, unknown>[]).map((r) => ({
      id: String(r.id), bill_id: String(r.bill_id), token_no: Number(r.token_no),
      kind: r.kind as SyncIssueKind,
      amount: r.amount == null ? null : Number(r.amount),
      detail: (r.detail ?? {}) as Record<string, unknown>,
      created_at: String(r.created_at),
      customer_name: r.customer_name == null ? null : String(r.customer_name),
    })),
    error: null,
  };
}

export async function resolveSyncIssue(id: string, action: "add_as_due" | "dismiss") {
  return supabase.rpc("resolve_sync_issue", { p_id: id, p_action: action });
}
