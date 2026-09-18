import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  collectedBetween, topItemsBetween, pairsBetween, requestsBetween, voidedBetween,
  type TopItem, type Pair, type Collected, type RequestCount, type Voided,
} from "../history";
import { presetRange, type Range } from "../dateRange";
import { DateFilter } from "../components/DateFilter";
import { itemName, type Lang } from "../i18n/locales";
import { rupees } from "../money";
import { describeError } from "../errors";
import "../i18n";

function Card({ title, subtitle, children }: {
  title: string; subtitle?: string; children: React.ReactNode;
}) {
  return (
    <section className="bg-white border border-slate-200 rounded-xl p-4">
      <h3 className="font-semibold text-slate-800">{title}</h3>
      {subtitle && <p className="text-xs text-slate-500 mb-2">{subtitle}</p>}
      {children}
    </section>
  );
}

export default function Dashboards() {
  const { t, i18n } = useTranslation();
  const [range, setRange] = useState<Range>(() => presetRange("month", new Date()));
  const [collected, setCollected] = useState(0);
  const [billCount, setBillCount] = useState(0);
  const [cost, setCost] = useState(0);
  const [profit, setProfit] = useState(0);
  const [uncosted, setUncosted] = useState(0);
  const [top, setTop] = useState<TopItem[]>([]);
  const [pairs, setPairs] = useState<Pair[]>([]);
  const [requests, setRequests] = useState<RequestCount[]>([]);
  const [voidCount, setVoidCount] = useState(0);
  const [voidedTotal, setVoidedTotal] = useState(0);
  const [problem, setProblem] = useState<{ key: string; detail: string } | null>(null);
  const [busy, setBusy] = useState(true);

  /** Which range the newest request was for. Tapping "This month" then "Today" fires two
   *  overlapping fetches, and the month one is the slower; without this guard it lands
   *  last and paints a month's totals under a Today filter. Same idiom as Customers.tsx. */
  const wanted = useRef<string>("");

  const lang = i18n.language as Lang;

  const load = useCallback(async (r: Range) => {
    const key = `${r.from}..${r.to}`;
    wanted.current = key;
    setBusy(true);
    const [money, items, together, asked, voided] = await Promise.all([
      collectedBetween(r), topItemsBetween(r), pairsBetween(r), requestsBetween(r), voidedBetween(r),
    ]);
    if (wanted.current !== key) return;   // superseded; a later range owns the screen now
    setBusy(false);
    // First error wins: five cards failing for one reason should say it once.
    setProblem(
      describeError(money.error) ?? describeError(items.error)
        ?? describeError(together.error) ?? describeError(asked.error)
        ?? describeError(voided.error),
    );
    // collected_between returns exactly one row. `total` is a Postgres numeric, which
    // PostgREST serialises as a STRING -- Number() it or rupees() renders a concatenation.
    const row = (money.data as Collected[] | null)?.[0];
    setCollected(Number(row?.total ?? 0));
    setBillCount(Number(row?.bill_count ?? 0));
    setCost(Number(row?.cost ?? 0));
    setProfit(Number(row?.profit ?? 0));
    setUncosted(Number(row?.uncosted_lines ?? 0));
    setTop((items.data ?? []) as TopItem[]);
    setPairs((together.data ?? []) as Pair[]);
    setRequests((asked.data ?? []) as RequestCount[]);
    const voidedRow = (voided.data as Voided[] | null)?.[0];
    setVoidCount(Number(voidedRow?.void_count ?? 0));
    setVoidedTotal(Number(voidedRow?.voided_total ?? 0));
  }, []);

  useEffect(() => { void load(range); }, [range, load]);

  return (
    <div className="space-y-4">
      <h2 className="font-semibold text-slate-800">{t("dash.title")}</h2>

      <DateFilter value={range} onChange={setRange} />

      {busy && (
        <p data-testid="dash-loading" className="text-sm text-slate-500">
          {t("dash.loading")}
        </p>
      )}

      {problem && (
        <div className="bg-red-50 border border-red-200 rounded-lg p-3">
          <p className="text-sm text-red-700">{t(problem.key)}</p>
          {/* The raw message, not just a category. Withholding it is what turned a
              missing migration into a guessing game. */}
          {problem.detail && (
            <p data-testid="dash-problem-detail" className="text-xs text-red-600 mt-1 break-words">
              {t("error.details")}: {problem.detail}
            </p>
          )}
        </div>
      )}

      <div className="grid gap-3 sm:grid-cols-2">
        <Card title={t("dash.collected")}>
          <p className="text-2xl font-semibold text-slate-800">{rupees(collected)}</p>
          <dl className="mt-2 text-sm grid grid-cols-2 gap-y-1">
            <dt className="text-slate-500">{t("dash.cost")}</dt>
            <dd data-testid="dash-cost" className="text-right text-slate-700">{rupees(cost)}</dd>
            <dt className="text-slate-500">{t("dash.profit")}</dt>
            <dd data-testid="dash-profit" className="text-right font-semibold text-slate-800">{rupees(profit)}</dd>
          </dl>
          {uncosted > 0 && (
            <p data-testid="dash-uncosted" className="mt-2 text-xs text-amber-700">
              {t("dash.uncosted", { n: uncosted })}
            </p>
          )}
        </Card>
        <Card title={t("dash.billCount")}>
          <p data-testid="dash-bill-count" className="text-2xl font-semibold text-slate-800">
            {billCount}
          </p>
          {voidCount > 0 && (
            <p data-testid="dash-voided" className="mt-2 text-xs text-amber-700">
              {t("dash.voided", { n: voidCount, amount: rupees(voidedTotal) })}
            </p>
          )}
        </Card>
      </div>

      <Card title={t("dash.topItems")} subtitle={t("dash.topItemsSub")}>
        {top.length === 0 ? (
          <p className="text-sm text-slate-500">{t("dash.empty")}</p>
        ) : (
          <ul className="space-y-1">
            {top.map((i) => (
              <li key={i.item_id} data-testid={`dash-top-${i.item_id}`} className="flex justify-between text-sm">
                <span className="text-slate-700">{itemName(i, lang)}</span>
                <span className="text-slate-600">
                  {t("dash.kg", { kg: i.total_qty_kg })} · {rupees(Number(i.total_revenue))}
                  {" · "}
                  <span data-testid={`dash-top-margin-${i.item_id}`}
                        title={t("dash.margin")}
                        className="text-green-700">
                    {i.margin === null ? "—" : rupees(Number(i.margin))}
                  </span>
                </span>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card title={t("dash.together")} subtitle={t("dash.togetherSub")}>
        {pairs.length === 0 ? (
          <p className="text-sm text-slate-500">{t("dash.empty")}</p>
        ) : (
          <ul className="space-y-1">
            {pairs.map((p) => (
              <li
                key={`${p.item_a}-${p.item_b}`}
                data-testid={`dash-pair-${p.item_a}-${p.item_b}`}
                className="flex justify-between text-sm"
              >
                <span className="text-slate-700">
                  {itemName({ name_en: p.name_a_en, name_hi: p.name_a_hi, name_mr: p.name_a_mr }, lang)}
                  {" + "}
                  {itemName({ name_en: p.name_b_en, name_hi: p.name_b_hi, name_mr: p.name_b_mr }, lang)}
                </span>
                <span className="text-slate-600">{t("dash.pairCount", { n: p.bill_count })}</span>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card title={t("dash.requests")} subtitle={t("dash.requestsSub")}>
        {requests.length === 0 ? (
          <p className="text-sm text-slate-500">{t("dash.empty")}</p>
        ) : (
          <ul className="space-y-1">
            {requests.map((r) => (
              <li key={r.item_name} data-testid={`dash-req-${r.item_name}`}
                  className="flex justify-between text-sm">
                <span className="text-slate-700 break-words">{r.item_name}</span>
                <span className="text-slate-600">
                  {t("dash.askedCount", { n: Number(r.request_count) })}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
