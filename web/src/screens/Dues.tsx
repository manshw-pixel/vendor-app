import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import "../i18n";
import { useSession } from "../components/SessionProvider";
import { assignCreditCustomer, loadDuesList, loadUnassignedCredit, type DuesRow, type UnassignedBill } from "../dues";
import { matchDues, totalOutstanding } from "../duesRules";
import { formatBusinessDate } from "../closeRules";
import { describeError } from "../errors";
import { rupees } from "../money";
import { listCustomers } from "../data";
import { matchCustomers, type Customer } from "../customers";
import { Button } from "../ui/Button";
import { Banner } from "../ui/Banner";
import { Card } from "../ui/Card";
import { EmptyState } from "../ui/EmptyState";

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
  const [unassigned, setUnassigned] = useState<UnassignedBill[]>([]);
  const [showUnassigned, setShowUnassigned] = useState(false);
  const [assigning, setAssigning] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [pickQuery, setPickQuery] = useState("");
  const isAdmin = session.kind === "ready" && session.role === "admin";

  const load = useCallback(async () => {
    const [list, orphans] = await Promise.all([
      loadDuesList(),
      isAdmin ? loadUnassignedCredit() : Promise.resolve({ data: [] as UnassignedBill[], error: null }),
    ]);
    setProblem(describeError(list.error) ?? describeError(orphans.error));
    setRows(list.data);
    setUnassigned(orphans.data ?? []);
  }, [isAdmin]);

  useEffect(() => { void load(); }, [load]);

  async function startAssign(billId: string) {
    setAssigning(billId);
    setPickQuery("");
    if (customers.length === 0) {
      const { data, error } = await listCustomers();
      if (error) { setProblem(describeError(error)); return; }
      setCustomers((data ?? []) as Customer[]);
    }
  }

  async function assign(billId: string, customerId: string) {
    if (busy) return;
    setBusy(true);
    try {
      const { error } = await assignCreditCustomer(billId, customerId);
      setAssigning(null);
      await load();
      if (error) setProblem(describeError(error));
    } finally {
      setBusy(false);
    }
  }

  if (session.kind !== "ready") return null;
  const total = totalOutstanding(rows ?? []);
  const shown = matchDues(rows ?? [], query);

  return (
    <div className="space-y-4">
      <h1 className="text-lg font-semibold text-slate-800">{t("dues.title")}</h1>

      {problem && (
        <Banner tone="error">
          <span data-testid="dues-problem">{t(problem.key)} <span className="text-xs text-slate-500">{problem.detail}</span></span>
        </Banner>
      )}

      {rows && (
        <p data-testid="dues-total" className="text-slate-800 font-semibold">
          {t("dues.total", { amount: rupees(total.amount), n: total.count })}
        </p>
      )}

      {isAdmin && unassigned.length > 0 && (
        <Card className="border-amber-200 p-3 space-y-2">
          <Button data-testid="dues-unassigned" variant="ghost" onClick={() => setShowUnassigned((s) => !s)}
                  className="w-full text-left text-sm font-semibold text-amber-800">
            {t("dues.unassigned", {
              n: unassigned.length,
              amount: rupees(unassigned.reduce((s, b) => s + b.amount, 0)),
            })}
          </Button>
          {showUnassigned && (
            <ul className="space-y-2">
              {unassigned.map((b) => (
                <li key={b.bill_id} className="text-sm space-y-2">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-slate-700">
                      {t("dues.kind.credit_bill", { n: b.token_no ?? "—" })} · {rupees(b.amount)}
                    </span>
                    <Button data-testid={`dues-assign-${b.bill_id}`} variant="secondary" onClick={() => void startAssign(b.bill_id)}>
                      {t("dues.assign")}
                    </Button>
                  </div>
                  {assigning === b.bill_id && (
                    <div className="space-y-2">
                      <p className="text-xs text-slate-500">{t("dues.assignPick", { n: b.token_no ?? "—" })}</p>
                      <input value={pickQuery} onChange={(e) => setPickQuery(e.target.value)}
                             aria-label={t("dues.search")} placeholder={t("dues.search")}
                             className="w-full border border-slate-300 rounded-lg px-3 py-2 min-h-[44px]" />
                      <ul className="divide-y divide-slate-100 border border-slate-200 rounded-lg">
                        {matchCustomers(customers, pickQuery).map((c) => (
                          <li key={c.id}>
                            <Button data-testid={`dues-assign-pick-${c.id}`} variant="ghost" onClick={() => void assign(b.bill_id, c.id)}
                                    disabled={busy}
                                    className="w-full text-left">
                              {c.name} · {c.flat_no}
                            </Button>
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
        </Card>
      )}

      <input
        data-testid="dues-search"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder={t("dues.search")}
        aria-label={t("dues.search")}
        className="w-full border border-slate-300 rounded-lg px-3 py-2 min-h-[44px]"
      />

      {rows && rows.length === 0 && !problem && (
        <EmptyState>{t("dues.empty")}</EmptyState>
      )}

      <ul className="divide-y divide-slate-100 border border-slate-200 rounded-xl bg-surface">
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
