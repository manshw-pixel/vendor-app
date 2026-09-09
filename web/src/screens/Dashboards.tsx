import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  collectedBetween, topItemsBetween, pairsBetween,
  type TopItem, type Pair, type Collected,
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
  const [top, setTop] = useState<TopItem[]>([]);
  const [pairs, setPairs] = useState<Pair[]>([]);
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
    const [money, items, together] = await Promise.all([
      collectedBetween(r), topItemsBetween(r), pairsBetween(r),
    ]);
    if (wanted.current !== key) return;   // superseded; a later range owns the screen now
    setBusy(false);
    // First error wins: three cards failing for one reason should say it once.
    setProblem(
      describeError(money.error) ?? describeError(items.error) ?? describeError(together.error),
    );
    // collected_between returns exactly one row. `total` is a Postgres numeric, which
    // PostgREST serialises as a STRING -- Number() it or rupees() renders a concatenation.
    const row = (money.data as Collected[] | null)?.[0];
    setCollected(Number(row?.total ?? 0));
    setBillCount(Number(row?.bill_count ?? 0));
    setTop((items.data ?? []) as TopItem[]);
    setPairs((together.data ?? []) as Pair[]);
  }, []);

  useEffect(() => { void load(range); }, [range, load]);

  return (
    <div className="space-y-4">
      <h2 className="font-semibold text-slate-800">{t("dash.title")}</h2>

      <DateFilter value={range} onChange={setRange} />

      {busy && (
        <p data-testid="dash-loading" className="text-sm text-slate-500">
          {t("completed.loading")}
        </p>
      )}

      {problem && (
        <p className="text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg p-3">
          {t(problem.key)}
        </p>
      )}

      <div className="grid gap-3 sm:grid-cols-2">
        <Card title={t("dash.collected")}>
          <p className="text-2xl font-semibold text-slate-800">{rupees(collected)}</p>
        </Card>
        <Card title={t("dash.billCount")}>
          <p data-testid="dash-bill-count" className="text-2xl font-semibold text-slate-800">
            {billCount}
          </p>
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
                <span className="text-slate-700">{p.name_a} + {p.name_b}</span>
                <span className="text-slate-600">{t("dash.pairCount", { n: p.bill_count })}</span>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
