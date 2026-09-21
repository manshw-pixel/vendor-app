import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link, useNavigate } from "react-router-dom";
import {
  listCompleted, billLines, voidBill, listVoided, PAGE_SIZE,
  type CompletedBill, type BillLine, type Cursor, type VoidedBill,
} from "../history";
import { billDraftLines } from "../data";
import { presetRange, type Range } from "../dateRange";
import { DateFilter } from "../components/DateFilter";
import { itemName, type Lang } from "../i18n/locales";
import { qtyText } from "../units";
import { rupees } from "../money";
import { describeError } from "../errors";
import { useSession } from "../components/SessionProvider";
import "../i18n";

/** Void and Edit are offered under the same window: void_bill (0017) only reverses stock
 *  and points for a bill completed on the browser's local "today", so an Edit that skipped
 *  this check could open a replacement while the original stayed live, uncorrectable. One
 *  helper, called from both, so the two never drift apart. */
function inVoidWindow(completedAt: string): boolean {
  return new Date(completedAt).toDateString() === new Date().toDateString();
}

export default function Completed() {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const session = useSession();
  const [range, setRange] = useState<Range>(() => presetRange("today", new Date()));
  const [rows, setRows] = useState<CompletedBill[]>([]);
  const [more, setMore] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const [lines, setLines] = useState<BillLine[]>([]);
  const [problem, setProblem] = useState<{ key: string; detail: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [voidingId, setVoidingId] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const [voiding, setVoiding] = useState(false);
  // Edit shares `reason` with Void rather than a state of its own -- the two are never
  // open at once (opening one below clears the other), and a reason typed for one is
  // meaningless for the other, so nothing is lost by sharing the field.
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [voidedOpen, setVoidedOpen] = useState(false);
  const [voidedRows, setVoidedRows] = useState<VoidedBill[]>([]);
  const [doneToken, setDoneToken] = useState<number | null>(null);

  /** Which range the newest request was for. Tapping "This month" then "Today" fires two
   *  overlapping fetches; without this guard the slower month response lands last and
   *  appends the previous period's bills to the new one. Same idiom as Customers.tsx. */
  const wanted = useRef<string>("");
  /** Same idiom as `wanted` above, but for the voided list. A range STRING is not enough
   *  here: reloading the voided list twice for the SAME range (e.g. a void followed
   *  immediately by the toggle staying open) produces two in-flight requests keyed
   *  identically, so an older one landing after the newer one would still overwrite it.
   *  A monotonically increasing counter distinguishes "this call" from "any earlier
   *  call", same range or not. */
  const voidedRequest = useRef(0);

  const lang = i18n.language as Lang;

  /** after=null starts a fresh period; a cursor appends the next page. */
  const load = useCallback(async (r: Range, after: Cursor | null) => {
    const key = `${r.from}..${r.to}`;
    wanted.current = key;
    setBusy(true);
    const { data, error } = await listCompleted(r, after);
    if (wanted.current !== key) return;   // superseded; a later range owns the screen now
    setBusy(false);
    const described = describeError(error);
    setProblem(described);
    // PostgREST infers a joined-table column as an array from the select string; the
    // relationship is actually to-one, and CompletedBill/BillLine (history.ts) say so.
    const page = (data ?? []) as unknown as CompletedBill[];
    // The PAGE_SIZE + 1st row is a probe: its presence proves another page exists. It is
    // never rendered, or the same bill would appear twice once load-more ran.
    const hasMore = page.length > PAGE_SIZE;
    const visible = hasMore ? page.slice(0, PAGE_SIZE) : page;
    setMore(hasMore);
    setRows((prev) => (after ? [...prev, ...visible] : visible));
  }, []);

  const loadVoided = useCallback(async (r: Range) => {
    const requestId = ++voidedRequest.current;
    const { data, error } = await listVoided(r);
    if (voidedRequest.current !== requestId) return;   // a later call has since been made
    const described = describeError(error);
    setProblem(described);
    if (described) setDoneToken(null);
    setVoidedRows((data ?? []) as unknown as VoidedBill[]);
  }, []);

  useEffect(() => {
    setOpen(null);
    setDoneToken(null);
    setVoidedRows([]);   // the previous period's voided bills must never flash here
    void load(range, null);
  }, [range, load]);

  // The voided list only loads while its toggle is open; a range change while it's closed
  // is picked up naturally next time it's opened.
  useEffect(() => {
    if (voidedOpen) void loadVoided(range);
  }, [range, voidedOpen, loadVoided]);

  if (session.kind !== "ready") return null;

  async function openBill(id: string) {
    if (open === id) { setOpen(null); return; }
    setOpen(id);
    setLines([]);
    setVoidingId(null);
    setEditingId(null);
    setReason("");
    setDoneToken(null);
    const { data, error } = await billLines(id);
    const described = describeError(error);
    setProblem(described);
    if (described) setDoneToken(null);
    setLines((data ?? []) as unknown as BillLine[]);
  }

  function loadMore() {
    const last = rows[rows.length - 1];
    if (!last) return;
    void load(range, { completedAt: last.completed_at, id: last.id });
  }

  function startVoid(id: string) {
    setVoidingId(id);
    setEditingId(null);
    setReason("");
  }

  function startEdit(id: string) {
    setEditingId(id);
    setVoidingId(null);
    setReason("");
  }

  async function editBill(bill: CompletedBill) {
    setEditing(true);
    const { error } = await voidBill(bill.id, reason.trim());
    const described = describeError(error);
    if (described) { setEditing(false); setProblem(described); return; }
    // The lines are read BEFORE navigating rather than after: bill_items survive the void
    // (0017 sets a status, it does not delete), but reading them here keeps the failure on
    // this screen, where the operator can retry, instead of on a half-opened new bill.
    const { data, error: readError } = await billDraftLines(bill.id);
    setEditing(false);
    // A failed read here must not navigate: the original is already voided, so sending
    // the operator to /bill with an empty prefill (data ?? []) would silently swap a
    // real basket for nothing right after an irreversible action.
    if (readError) { setProblem(describeError(readError)); return; }
    setProblem(null);
    setRows((prev) => prev.filter((b) => b.id !== bill.id));
    setOpen(null);
    setEditingId(null);
    setReason("");
    if (voidedOpen) void loadVoided(range);
    navigate("/bill", { state: { prefill: data ?? [] } });
  }

  async function confirmVoid(id: string, tokenNo: number) {
    setVoiding(true);
    const { error } = await voidBill(id, reason.trim());
    setVoiding(false);
    if (error) {
      setProblem(describeError(error));
      return;
    }
    setProblem(null);
    setRows((prev) => prev.filter((b) => b.id !== id));
    setOpen(null);
    setVoidingId(null);
    setReason("");
    setDoneToken(tokenNo);
    if (voidedOpen) void loadVoided(range);
  }

  return (
    <div className="space-y-4">
      <h2 className="font-semibold text-slate-800">{t("completed.title")}</h2>

      <DateFilter value={range} onChange={setRange} />

      {problem && (
        <p
          data-testid="completed-problem"
          className="text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg p-3"
        >
          {t(problem.key)}
        </p>
      )}

      {doneToken !== null && (
        <p
          data-testid="void-done"
          role="status"
          className="text-sm text-green-700 bg-green-50 border border-green-200 rounded-lg p-3"
        >
          {t("void.done", { n: doneToken })}
        </p>
      )}

      {rows.length === 0 && !busy ? (
        <p data-testid="completed-empty" className="text-sm text-slate-500">
          {t("completed.empty")}
        </p>
      ) : (
        <ul className="space-y-2">
          {rows.map((b) => (
            <li key={b.id} className="bg-white border border-slate-200 rounded-xl">
              <button
                data-testid={`completed-row-${b.id}`}
                onClick={() => void openBill(b.id)}
                className="w-full text-left p-3 min-h-[44px] flex items-center gap-3"
              >
                <span className="flex-1 min-w-0">
                  <span className="block font-medium text-slate-800 truncate">
                    {b.customers?.name ?? t("completed.noCustomer")}
                  </span>
                  <span className="block text-xs text-slate-500">
                    {t("completed.token", { n: b.token_no })}
                    {" · "}
                    {new Date(b.completed_at).toLocaleString()}
                  </span>
                </span>
                <span className="font-medium text-slate-800 whitespace-nowrap">
                  {rupees(b.total)}
                </span>
              </button>

              {open === b.id && (
                <div className="border-t border-slate-100 p-3">
                  <p className="text-xs text-slate-500 mb-1">{t("completed.lines")}</p>
                  <ul className="space-y-1">
                    {lines.map((l) => (
                      <li key={l.id} className="flex justify-between text-sm">
                        <span className="text-slate-700">
                          {l.items ? itemName(l.items, lang) : "—"}
                          {" · "}
                          {qtyText(l.qty_kg, l.items?.unit ?? "kg", t)}
                        </span>
                        <span className="text-slate-600">{rupees(l.line_total)}</span>
                      </li>
                    ))}
                  </ul>
                  {b.redeemed_points > 0 && (
                    <p
                      data-testid={`completed-redeemed-${b.id}`}
                      className="text-xs text-slate-500 mt-2 pt-2 border-t border-slate-100"
                    >
                      {t("completed.redeemed", {
                        gross: rupees(b.total + b.redeemed_points),
                        points: b.redeemed_points,
                        net: rupees(b.total),
                      })}
                    </p>
                  )}
                  <div className="flex items-center gap-2 mt-2 flex-wrap">
                    <Link
                      data-testid={`completed-receipt-${b.id}`}
                      to={`/receipt/${b.id}`}
                      className="inline-block border border-slate-300 rounded-lg px-3 py-2 text-sm bg-white min-h-[44px]"
                    >
                      {t("completed.receipt")}
                    </Link>
                    {inVoidWindow(b.completed_at) && (
                      <button
                        data-testid={`completed-void-${b.id}`}
                        onClick={() => startVoid(b.id)}
                        className="inline-block border border-red-300 text-red-700 rounded-lg px-3 py-2 text-sm bg-white min-h-[44px]"
                      >
                        {t("void.action")}
                      </button>
                    )}
                    {/* Void is open to biller and admin (void_bill, 0017), but /bill --
                        where Edit hands off to -- is not a biller route (routes.ts): a
                        biller who voided would be stranded on Pending with no
                        replacement and no way back to the sale they just erased. Gating
                        Edit to admin keeps Void available to whoever can already use it
                        while never opening a void the same operator cannot finish. */}
                    {inVoidWindow(b.completed_at) && session.role === "admin" && (
                      <button
                        data-testid={`bill-edit-${b.id}`}
                        onClick={() => startEdit(b.id)}
                        className="inline-block border border-slate-300 text-slate-700 rounded-lg px-3 py-2 text-sm bg-white min-h-[44px]"
                      >
                        {t("completed.edit")}
                      </button>
                    )}
                  </div>

                  {voidingId === b.id && (
                    <div className="mt-2 pt-2 border-t border-slate-100 space-y-2">
                      <label
                        htmlFor={`void-reason-${b.id}`}
                        className="block text-sm text-slate-700"
                      >
                        {t("void.why")}
                      </label>
                      <input
                        id={`void-reason-${b.id}`}
                        data-testid="void-reason"
                        value={reason}
                        onChange={(e) => setReason(e.target.value)}
                        placeholder={t("void.reasonPlaceholder")}
                        className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm min-h-[44px]"
                      />
                      <div className="flex gap-2">
                        <button
                          data-testid="void-confirm"
                          disabled={reason.trim() === "" || voiding}
                          onClick={() => void confirmVoid(b.id, b.token_no)}
                          className="border border-red-300 text-red-700 rounded-lg px-3 py-2 text-sm bg-white min-h-[44px] disabled:opacity-50"
                        >
                          {t("void.confirm")}
                        </button>
                        <button
                          data-testid="void-cancel"
                          onClick={() => { setVoidingId(null); setReason(""); }}
                          className="border border-slate-300 rounded-lg px-3 py-2 text-sm bg-white min-h-[44px]"
                        >
                          {t("void.cancel")}
                        </button>
                      </div>
                    </div>
                  )}

                  {editingId === b.id && (
                    <div className="mt-2 pt-2 border-t border-slate-100 space-y-2">
                      <p className="text-sm text-slate-700">{t("completed.editConfirm")}</p>
                      <label
                        htmlFor={`edit-reason-${b.id}`}
                        className="block text-sm text-slate-700"
                      >
                        {t("completed.editReason")}
                      </label>
                      <input
                        id={`edit-reason-${b.id}`}
                        data-testid="edit-reason"
                        value={reason}
                        onChange={(e) => setReason(e.target.value)}
                        placeholder={t("void.reasonPlaceholder")}
                        className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm min-h-[44px]"
                      />
                      <div className="flex gap-2">
                        <button
                          data-testid="edit-confirm"
                          disabled={reason.trim() === "" || editing}
                          onClick={() => void editBill(b)}
                          className="border border-slate-300 text-slate-700 rounded-lg px-3 py-2 text-sm bg-white min-h-[44px] disabled:opacity-50"
                        >
                          {t("completed.edit")}
                        </button>
                        <button
                          data-testid="edit-cancel"
                          onClick={() => { setEditingId(null); setReason(""); }}
                          className="border border-slate-300 rounded-lg px-3 py-2 text-sm bg-white min-h-[44px]"
                        >
                          {t("void.cancel")}
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}

      {more && (
        <button
          data-testid="completed-more"
          onClick={loadMore}
          disabled={busy}
          className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm bg-white min-h-[44px] disabled:opacity-50"
        >
          {busy ? t("completed.loading") : t("completed.loadMore")}
        </button>
      )}

      <div className="pt-2 border-t border-slate-100">
        <button
          data-testid="completed-voided-toggle"
          onClick={() => setVoidedOpen((v) => !v)}
          className="text-sm text-slate-600 underline min-h-[44px]"
        >
          {voidedOpen ? t("completed.hideVoided") : t("completed.showVoided")}
        </button>

        {voidedOpen && (
          <div className="mt-2 space-y-2">
            <p className="text-xs text-slate-500">{t("completed.voidedTitle")}</p>
            {voidedRows.length === 0 ? (
              <p className="text-sm text-slate-500">{t("completed.noVoided")}</p>
            ) : (
              <ul className="space-y-2">
                {voidedRows.map((v) => (
                  <li
                    key={v.id}
                    data-testid={`voided-row-${v.id}`}
                    className="bg-slate-50 border border-slate-200 rounded-xl p-3 text-slate-500"
                  >
                    <p className="flex justify-between">
                      <span>
                        {v.customers?.name ?? t("completed.noCustomer")}
                        {" · "}
                        {t("completed.token", { n: v.token_no })}
                      </span>
                      <span className="line-through">{rupees(v.total)}</span>
                    </p>
                    <p className="text-xs">{t("void.reason", { reason: v.void_reason })}</p>
                    <p className="text-xs">
                      {t("void.by", { name: v.app_users?.name ?? "" })}
                      {" · "}
                      {new Date(v.voided_at).toLocaleString()}
                    </p>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
