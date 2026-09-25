import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import "../i18n";
import { describeError } from "../errors";
import { rupees } from "../money";
import { listSyncIssues, resolveSyncIssue, type SyncIssue } from "../syncIssues";

/**
 * The admin-only follow-up list for what record_offline_bill (0024) could not reconcile
 * cleanly when a device's queue synced. Same list/empty/error layout as Dues.tsx.
 */
export default function SyncIssues() {
  const { t } = useTranslation();
  const [rows, setRows] = useState<SyncIssue[] | null>(null);
  const [problem, setProblem] = useState<{ key: string; detail: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    const { data, error } = await listSyncIssues();
    setProblem(describeError(error));
    setRows(data);
  }, []);

  useEffect(() => { void load(); }, [load]);

  async function act(id: string, action: "add_as_due" | "dismiss") {
    if (busy) return;
    setBusy(id);
    try {
      const { error } = await resolveSyncIssue(id, action);
      if (error) setProblem(describeError(error));
      await load();
    } finally {
      setBusy(null);
    }
  }

  function sentence(row: SyncIssue): string {
    if (row.kind === "rebooked_closed_day") {
      return t("syncIssues.kind.rebooked_closed_day", {
        from: String(row.detail.from ?? ""), to: String(row.detail.to ?? ""),
      });
    }
    if (row.kind === "time_clamped") return t("syncIssues.kind.time_clamped");
    return t(`syncIssues.kind.${row.kind}`, { amount: rupees(row.amount ?? 0) });
  }

  return (
    <div className="space-y-4">
      <h1 className="text-lg font-semibold text-slate-800">{t("nav.syncIssues")}</h1>

      {problem && (
        <p data-testid="sync-issues-problem" className="border border-red-200 bg-red-50 rounded-xl p-3 text-sm text-red-700">
          {t(problem.key)} <span className="text-xs text-slate-500">{problem.detail}</span>
        </p>
      )}

      {rows && rows.length === 0 && !problem && (
        <p className="text-sm text-slate-500">{t("syncIssues.empty")}</p>
      )}

      <ul className="divide-y divide-slate-100 border border-slate-200 rounded-xl bg-white">
        {rows?.map((row) => (
          <li key={row.id} className="px-3 py-3 space-y-2">
            <div className="flex items-center justify-between gap-2">
              <span className="font-medium text-slate-800">
                #{row.token_no}{row.customer_name ? ` · ${row.customer_name}` : ""}
              </span>
            </div>
            <p className="text-sm text-slate-600">{sentence(row)}</p>
            <div className="flex items-center gap-2">
              {row.kind === "redeem_shortfall" && row.customer_name && (
                <button
                  onClick={() => void act(row.id, "add_as_due")}
                  disabled={busy === row.id}
                  className="border border-slate-300 rounded-lg px-3 py-2 bg-white min-h-[44px] disabled:opacity-50"
                >
                  {t("syncIssues.addAsDue")}
                </button>
              )}
              <button
                onClick={() => void act(row.id, "dismiss")}
                disabled={busy === row.id}
                className="border border-slate-300 rounded-lg px-3 py-2 bg-white min-h-[44px] disabled:opacity-50"
              >
                {t("syncIssues.dismiss")}
              </button>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
