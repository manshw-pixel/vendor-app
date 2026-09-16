import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { listRequests, logRequest, markHandled, normaliseItemName, type StockRequest } from "../requests";
import { useSession } from "../components/SessionProvider";
import { describeError } from "../errors";
import "../i18n";

export default function Requests() {
  const { t } = useTranslation();
  const session = useSession();
  const [rows, setRows] = useState<StockRequest[]>([]);
  const [draft, setDraft] = useState("");
  const [showHandled, setShowHandled] = useState(false);
  const [busy, setBusy] = useState(true);
  const [problem, setProblem] = useState<{ key: string; detail: string } | null>(null);

  const load = useCallback(async () => {
    setBusy(true);
    const { data, error } = await listRequests();
    setBusy(false);
    setProblem(describeError(error));
    setRows((data ?? []) as StockRequest[]);
  }, []);

  useEffect(() => { void load(); }, [load]);

  const clean = normaliseItemName(draft);

  async function submit() {
    // vendorId lives only on the "ready" variant of the session union; narrowing here
    // is what makes it readable at all. App.tsx never renders a screen in another state,
    // so this guard is a type narrowing, not a runtime branch anyone reaches.
    if (clean === "" || session.kind !== "ready") return;
    setBusy(true);
    const { error } = await logRequest(session.vendorId, clean);
    setBusy(false);
    if (error) { setProblem(describeError(error)); return; }
    setDraft("");
    setProblem(null);
    await load();
  }

  async function handle(id: string) {
    const { error } = await markHandled(id);
    if (error) { setProblem(describeError(error)); return; }
    // Patch in place rather than refetching: the list can be 200 rows and the only
    // thing that changed is one field.
    setRows((all) => all.map((r) => (r.id === id ? { ...r, status: "handled" } : r)));
  }

  const open = rows.filter((r) => r.status === "open");
  const handled = rows.filter((r) => r.status === "handled");

  return (
    <div className="space-y-4">
      <div>
        <h2 className="font-semibold text-slate-800">{t("req.title")}</h2>
        <p className="text-xs text-slate-500">{t("req.hint")}</p>
      </div>

      <div className="flex gap-2">
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") void submit(); }}
          placeholder={t("req.placeholder")}
          data-testid="req-input"
          className="flex-1 border border-slate-300 rounded-lg px-3 min-h-[44px]"
        />
        <button
          onClick={() => void submit()}
          disabled={clean === "" || busy}
          data-testid="req-log"
          className="bg-green-600 text-white rounded-lg px-4 min-h-[44px] disabled:opacity-50"
        >
          {t("req.log")}
        </button>
      </div>

      {problem && (
        <div className="bg-red-50 border border-red-200 rounded-lg p-3">
          <p className="text-sm text-red-700">{t(problem.key)}</p>
          {problem.detail && (
            <p data-testid="req-problem-detail" className="text-xs text-red-600 mt-1 break-words">
              {t("error.details")}: {problem.detail}
            </p>
          )}
        </div>
      )}

      {busy && <p className="text-sm text-slate-500">{t("req.loading")}</p>}

      {!busy && rows.length === 0 && <p className="text-sm text-slate-500">{t("req.empty")}</p>}

      <ul className="space-y-2">
        {open.map((r) => (
          <li key={r.id} data-testid={`req-open-${r.id}`}
              className="bg-white border border-slate-200 rounded-xl p-3 flex items-center justify-between gap-3">
            <span className="text-slate-800 break-words">{r.item_name}</span>
            <button onClick={() => void handle(r.id)}
                    className="border border-slate-300 rounded-lg px-3 text-sm min-h-[44px] whitespace-nowrap">
              {t("req.markHandled")}
            </button>
          </li>
        ))}
      </ul>

      {handled.length > 0 && (
        <button onClick={() => setShowHandled((s) => !s)}
                data-testid="req-toggle-handled"
                className="text-sm text-slate-600 underline min-h-[44px]">
          {showHandled ? t("req.hideHandled") : t("req.showHandled", { n: handled.length })}
        </button>
      )}

      {showHandled && (
        <ul className="space-y-2">
          {handled.map((r) => (
            <li key={r.id} data-testid={`req-handled-${r.id}`}
                className="bg-slate-50 border border-slate-200 rounded-xl p-3 text-slate-500 line-through">
              {r.item_name}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
