import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
// i18next initialises as a side effect of this import, exactly as Shell does. The screen
// is rendered directly (by tests, and by the router) without going through main.tsx.
import "../i18n";
import { useSession } from "../components/SessionProvider";
import { type Draft } from "../billing";
import type { Customer } from "../customers";
import { addLines, createBill, issueToken, listCustomers, listItems, type Item } from "../data";
import { describeError } from "../errors";
import { LANGS, type Lang } from "../i18n/locales";
import { CustomerStep } from "./bill/CustomerStep";
import { ItemGrid } from "./bill/ItemGrid";
import { Basket } from "./bill/Basket";
import { TokenResult } from "./bill/TokenResult";

type Phase = "customer" | "items" | "done";

const asLang = (tag: string | undefined): Lang =>
  (LANGS as readonly string[]).includes(tag ?? "") ? (tag as Lang) : "en";

/** navigator.onLine is only ever a NEGATIVE signal worth trusting: false means there is
 *  certainly no network, true means only that an interface is up. That is enough for the
 *  one decision it makes here -- refusing to promise a token the shop cannot get. */
function useOnline(): boolean {
  const [online, setOnline] = useState(() => navigator.onLine);
  useEffect(() => {
    const up = () => setOnline(true);
    const down = () => setOnline(false);
    window.addEventListener("online", up);
    window.addEventListener("offline", down);
    return () => {
      window.removeEventListener("online", up);
      window.removeEventListener("offline", down);
    };
  }, []);
  return online;
}

/**
 * The recorder's bill screen: one state machine over phase / lines / token.
 *
 * Nothing is written until Done. The order there is createBill -> addLines -> issueToken,
 * so an abandoned basket leaves no row at all, and issue_token is the single moment the
 * bill becomes real. It is also a one-way door: once the bill is `billed` the policies
 * refuse further edits, so the confirm comes BEFORE it and there is no undo after -- one
 * could not be honoured.
 */
export default function Bill() {
  const { t, i18n } = useTranslation();
  const session = useSession();
  const online = useOnline();

  const [items, setItems] = useState<Item[]>([]);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [phase, setPhase] = useState<Phase>("customer");
  const [customer, setCustomer] = useState<Customer | null>(null);
  const [lines, setLines] = useState<Draft[]>([]);
  const [token, setToken] = useState<number | null>(null);
  const [confirming, setConfirming] = useState(false);
  // What of the write has already landed. A retry RESUMES from here: re-running
  // createBill would orphan the first bill in `recording` with its lines attached, and
  // issue_token's own guard cannot catch that -- it is a different bill.
  const [written, setWritten] = useState<{ billId: string; linesAdded: boolean } | null>(null);
  const [issuing, setIssuing] = useState(false);
  const [failure, setFailure] = useState<{ key: string; detail: string } | null>(null);

  useEffect(() => {
    let live = true;
    void (async () => {
      const [itemsRes, customersRes] = await Promise.all([listItems(), listCustomers()]);
      if (!live) return;
      // A policy-filtered read arrives as zero rows, not an error -- an empty list is
      // "nothing yet", never "not allowed".
      const bad = describeError(itemsRes.error) ?? describeError(customersRes.error);
      if (bad) setFailure(bad);
      setItems((itemsRes.data ?? []) as Item[]);
      setCustomers((customersRes.data ?? []) as Customer[]);
    })();
    return () => {
      live = false;
    };
  }, []);

  if (session.kind !== "ready") return null;
  const { vendorId, userId } = session;

  const canFinish = lines.length > 0 && online && !issuing;

  function pick(c: Customer) {
    setCustomer(c);
    setPhase("items");
  }

  async function confirm() {
    if (!customer) return;
    setIssuing(true);
    setFailure(null);

    let billId = written?.billId ?? null;
    if (billId === null) {
      const { data: bill, error: billError } = await createBill(vendorId, customer.id, userId);
      if (billError || !bill) {
        return fail(describeError(billError));
      }
      billId = bill.id as string;
      setWritten({ billId, linesAdded: false });
    }

    if (!written?.linesAdded) {
      // addLines short-circuits an empty basket with { error: null } and NO data key, so
      // only the error is read here.
      const { error: linesError } = await addLines(vendorId, billId, lines);
      if (linesError) {
        return fail(describeError(linesError));
      }
      setWritten({ billId, linesAdded: true });
    }

    const { data: issued, error: tokenError } = await issueToken(billId);
    if (tokenError || issued == null) {
      return fail(describeError(tokenError));
    }
    setIssuing(false);
    // The server's number, not one recomputed here.
    setToken(Number(issued));
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

  function startNew() {
    setPhase("customer");
    setWritten(null);
    setCustomer(null);
    setLines([]);
    setToken(null);
    setFailure(null);
  }

  return (
    <div className="space-y-4">
      {failure && (
        <p className="border border-red-200 bg-red-50 rounded-xl p-3 text-sm text-red-700">
          {t(failure.key)} <span className="text-xs text-slate-500">{failure.detail}</span>
        </p>
      )}

      {phase === "customer" && (
        <CustomerStep
          customers={customers}
          vendorId={vendorId}
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

          {!written?.linesAdded && (
            <ItemGrid
              items={items}
              lang={asLang(i18n.language)}
              onAdd={(line) => setLines((prev) => [...prev, line])}
            />
          )}

          <Basket
            lines={lines}
            frozen={written?.linesAdded ?? false}
            onRemove={(index) => setLines((prev) => prev.filter((_, i) => i !== index))}
          />

          {!online && <p className="text-sm text-amber-700">{t("offline.banner")}</p>}

          <button
            onClick={() => setConfirming(true)}
            disabled={!canFinish}
            className="w-full rounded-xl px-3 py-3 min-h-[44px] bg-emerald-600 text-white text-lg font-semibold disabled:opacity-40"
          >
            {t("bill.done")}
          </button>
        </>
      )}

      {confirming && (
        <div role="dialog" aria-modal="true"
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

      {phase === "done" && token !== null && <TokenResult token={token} onStartNew={startNew} />}
    </div>
  );
}
