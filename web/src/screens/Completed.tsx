import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  listCompleted, billLines, PAGE_SIZE,
  type CompletedBill, type BillLine, type Cursor,
} from "../history";
import { presetRange, type Range } from "../dateRange";
import { DateFilter } from "../components/DateFilter";
import { itemName, type Lang } from "../i18n/locales";
import { rupees } from "../money";
import { describeError } from "../errors";
import "../i18n";

export default function Completed() {
  const { t, i18n } = useTranslation();
  const [range, setRange] = useState<Range>(() => presetRange("today", new Date()));
  const [rows, setRows] = useState<CompletedBill[]>([]);
  const [more, setMore] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const [lines, setLines] = useState<BillLine[]>([]);
  const [problem, setProblem] = useState<{ key: string; detail: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const lang = i18n.language as Lang;

  /** after=null starts a fresh period; a cursor appends the next page. */
  const load = useCallback(async (r: Range, after: Cursor | null) => {
    setBusy(true);
    const { data, error } = await listCompleted(r, after);
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

  useEffect(() => {
    setOpen(null);
    void load(range, null);
  }, [range, load]);

  async function openBill(id: string) {
    if (open === id) { setOpen(null); return; }
    setOpen(id);
    setLines([]);
    const { data, error } = await billLines(id);
    setProblem(describeError(error));
    setLines((data ?? []) as unknown as BillLine[]);
  }

  function loadMore() {
    const last = rows[rows.length - 1];
    if (!last) return;
    void load(range, { completedAt: last.completed_at, id: last.id });
  }

  return (
    <div className="space-y-4">
      <h2 className="font-semibold text-slate-800">{t("completed.title")}</h2>

      <DateFilter value={range} onChange={setRange} />

      {problem && (
        <p className="text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg p-3">
          {t(problem.key)}
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
                          {t("completed.qtyLine", { qty: l.qty_kg })}
                        </span>
                        <span className="text-slate-600">{rupees(l.line_total)}</span>
                      </li>
                    ))}
                  </ul>
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
    </div>
  );
}
