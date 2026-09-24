import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link, useParams } from "react-router-dom";
import "../i18n";
import { useSession } from "../components/SessionProvider";
import {
  loadCustomerDues, recordOpeningBalance, recordRepayment, reverseDuesEntry, type DuesEntry,
} from "../dues";
import { parseAmount } from "../duesRules";
import { formatBusinessDate } from "../closeRules";
import { REPAY_MODES, type RepayMode } from "../payments";
import { describeError } from "../errors";
import { rupees } from "../money";

/**
 * One customer's udhaar: the server's balance, what made it, and the three things staff
 * do to it. Every write is followed by a reload -- the balance is derived on the server
 * and is never adjusted here.
 */
export default function CustomerDues() {
  const { t, i18n } = useTranslation();
  const session = useSession();
  const { customerId = "" } = useParams();

  const [balance, setBalance] = useState<number | null>(null);
  const [entries, setEntries] = useState<DuesEntry[]>([]);
  const [problem, setProblem] = useState<{ key: string; detail: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [panel, setPanel] = useState<"receive" | "opening" | null>(null);
  const [amount, setAmount] = useState("");
  const [mode, setMode] = useState<RepayMode | null>(null);
  const [note, setNote] = useState("");
  const [reversing, setReversing] = useState<string | null>(null);
  const [reason, setReason] = useState("");

  const load = useCallback(async () => {
    const { data, error } = await loadCustomerDues(customerId);
    setProblem(describeError(error));
    if (data) { setBalance(data.balance); setEntries(data.entries); }
  }, [customerId]);

  useEffect(() => { void load(); }, [load]);

  if (session.kind !== "ready") return null;
  const isAdmin = session.role === "admin";
  const lang = i18n.language;

  function open(p: "receive" | "opening") {
    setPanel(p);
    setAmount(p === "receive" && balance !== null && balance > 0 ? String(balance) : "");
    setMode(null);
    setNote("");
    setProblem(null);
  }

  // `busy` stays true through the reload (in a finally, so a thrown write can't strand the page busy),
  // otherwise the stale balance/panel let a second tap re-submit the same write before the reload lands.
  // On success the panel/reverse-prompt is closed BEFORE the reload, so a slow reload can't leave a
  // re-enabled Confirm sitting over stale values. A refusal is set AFTER the reload, because load()
  // replaces `problem` with its own result, and the panel stays open with the typed values.
  async function run(write: () => Promise<{ error: { message?: string; code?: string } | null }>) {
    setBusy(true);
    try {
      const { error } = await write();
      if (!error) { setPanel(null); setReversing(null); setReason(""); }
      await load();
      if (error) { setProblem(describeError(error)); return false; }
      return true;
    } finally {
      setBusy(false);
    }
  }

  const parsed = parseAmount(amount);
  const overBalance = panel === "receive" && parsed.ok && balance !== null && parsed.value > balance;
  const canReceive = parsed.ok && !overBalance && mode !== null && !busy;
  const canOpening = parsed.ok && note.trim() !== "" && !busy;

  async function receive() {
    if (!parsed.ok || !mode) return;
    await run(() => recordRepayment(customerId, parsed.value, mode, note));
  }
  async function opening() {
    if (!parsed.ok) return;
    await run(() => recordOpeningBalance(customerId, parsed.value, note));
  }
  async function reverse(id: string) {
    await run(() => reverseDuesEntry(id, reason));
  }

  const canReverse = (e: DuesEntry) =>
    e.reversed_at === null && !e.day_closed &&
    (e.kind === "repayment" || (e.kind === "opening" && isAdmin));

  const label = (e: DuesEntry) =>
    e.kind === "credit_bill" ? t("dues.kind.credit_bill", { n: e.token_no ?? "—" })
      : e.kind === "opening" ? t("dues.kind.opening")
      : t("dues.kind.repayment", { mode: t(`pay.${e.mode}`) });

  return (
    <div className="space-y-4">
      <Link to="/dues" className="text-sm text-emerald-700 underline">{t("dues.title")}</Link>

      {problem && (
        <p className="border border-red-200 bg-red-50 rounded-xl p-3 text-sm text-red-700">
          {t(problem.key)} <span className="text-xs text-slate-500">{problem.detail}</span>
        </p>
      )}

      {balance !== null && (
        <section className="bg-white border border-slate-200 rounded-xl p-4 space-y-3">
          <p className="text-sm text-slate-500">{t("dues.balance")}</p>
          <p data-testid="cd-balance" className="text-3xl font-semibold text-slate-800">
            {balance > 0 ? rupees(balance)
              : balance === 0 ? t("dues.settled")
              : t("dues.overpaid", { amount: rupees(-balance) })}
          </p>
          <div className="flex gap-2">
            {balance > 0 && (
              <button data-testid="cd-receive" disabled={busy} onClick={() => open("receive")}
                      className="rounded-lg px-4 py-3 min-h-[44px] bg-emerald-600 text-white font-semibold disabled:opacity-50">
                {t("dues.receive")}
              </button>
            )}
            {isAdmin && (
              <button data-testid="cd-opening" disabled={busy} onClick={() => open("opening")}
                      className="rounded-lg px-4 py-3 min-h-[44px] border border-slate-300 bg-white disabled:opacity-50">
                {t("dues.opening")}
              </button>
            )}
          </div>

          {panel === "receive" && (
            <div className="space-y-2">
              <label className="block text-sm text-slate-700">
                {t("dues.amount")}
                <input data-testid="cd-amount" inputMode="decimal" value={amount}
                       onChange={(e) => setAmount(e.target.value)}
                       className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 min-h-[44px]" />
              </label>
              {amount.trim() !== "" && !parsed.ok && <p className="text-xs text-red-700">{t("dues.badAmount")}</p>}
              {overBalance && <p className="text-xs text-red-700">{t("dues.overBalanceHint")}</p>}
              <fieldset className="space-y-2">
                <legend className="text-sm text-slate-700">{t("dues.modeLabel")}</legend>
                <div className="grid grid-cols-3 gap-2">
                  {REPAY_MODES.map((m) => (
                    <button key={m} type="button" data-testid={`cd-mode-${m}`} aria-pressed={mode === m}
                            onClick={() => setMode(m)}
                            className={`rounded-lg px-3 py-3 min-h-[44px] border font-semibold ${
                              mode === m ? "bg-emerald-600 text-white border-emerald-600"
                                         : "bg-white text-slate-700 border-slate-300"}`}>
                      {t(`pay.${m}`)}
                    </button>
                  ))}
                </div>
              </fieldset>
              <label className="block text-sm text-slate-700">
                {t("dues.noteOptional")}
                <input data-testid="cd-note" value={note} onChange={(e) => setNote(e.target.value)}
                       className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 min-h-[44px]" />
              </label>
              <button data-testid="cd-receive-confirm" disabled={!canReceive} onClick={() => void receive()}
                      className="w-full rounded-lg px-4 py-3 min-h-[44px] bg-emerald-600 text-white font-semibold disabled:opacity-50">
                {t("dues.confirmReceive")}
              </button>
              <button onClick={() => setPanel(null)} className="w-full rounded-lg px-3 py-2 min-h-[44px] border border-slate-300">
                {t("dues.cancel")}
              </button>
            </div>
          )}

          {panel === "opening" && (
            <div className="space-y-2">
              <label className="block text-sm text-slate-700">
                {t("dues.amount")}
                <input data-testid="cd-opening-amount" inputMode="decimal" value={amount}
                       onChange={(e) => setAmount(e.target.value)}
                       className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 min-h-[44px]" />
              </label>
              {amount.trim() !== "" && !parsed.ok && <p className="text-xs text-red-700">{t("dues.badAmount")}</p>}
              <label className="block text-sm text-slate-700">
                {t("dues.note")}
                <input data-testid="cd-opening-note" value={note} placeholder={t("dues.openingNote")}
                       onChange={(e) => setNote(e.target.value)}
                       className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 min-h-[44px]" />
              </label>
              <button data-testid="cd-opening-confirm" disabled={!canOpening} onClick={() => void opening()}
                      className="w-full rounded-lg px-4 py-3 min-h-[44px] bg-emerald-600 text-white font-semibold disabled:opacity-50">
                {t("dues.confirmOpening")}
              </button>
              <button onClick={() => setPanel(null)} className="w-full rounded-lg px-3 py-2 min-h-[44px] border border-slate-300">
                {t("dues.cancel")}
              </button>
            </div>
          )}
        </section>
      )}

      <ul className="space-y-2">
        {entries.map((e) => (
          <li key={e.id} className="bg-white border border-slate-200 rounded-xl p-3 text-sm space-y-1">
            <div data-testid={`cd-entry-${e.id}`}
                 className={`flex items-center justify-between gap-2 ${e.reversed_at ? "line-through text-slate-400" : ""}`}>
              <span>
                <span className="block text-slate-800">
                  {e.kind === "credit_bill"
                    ? <Link to={`/receipt/${e.id}`} className="underline">{label(e)}</Link>
                    : label(e)}
                </span>
                <span className="block text-xs text-slate-500">
                  {formatBusinessDate(e.business_date, lang)}
                  {e.by_name && ` · ${t("dues.by", { name: e.by_name })}`}
                  {e.note && ` · ${e.note}`}
                </span>
                {e.reversed_at && (
                  <span className="block text-xs">{t("dues.reversed", { reason: e.reverse_reason ?? "" })}</span>
                )}
              </span>
              <span className={e.kind === "repayment" ? "text-green-700" : "text-slate-800"}>
                {e.kind === "repayment" ? "−" : "+"}{rupees(e.amount)}
              </span>
            </div>
            {canReverse(e) && reversing !== e.id && (
              <button data-testid={`cd-reverse-${e.id}`} disabled={busy}
                      onClick={() => { setReversing(e.id); setReason(""); }}
                      className="border border-slate-300 rounded-lg px-3 py-2 bg-white min-h-[44px] disabled:opacity-50">
                {t("dues.reverse")}
              </button>
            )}
            {reversing === e.id && (
              <div className="space-y-2">
                <label className="block text-sm text-slate-700">
                  {t("dues.reverseReason")}
                  <input data-testid="cd-reverse-reason" value={reason} onChange={(ev) => setReason(ev.target.value)}
                         className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 min-h-[44px]" />
                </label>
                <button data-testid="cd-reverse-accept" disabled={reason.trim() === "" || busy}
                        onClick={() => void reverse(e.id)}
                        className="rounded-lg px-4 py-2 min-h-[44px] bg-amber-600 text-white font-semibold disabled:opacity-50">
                  {t("dues.confirmReverse")}
                </button>
              </div>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
