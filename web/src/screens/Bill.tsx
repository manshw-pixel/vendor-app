import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useLocation } from "react-router-dom";
// i18next initialises as a side effect of this import, exactly as Shell does. The screen
// is rendered directly (by tests, and by the router) without going through main.tsx.
import "../i18n";
import { useSession } from "../components/SessionProvider";
import { runningTotal, type Draft } from "../billing";
import type { Customer } from "../customers";
import {
  billToken,
  createBill,
  issueToken,
  listCustomers,
  listItems,
  replaceBillLines,
  type Item,
} from "../data";
import { describeError, isBillNoLongerRecording } from "../errors";
import { LANGS, type Lang } from "../i18n/locales";
import { CustomerStep } from "./bill/CustomerStep";
import { ItemGrid } from "./bill/ItemGrid";
import { Basket } from "./bill/Basket";
import { TokenResult } from "./bill/TokenResult";
import { OfflineCheckout, amountToTake } from "./bill/OfflineCheckout";
import { OfflineResult } from "./bill/OfflineResult";
import { useRouteOffline } from "../offline/useRouteOffline";
import { isStale, loadSnapshot, refreshSnapshot, type Snapshot } from "../offline/catalogue";
import { enqueue, isNetworkError } from "../offline/outbox";
import type { PaymentMode } from "../payments";

type Phase = "customer" | "items" | "done";

const asLang = (tag: string | undefined): Lang =>
  (LANGS as readonly string[]).includes(tag ?? "") ? (tag as Lang) : "en";

/**
 * The recorder's bill screen: one state machine over phase / lines / token.
 *
 * Nothing is written until Done. The order there is createBill -> replaceBillLines ->
 * issueToken,
 * so an abandoned basket leaves no row at all, and issue_token is the single moment the
 * bill becomes real. It is also a one-way door: once the bill is `billed` the policies
 * refuse further edits, so the confirm comes BEFORE it and there is no undo after -- one
 * could not be honoured.
 *
 * Offline (no network, or a session opened from the device cache) the screen reads the
 * cached snapshot instead, and Done ends in OfflineCheckout -> enqueue: the sale waits in
 * the outbox and gets its token when it syncs. The online flow above is unchanged; an
 * online createBill that fails on the network (before anything reached the server) may
 * also be saved offline.
 */
export default function Bill() {
  const { t, i18n } = useTranslation();
  const session = useSession();
  const offline = useRouteOffline();
  const vendorIdForLoad = session.kind === "ready" ? session.vendorId : null;

  // Handed over by Completed.tsx after it voids a bill being corrected: the replacement
  // starts from the voided bill's basket so the recorder retypes only what was wrong.
  // The CUSTOMER step still runs -- the replacement is a new bill with a new token, and
  // pre-selecting a customer would hide from the recorder that this is a fresh sale.
  const location = useLocation();
  const prefill = (location.state as { prefill?: Draft[] } | null)?.prefill;

  const [items, setItems] = useState<Item[]>([]);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [phase, setPhase] = useState<Phase>("customer");
  const [customer, setCustomer] = useState<Customer | null>(null);
  const [lines, setLines] = useState<Draft[]>(() => prefill ?? []);
  const [token, setToken] = useState<number | null>(null);
  const [confirming, setConfirming] = useState(false);
  // What of the write has already landed. A retry RESUMES from here: re-running
  // createBill would orphan the first bill in `recording` with its lines attached, and
  // issue_token's own guard cannot catch that -- it is a different bill.
  //
  // linesWritten no longer gates WHETHER replaceBillLines is called -- it is idempotent,
  // so confirm() calls it unconditionally on every attempt. It exists purely to gate the
  // UI: while it is false (no successful write yet for this bill, whether because none has
  // been attempted or because the last attempt failed) the picker stays open and the
  // basket stays editable, so a failed line write can be corrected before the retry --
  // exactly the case replace_bill_lines makes safe. Once a write has landed it flips true
  // and stays true; a later failure (e.g. issueToken) does not reopen editing, matching
  // the one-way-door the confirm dialog already promises.
  const [written, setWritten] = useState<{ billId: string; linesWritten: boolean } | null>(null);
  const [issuing, setIssuing] = useState(false);
  const [failure, setFailure] = useState<{ key: string; detail: string } | null>(null);
  // Set only when a token failure's read-back itself failed: we genuinely do not know
  // whether the bill billed. Rendered alongside the failure banner, never in place of it
  // -- see the read-back handling in confirm() below.
  const [tokenUnknown, setTokenUnknown] = useState(false);
  // undefined = not loaded yet (or online, where it is not used); null = no cache on device.
  const [snapshot, setSnapshot] = useState<Snapshot | null | undefined>(undefined);
  const [offlineCheckout, setOfflineCheckout] = useState(false);
  const [offlineDone, setOfflineDone] = useState<{ seq: number; total: number } | null>(null);
  // The online createBill failed on the network, so nothing reached the server.
  const [networkFailed, setNetworkFailed] = useState(false);
  // A ref as well as state: two taps in one frame both see the state still false.
  const [savingOffline, setSavingOffline] = useState(false);
  const savingRef = useRef(false);

  useEffect(() => {
    if (!vendorIdForLoad) return;
    let live = true;
    void (async () => {
      if (offline) {
        const snap = (await loadSnapshot(vendorIdForLoad)) ?? null;
        if (!live) return;
        setSnapshot(snap);
        if (snap) {
          setItems(snap.items);
          setCustomers(snap.customers);
        }
        return;
      }
      const [itemsRes, customersRes] = await Promise.all([listItems(), listCustomers()]);
      if (!live) return;
      // A policy-filtered read arrives as zero rows, not an error -- an empty list is
      // "nothing yet", never "not allowed".
      const bad = describeError(itemsRes.error) ?? describeError(customersRes.error);
      if (bad) setFailure(bad);
      setItems((itemsRes.data ?? []) as Item[]);
      setCustomers((customersRes.data ?? []) as Customer[]);
      // Kept, so an online bill that falls back to offline has balances to check against.
      void refreshSnapshot(vendorIdForLoad).then((snap) => {
        if (live && snap) setSnapshot(snap);
      });
    })();
    return () => {
      live = false;
    };
  }, [offline, vendorIdForLoad]);

  if (session.kind !== "ready") return null;
  const { vendorId, userId } = session;

  const canFinish = lines.length > 0 && !issuing;
  const useOfflinePath = offline || (networkFailed && written === null);

  function pick(c: Customer) {
    setCustomer(c);
    setPhase("items");
  }

  async function confirm() {
    if (!customer) return;
    setIssuing(true);
    setFailure(null);
    setTokenUnknown(false);
    setNetworkFailed(false);

    let billId = written?.billId ?? null;
    if (billId === null) {
      const { data: bill, error: billError } = await createBill(vendorId, customer.id, userId);
      if (billError || !bill) {
        if (isNetworkError(billError)) {
          if (!snapshot) {
            const snap = await loadSnapshot(vendorId);
            if (snap) setSnapshot(snap);
          }
          setNetworkFailed(true);
        } else {
          setNetworkFailed(false);
        }
        return fail(describeError(billError));
      }
      billId = bill.id as string;
      setWritten({ billId, linesWritten: false });
    }

    // Unconditional, first attempt or fifth. replace_bill_lines (0015) deletes and inserts
    // in one transaction, so re-sending converges on the same rows rather than appending a
    // second copy -- which is what the old check-then-insert could only narrow, never
    // close.
    const { error: linesError } = await replaceBillLines(billId, lines);
    // One error from that call is NOT a failure: 0015's status guard, "bill ... is billed,
    // expected recording". It means issue_token already committed and only its reply was
    // lost -- the very case the read-back below exists for. Stopping here would strand the
    // recorder: every retry would fail at this line and never reach the token read-back,
    // so they could never learn the token the customer was already sent. Fall through
    // instead. Every other error -- a vanished bill, the tenant guard, a role refusal, an
    // RLS block, a dropped connection -- still fails here; see isBillNoLongerRecording.
    if (linesError && !isBillNoLongerRecording(linesError)) {
      return fail(describeError(linesError));
    }
    // True in both surviving cases: either the write landed, or the bill is past
    // `recording` and its lines are final. Editing the basket is pointless either way.
    setWritten({ billId, linesWritten: true });

    const { data: issued, error: tokenError } = await issueToken(billId);
    if (tokenError || issued == null) {
      // issue_token may have committed and had its response lost -- the bill is then
      // already `billed` with a real token, and the customer has already been sent it
      // (0003_functions.sql:54-56). Read back what the server actually wrote rather than
      // trust the lost response; see billToken's doc comment in data.ts.
      const { data: readBack, error: readError } = await billToken(billId);
      if (!readError && readBack && readBack.token_no !== null &&
          (readBack.status === "billed" || readBack.status === "done")) {
        setToken(Number(readBack.token_no));
        setIssuing(false);
        setConfirming(false);
        setWritten(null);
        setFailure(null);
        setPhase("done");
        return;
      }
      if (readError) {
        // The same problem one layer down: we genuinely do not know whether the bill
        // billed. Do not claim it failed and do not invent a token -- say so, and keep
        // `written` intact so pressing Done again retries both the token and the read-back.
        setTokenUnknown(true);
      }
      return fail(describeError(tokenError));
    }
    // The server's number, not one recomputed here.
    setToken(Number(issued));
    setIssuing(false);
    setConfirming(false);
    setWritten(null);
    setPhase("done");
  }

  /** Every failure path closes the dialog, so the banner underneath is actually readable
   *  -- a modal left open over an invisible error tells the recorder nothing. */
  function fail(described: { key: string; detail: string } | null) {
    setFailure(described ?? { key: "error.unknown", detail: "" });
    setIssuing(false);
    setConfirming(false);
  }

  async function recordOffline(mode: PaymentMode, redeemPoints: number, collectDue: number) {
    if (!customer || savingRef.current) return;
    savingRef.current = true;
    setSavingOffline(true);
    // Gross total is what the outbox records; the result screen shows what to take.
    const total = runningTotal(lines);
    try {
      const saved = await enqueue({
        vendorId, customerId: customer.id, customerLabel: `${customer.name} · ${customer.flat_no}`,
        lines, mode, redeemPoints, collectDue, total,
      });
      window.dispatchEvent(new Event("outbox-changed"));
      setOfflineCheckout(false);
      setFailure(null);
      setNetworkFailed(false);
      setOfflineDone({ seq: saved.seq, total: amountToTake(total, redeemPoints, collectDue) });
      setPhase("done");
    } catch (e) {
      setOfflineCheckout(false);
      setFailure({ key: "error.unknown", detail: e instanceof Error ? e.message : "" });
    } finally {
      savingRef.current = false;
      setSavingOffline(false);
    }
  }

  function startNew() {
    setPhase("customer");
    setOfflineDone(null);
    setNetworkFailed(false);
    setWritten(null);
    setCustomer(null);
    setLines([]);
    setToken(null);
    setFailure(null);
  }

  if (offline && snapshot === null) {
    return <p className="text-sm text-amber-700">{t("offline.noCache")}</p>;
  }

  return (
    <div className="space-y-4">
      {offline && snapshot && isStale(snapshot) && (
        <p className="text-sm text-amber-700">{t("offline.stale")}</p>
      )}

      {failure && (
        <p className="border border-red-200 bg-red-50 rounded-xl p-3 text-sm text-red-700">
          {t(failure.key)} <span className="text-xs text-slate-500">{failure.detail}</span>
        </p>
      )}

      {failure && networkFailed && written === null && phase === "items" && (
        <button
          onClick={() => setOfflineCheckout(true)}
          className="w-full rounded-xl px-3 py-2 min-h-[44px] border border-amber-400 bg-amber-50 text-amber-800 font-semibold"
        >
          {t("offline.saveOffline")}
        </button>
      )}

      {failure && tokenUnknown && <p className="text-xs text-amber-700">{t("bill.tokenUnknown")}</p>}

      {phase === "customer" && (
        <CustomerStep
          customers={customers}
          vendorId={vendorId}
          allowCreate={!offline}
          onPick={pick}
          onCreated={(c) => {
            setCustomers((prev) => [...prev, c]);
            pick(c);
          }}
        />
      )}

      {phase === "items" && (
        <>
          {customer && (
            <p className="text-sm text-slate-500">
              {customer.name} · {customer.flat_no}
            </p>
          )}

          {!written?.linesWritten && (
            <ItemGrid
              items={items}
              lang={asLang(i18n.language)}
              onAdd={(line) => setLines((prev) => [...prev, line])}
            />
          )}

          <Basket
            lines={lines}
            frozen={written?.linesWritten ?? false}
            onRemove={(index) => setLines((prev) => prev.filter((_, i) => i !== index))}
          />

          <button
            onClick={() => (useOfflinePath ? setOfflineCheckout(true) : setConfirming(true))}
            disabled={!canFinish}
            className="w-full rounded-xl px-3 py-3 min-h-[44px] bg-emerald-600 text-white text-lg font-semibold disabled:opacity-40"
          >
            {t("bill.done")}
          </button>
        </>
      )}

      {confirming && (
        <div role="dialog" aria-modal="true" aria-label={t("bill.confirmTitle")}
             className="fixed inset-0 bg-black/40 flex items-end sm:items-center justify-center p-4">
          <div className="bg-white rounded-xl p-4 w-full max-w-sm space-y-3">
            <p className="text-slate-700">{t("bill.confirmBody")}</p>
            <button
              onClick={() => void confirm()}
              disabled={issuing}
              className="w-full rounded-lg px-3 py-3 min-h-[44px] bg-emerald-600 text-white font-semibold disabled:opacity-50"
            >
              {t("bill.confirmTitle")}
            </button>
            <button
              onClick={() => setConfirming(false)}
              className="w-full rounded-lg px-3 py-2 min-h-[44px] border border-slate-300"
            >
              {t("bill.cancel")}
            </button>
          </div>
        </div>
      )}

      {offlineCheckout && customer && (
        <OfflineCheckout
          total={runningTotal(lines)}
          balance={snapshot?.balances[customer.id]}
          onConfirm={(mode, redeem, collect) => void recordOffline(mode, redeem, collect)}
          saving={savingOffline}
          onCancel={() => setOfflineCheckout(false)}
        />
      )}

      {phase === "done" && offlineDone !== null && (
        <OfflineResult seq={offlineDone.seq} total={offlineDone.total} onStartNew={startNew} />
      )}

      {phase === "done" && token !== null && <TokenResult token={token} onStartNew={startNew} />}
    </div>
  );
}
