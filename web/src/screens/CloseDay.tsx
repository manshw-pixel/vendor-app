import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import "../i18n";
import { useSession } from "../components/SessionProvider";
import {
  closeDay, loadDaySummary, loadRecentCloses, loadUnclosedDays, notifyDayClosesChanged, reopenDay,
  type DaySummary,
} from "../dayClose";
import { differenceOf, formatBusinessDate, latestPerDate, parseCounted, type CloseRow } from "../closeRules";
import { PAYMENT_MODES } from "../payments";
import { describeError } from "../errors";
import { rupees } from "../money";

/**
 * End of day: what came in by each mode, the cash the drawer should hold, and a count to
 * compare against it. Closing locks the day for completions and voids (0021); only an
 * admin can reopen it. The server computes expected cash and picks "today" -- this screen
 * only displays and submits.
 */
export default function CloseDay() {
  const { t, i18n } = useTranslation();
  const session = useSession();
  const lang = i18n.language;

  // null = today, as the server defines it.
  const [date, setDate] = useState<string | null>(null);
  const [summary, setSummary] = useState<DaySummary | null>(null);
  const [closes, setCloses] = useState<CloseRow[]>([]);
  const [unclosed, setUnclosed] = useState<string[]>([]);
  const [problem, setProblem] = useState<{ key: string; detail: string } | null>(null);
  const [counted, setCounted] = useState("");
  const [note, setNote] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [reopening, setReopening] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const [loaded, setLoaded] = useState(false);

  // Which date the newest load was for; a slow load for a date the user has moved off must
  // not paint over the one they are looking at.
  const wanted = useRef<string | null>(null);
  // The date currently selected, mirrored outside state so submit()/reopen() -- whose
  // closures are fixed when the click that started them fired -- can reload whatever the
  // user is looking at when the RPC resolves, not whatever they were looking at when they
  // clicked. The pick buttons are also disabled while busy so this can only move if the
  // in-flight close/reopen has already finished.
  const currentDate = useRef<string | null>(null);
  currentDate.current = date;

  const load = useCallback(async (d: string | null) => {
    wanted.current = d;
    const [s, c, u] = await Promise.all([loadDaySummary(d ?? undefined), loadRecentCloses(), loadUnclosedDays()]);
    if (wanted.current !== d) return;
    setProblem(describeError(s.error) ?? describeError(c.error) ?? describeError(u.error));
    setSummary(s.data);
    setCloses(c.data ?? []);
    setUnclosed(u.data ?? []);
    setLoaded(true);
  }, []);

  useEffect(() => { void load(date); }, [date, load]);

  if (session.kind !== "ready") return null;
  const isAdmin = session.role === "admin";

  const active = summary
    ? closes.find((c) => c.business_date === summary.business_date && c.reopened_at === null) ?? null
    : null;
  const parsed = parseCounted(counted);
  const diff = parsed.ok && summary ? differenceOf(parsed.value, summary.expected_cash) : null;
  const needsNote = diff !== null && diff !== 0;
  const canSubmit = parsed.ok && (!needsNote || note.trim() !== "") && !busy;

  function pick(d: string | null) {
    setDate(d);
    setCounted("");
    setNote("");
    setConfirming(false);
    setProblem(null);
    setLoaded(false);
  }

  async function submit() {
    if (!summary || !parsed.ok) return;
    setConfirming(false);
    setBusy(true);
    const { error } = await closeDay(summary.business_date, parsed.value, note);
    setBusy(false);
    if (error) { setProblem(describeError(error)); return; }
    notifyDayClosesChanged();
    setCounted("");
    setNote("");
    // Reload whichever date is now selected, not the one captured when this handler
    // started -- the pick buttons are disabled while busy, but the RPC can still finish
    // after a rapid back-to-today click queued just before the disable took effect.
    await load(currentDate.current);
  }

  async function reopen(d: string) {
    setBusy(true);
    const { error } = await reopenDay(d, reason);
    setBusy(false);
    if (error) { setProblem(describeError(error)); return; }
    notifyDayClosesChanged();
    setReopening(null);
    setReason("");
    await load(currentDate.current);
  }

  const time = (iso: string) => new Date(iso).toLocaleTimeString(lang, { hour: "numeric", minute: "2-digit" });
  const history = latestPerDate(closes);
  const pastUnclosed = unclosed.filter((d) => d !== summary?.business_date);

  return (
    <div className="space-y-4">
      <h1 className="text-lg font-semibold text-slate-800">{t("close.title")}</h1>

      {problem && (
        <p className="border border-red-200 bg-red-50 rounded-xl p-3 text-sm text-red-700">
          {t(problem.key)} <span className="text-xs text-slate-500">{problem.detail}</span>
        </p>
      )}

      {summary && (
        <section className="bg-white border border-slate-200 rounded-xl p-4 space-y-3">
          <div className="flex items-center justify-between gap-2">
            <p className="font-semibold text-slate-800">{formatBusinessDate(summary.business_date, lang)}</p>
            <p data-testid="close-status" className={`text-sm ${active ? "text-slate-600" : "text-green-700"}`}>
              {active
                ? t("close.statusClosed", { time: time(active.closed_at), name: active.closer ?? "—" })
                : t("close.statusOpen")}
            </p>
          </div>

          <dl className="grid grid-cols-[1fr_auto_auto] gap-x-3 gap-y-1 text-sm">
            {[...PAYMENT_MODES, ...(summary.split.unrecorded.count > 0 ? ["unrecorded" as const] : [])].map((m) => (
              <div key={m} data-testid={`close-split-${m}`} className="contents">
                <dt className="text-slate-600">
                  {t(`pay.${m}`)}
                  {m === "credit" && <span className="text-xs text-slate-400"> ({t("close.creditNote")})</span>}
                </dt>
                <dd className="text-slate-500 text-right">{t("close.bills", { n: summary.split[m].count })}</dd>
                <dd className="text-slate-800 text-right">{rupees(summary.split[m].total)}</dd>
              </div>
            ))}
          </dl>

          <div>
            <p className="text-sm text-slate-500">{t("close.expected")}</p>
            <p data-testid="close-expected" className="text-3xl font-semibold text-slate-800">
              {rupees(summary.expected_cash)}
            </p>
          </div>

          {summary.pending_tokens > 0 && (
            <p data-testid="close-carried" className="text-sm text-amber-700">
              {t("close.carriedOver", { n: summary.pending_tokens })}
            </p>
          )}

          {!active && (
            <div className="space-y-2">
              <label className="block text-sm text-slate-700">
                {t("close.counted")}
                <input
                  data-testid="close-counted"
                  inputMode="decimal"
                  value={counted}
                  onChange={(e) => setCounted(e.target.value)}
                  className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 min-h-[44px]"
                />
              </label>
              {counted.trim() !== "" && !parsed.ok && (
                <p data-testid="close-bad-cash" className="text-xs text-red-700">{t("close.badCash")}</p>
              )}
              {diff !== null && (
                <p
                  data-testid="close-difference"
                  className={`text-sm font-semibold ${diff === 0 ? "text-green-700" : "text-amber-700"}`}
                >
                  {t("close.difference")}: {diff > 0 ? "+" : ""}{rupees(diff)}
                </p>
              )}
              <label className="block text-sm text-slate-700">
                {t("close.note")}
                <textarea
                  data-testid="close-note"
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2"
                />
              </label>
              {needsNote && note.trim() === "" && (
                <p className="text-xs text-amber-700">{t("close.noteRequired")}</p>
              )}
              <button
                data-testid="close-submit"
                disabled={!canSubmit}
                onClick={() => setConfirming(true)}
                className="w-full rounded-lg px-4 py-3 min-h-[44px] bg-emerald-600 text-white font-semibold disabled:opacity-50"
              >
                {t("close.closeBtn")}
              </button>
            </div>
          )}

          {date !== null && (
            <button data-testid="close-today" disabled={busy} onClick={() => pick(null)}
                    className="text-sm text-emerald-700 underline disabled:opacity-50">
              {t("close.backToToday")}
            </button>
          )}
        </section>
      )}

      {(!loaded || !summary) && !problem && (
        <p data-testid="close-loading" className="text-sm text-slate-400">{t("dash.loading")}</p>
      )}

      {pastUnclosed.length > 0 && (
        <section className="bg-white border border-amber-200 rounded-xl p-4 space-y-2">
          <h2 className="font-semibold text-slate-800">{t("close.notClosedList")}</h2>
          <ul className="space-y-1">
            {pastUnclosed.map((d) => (
              <li key={d} className="flex items-center justify-between text-sm">
                <span className="text-slate-700">{formatBusinessDate(d, lang)}</span>
                <button data-testid={`close-pick-${d}`} disabled={busy} onClick={() => pick(d)}
                        className="border border-slate-300 rounded-lg px-3 py-2 bg-white min-h-[44px] disabled:opacity-50">
                  {t("close.closeThis")}
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      {history.length > 0 && (
        <section className="bg-white border border-slate-200 rounded-xl p-4 space-y-2">
          <h2 className="font-semibold text-slate-800">{t("close.history")}</h2>
          <ul className="space-y-2">
            {history.map((c) => (
              <li key={c.id} className="text-sm space-y-1">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-slate-700">{formatBusinessDate(c.business_date, lang)}</span>
                  <span className={c.difference === 0 ? "text-green-700" : "text-amber-700"}>
                    {c.difference > 0 ? "+" : ""}{rupees(c.difference)}
                  </span>
                  <span className="text-slate-500">
                    {c.reopened_at ? t("close.reopened") : (c.closer ?? "—")}
                  </span>
                  {isAdmin && c.reopened_at === null && (
                    <button data-testid={`close-reopen-${c.business_date}`} disabled={busy}
                            onClick={() => { setReopening(c.business_date); setReason(""); }}
                            className="border border-slate-300 rounded-lg px-3 py-2 bg-white min-h-[44px] disabled:opacity-50">
                      {t("close.reopen")}
                    </button>
                  )}
                </div>
                {c.note && <p className="text-xs text-slate-500">{c.note}</p>}
                {reopening === c.business_date && (
                  <div className="space-y-2">
                    <label className="block text-sm text-slate-700">
                      {t("close.reopenReason")}
                      <input data-testid="close-reopen-reason" value={reason}
                             onChange={(e) => setReason(e.target.value)}
                             className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 min-h-[44px]" />
                    </label>
                    <button data-testid="close-reopen-accept"
                            disabled={reason.trim() === "" || busy}
                            onClick={() => void reopen(c.business_date)}
                            className="rounded-lg px-4 py-2 min-h-[44px] bg-amber-600 text-white font-semibold disabled:opacity-50">
                      {t("close.reopenAccept")}
                    </button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}

      {confirming && summary && (
        <div role="dialog" aria-modal="true" aria-labelledby="close-confirm-title"
             className="fixed inset-0 bg-black/40 flex items-end sm:items-center justify-center p-4">
          <div className="bg-white rounded-xl p-4 w-full max-w-sm space-y-3">
            <h2 id="close-confirm-title" className="font-semibold text-slate-800">
              {t("close.confirmTitle", { date: formatBusinessDate(summary.business_date, lang) })}
            </h2>
            <p className="text-slate-700">{t("close.confirmBody")}</p>
            <button data-testid="close-confirm" onClick={() => void submit()}
                    className="w-full rounded-lg px-3 py-3 min-h-[44px] bg-emerald-600 text-white font-semibold">
              {t("close.confirmAccept")}
            </button>
            <button onClick={() => setConfirming(false)}
                    className="w-full rounded-lg px-3 py-2 min-h-[44px] border border-slate-300">
              {t("close.cancel")}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
