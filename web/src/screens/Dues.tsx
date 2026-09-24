import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import "../i18n";
import { useSession } from "../components/SessionProvider";
import { loadDuesList, type DuesRow } from "../dues";
import { matchDues, totalOutstanding } from "../duesRules";
import { formatBusinessDate } from "../closeRules";
import { describeError } from "../errors";
import { rupees } from "../money";

/**
 * Who owes what. The balances and their order are the server's (dues_list, 0022); this
 * screen only sums what is owed for the header and filters as you type.
 */
export default function Dues() {
  const { t, i18n } = useTranslation();
  const session = useSession();
  const [rows, setRows] = useState<DuesRow[] | null>(null);
  const [problem, setProblem] = useState<{ key: string; detail: string } | null>(null);
  const [query, setQuery] = useState("");

  useEffect(() => {
    void (async () => {
      const { data, error } = await loadDuesList();
      setProblem(describeError(error));
      setRows(data);
    })();
  }, []);

  if (session.kind !== "ready") return null;
  const total = totalOutstanding(rows ?? []);
  const shown = matchDues(rows ?? [], query);

  return (
    <div className="space-y-4">
      <h1 className="text-lg font-semibold text-slate-800">{t("dues.title")}</h1>

      {problem && (
        <p data-testid="dues-problem" className="border border-red-200 bg-red-50 rounded-xl p-3 text-sm text-red-700">
          {t(problem.key)} <span className="text-xs text-slate-500">{problem.detail}</span>
        </p>
      )}

      {rows && (
        <p data-testid="dues-total" className="text-slate-800 font-semibold">
          {t("dues.total", { amount: rupees(total.amount), n: total.count })}
        </p>
      )}

      <div data-testid="dues-unassigned-slot" />

      <input
        data-testid="dues-search"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder={t("dues.search")}
        aria-label={t("dues.search")}
        className="w-full border border-slate-300 rounded-lg px-3 py-2 min-h-[44px]"
      />

      {rows && rows.length === 0 && !problem && (
        <p className="text-sm text-slate-500">{t("dues.empty")}</p>
      )}

      <ul className="divide-y divide-slate-100 border border-slate-200 rounded-xl bg-white">
        {shown.map((r) => (
          <li key={r.customer_id}>
            <Link to={`/dues/${r.customer_id}`} className="block px-3 py-3 min-h-[44px] active:bg-slate-100">
              <div data-testid={`dues-row-${r.customer_id}`} className="flex items-center justify-between gap-2">
                <span>
                  <span className="block font-medium text-slate-800">{r.name}</span>
                  <span className="block text-xs text-slate-500">
                    {r.flat_no}
                    {r.oldest_unpaid && ` · ${t("dues.since", { date: formatBusinessDate(r.oldest_unpaid, i18n.language) })}`}
                  </span>
                </span>
                {r.balance > 0 ? (
                  <span className="font-semibold text-slate-800">{rupees(r.balance)}</span>
                ) : (
                  <span className="text-sm text-slate-400">{t("dues.overpaid", { amount: rupees(-r.balance) })}</span>
                )}
              </div>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
