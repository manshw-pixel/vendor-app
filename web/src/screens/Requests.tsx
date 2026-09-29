import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { listRequests, logRequest, markHandled, normaliseItemName, type StockRequest } from "../requests";
import { useSession } from "../components/SessionProvider";
import { describeError } from "../errors";
import { Button } from "../ui/Button";
import { Banner } from "../ui/Banner";
import { Spinner } from "../ui/Spinner";
import { EmptyState } from "../ui/EmptyState";
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
        <Button
          onClick={() => void submit()}
          disabled={clean === "" || busy}
          data-testid="req-log"
        >
          {t("req.log")}
        </Button>
      </div>

      {problem && (
        <Banner tone="error">
          {t(problem.key)}
          {problem.detail && (
            <p data-testid="req-problem-detail" className="text-xs mt-1 break-words">
              {t("error.details")}: {problem.detail}
            </p>
          )}
        </Banner>
      )}

      {busy && <Spinner label={t("req.loading")} />}

      {!busy && rows.length === 0 && <EmptyState>{t("req.empty")}</EmptyState>}

      {open.length > 0 && <h3 className="text-sm text-slate-500">{t("req.open")}</h3>}

      <ul className="space-y-2">
        {open.map((r) => (
          <li key={r.id} data-testid={`req-open-${r.id}`}
              className="bg-surface border border-slate-200 rounded-xl p-3 flex items-center justify-between gap-3">
            <span className="text-slate-800 break-words">{r.item_name}</span>
            <Button variant="secondary" onClick={() => void handle(r.id)}
                    className="whitespace-nowrap">
              {t("req.markHandled")}
            </Button>
          </li>
        ))}
      </ul>

      {handled.length > 0 && (
        <Button variant="ghost" onClick={() => setShowHandled((s) => !s)}
                data-testid="req-toggle-handled"
                className="underline">
          {showHandled ? t("req.hideHandled") : t("req.showHandled", { n: handled.length })}
        </Button>
      )}

      {showHandled && (
        <>
          <h3 className="text-sm text-slate-500">{t("req.handled")}</h3>
          <ul className="space-y-2">
            {handled.map((r) => (
              <li key={r.id} data-testid={`req-handled-${r.id}`}
                  className="bg-slate-50 border border-slate-200 rounded-xl p-3 text-slate-500 line-through">
                {r.item_name}
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
