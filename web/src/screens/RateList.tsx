import { useRef, useState } from "react";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
// i18next initialises as a side effect of this import, exactly as Pending.tsx does.
import "../i18n";
import { listAllItems } from "../admin";
import { readRateList, listAliases, applyPriceList, downscale, type ApplyResult } from "../rateListApi";
import {
  buildReview, relinkReview, rowError, toApplyRows, type MatchItem, type ReviewRow,
} from "../rateListMatch";
import { UNITS, perUnit, type Unit } from "../units";
import { useSession } from "../components/SessionProvider";
import { itemName, type Lang } from "../i18n/locales";
import { rupees } from "../money";
import { describeError } from "../errors";

type Step = "pick" | "reading" | "review" | "confirm" | "applying" | "done";
const MAX_PHOTOS = 5;
const BTN = "border border-slate-300 rounded-lg px-3 py-2 text-sm bg-white min-h-[44px] disabled:opacity-50";
const INPUT = "border border-slate-300 rounded-lg px-3 py-2 min-h-[44px]";

const validPrice = (p: string) => { const n = Number(p); return p.trim() !== "" && Number.isFinite(n) && n > 0; };
/** An update row whose price is the current price: nothing to send. */
const sameAsNow = (r: ReviewRow) =>
  (r.kind === "update" || r.kind === "mismatch") && r.include && validPrice(r.price)
  && Math.abs(Number(r.price) - r.item.price) < 0.005;

export default function RateList() {
  const { t, i18n } = useTranslation();
  const session = useSession();
  const [step, setStep] = useState<Step>("pick");
  const [files, setFiles] = useState<File[]>([]);
  const [tooMany, setTooMany] = useState(false);
  const [problem, setProblem] = useState<{ key: string; detail: string } | null>(null);
  const [items, setItems] = useState<MatchItem[]>([]);
  const [review, setReview] = useState<ReviewRow[]>([]);
  const [showUnchanged, setShowUnchanged] = useState(false);
  const [result, setResult] = useState<ApplyResult | null>(null);
  const applying = useRef(false);

  if (session.kind !== "ready" || session.role !== "admin") return null;
  const lang = i18n.language as Lang;

  function pick(list: FileList | null) {
    const all = Array.from(list ?? []);
    setTooMany(all.length > MAX_PHOTOS);
    setFiles(all.slice(0, MAX_PHOTOS));
  }

  async function read() {
    setProblem(null);
    setStep("reading");
    try {
      const [images, itemsRes, aliasRes] = await Promise.all([
        Promise.all(files.map((f) => downscale(f))),
        listAllItems(),
        listAliases(),
      ]);
      const listProblem = describeError((itemsRes.error ?? aliasRes.error) as { message?: string } | null);
      if (listProblem) { setProblem(listProblem); setStep("pick"); return; }
      const { rows, error } = await readRateList(images);
      if (error) { setProblem(error); setStep("pick"); return; }
      if (!rows || rows.length === 0) { setProblem({ key: "rateList.noRows", detail: "" }); setStep("pick"); return; }
      const matchItems: MatchItem[] = (itemsRes.data ?? []).map((it) => ({
        id: it.id, name_en: it.name_en, name_hi: it.name_hi, name_mr: it.name_mr,
        price: Number(it.price), unit: it.unit,
      }));
      setItems(matchItems);
      setReview(buildReview(rows, matchItems, aliasRes.data ?? []));
      setShowUnchanged(false);
      setStep("review");
    } catch (e) {
      // e.g. a HEIC photo the browser cannot decode: back to the picker, not a crash.
      setProblem({ key: "rateList.readFailed", detail: e instanceof Error ? e.message : String(e) });
      setStep("pick");
    }
  }

  const put = (r: ReviewRow) => setReview((all) => all.map((x) => (x.key === r.key ? r : x)));

  const relink = (key: number, item: MatchItem) => setReview((all) => relinkReview(all, key, item));

  async function apply() {
    // A second tap before the re-render disables the button must not send the list twice.
    if (applying.current) return;
    applying.current = true;
    setProblem(null);
    setStep("applying");
    try {
      const { data, error } = await applyPriceList(toApplyRows(review));
      const described = describeError(error as { message?: string } | null);
      if (described || !data) { setProblem(described ?? { key: "error.unknown", detail: "" }); setStep("confirm"); return; }
      setResult(data);
      setStep("done");
    } catch (e) {
      setProblem({ key: "error.unknown", detail: e instanceof Error ? e.message : String(e) });
      setStep("confirm");
    } finally {
      applying.current = false;
    }
  }

  function reset() {
    setFiles([]); setTooMany(false); setProblem(null); setReview([]); setResult(null); setStep("pick");
  }

  const problemBox = problem && (
    <p className="text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg p-3">{t(problem.key)}</p>
  );
  const title = <h2 className="font-semibold text-slate-800">{t("rateList.title")}</h2>;

  if (step === "pick" || step === "reading") {
    return (
      <div className="space-y-4">
        {title}
        {problemBox}
        {step === "reading" ? <p className="text-slate-600">{t("rateList.reading")}</p> : (
          <div className="bg-white border border-slate-200 rounded-xl p-4 space-y-3">
            <p className="text-sm text-slate-600">{t("rateList.pick")}</p>
            <label className={`${BTN} inline-flex items-center cursor-pointer`}>
              {t("rateList.choose")}
              <input type="file" accept="image/*" multiple data-testid="rate-list-file"
                onChange={(e) => pick(e.target.files)} className="sr-only" />
            </label>
            {files.length > 0 && <p className="text-xs text-slate-600">{t("rateList.chosen", { n: files.length })}</p>}
            {tooMany && <p className="text-xs text-amber-700">{t("rateList.tooMany")}</p>}
            <button data-testid="rate-list-read" disabled={files.length === 0}
              onClick={() => void read()} className={BTN}>{t("rateList.read")}</button>
          </div>
        )}
      </div>
    );
  }

  const applyRows = toApplyRows(review);
  const unchangedClient = review.filter(sameAsNow).length;
  const skipped = review.filter((r) => r.kind === "duplicate" || !r.include).length;

  if (step === "review") {
    const changed = review.filter((r) => r.kind === "update" && r.include && !sameAsNow(r)).length;
    const added = review.filter((r) => r.kind === "new").length;
    const attention = review.filter((r) =>
      r.kind === "mismatch" || r.row.confidence === "low" || rowError(r) !== null).length;
    const hiddenCount = review.filter((r) => r.kind === "update" && !r.changed).length;
    const anyError = review.some((r) => rowError(r) !== null);
    const visible = review.filter((r) => showUnchanged || !(r.kind === "update" && !r.changed));
    return (
      <div className="space-y-4">
        {title}
        <p className="text-sm text-slate-700">{t("rateList.summary", { changed, added, attention })}</p>
        {hiddenCount > 0 && (
          <label className="flex items-center gap-2 text-sm text-slate-600 min-h-[44px]">
            <input type="checkbox" data-testid="rate-list-show-unchanged" checked={showUnchanged}
              onChange={(e) => setShowUnchanged(e.target.checked)} />
            {t("rateList.showUnchanged", { n: hiddenCount })}
          </label>
        )}
        <ul className="space-y-3">
          {visible.map((r) => (
            <RowView key={r.key} r={r} items={items} put={put} relink={relink} />
          ))}
        </ul>
        <button data-testid="rate-review" disabled={applyRows.length === 0 || anyError}
          onClick={() => setStep("confirm")} className={BTN}>{t("rateList.review")}</button>
      </div>
    );
  }

  if (step === "confirm" || step === "applying") {
    const byKey = review.filter((r) => r.kind !== "duplicate" && r.include && (r.kind === "new" || !sameAsNow(r)));
    const ups = byKey.filter((r): r is ReviewRow & { kind: "update" | "mismatch" } => r.kind === "update" || r.kind === "mismatch");
    const news = byKey.filter((r): r is ReviewRow & { kind: "new" } => r.kind === "new");
    return (
      <div className="space-y-4">
        <h2 className="font-semibold text-slate-800">{t("rateList.confirmTitle")}</h2>
        {problemBox}
        {ups.length > 0 && (
          <section className="bg-white border border-slate-200 rounded-xl p-4">
            <h3 className="font-medium text-slate-700 mb-2">{t("rateList.toChange")}</h3>
            <ul data-testid="rate-confirm-updates" className="space-y-1 text-sm">
              {ups.map((r) => (
                <li key={r.key}>
                  {itemName(r.item, lang)} — {rupees(r.item.price)} → {rupees(Number(r.price))} {perUnit(r.item.unit, t)}
                </li>
              ))}
            </ul>
          </section>
        )}
        {news.length > 0 && (
          <section className="bg-white border border-slate-200 rounded-xl p-4">
            <h3 className="font-medium text-slate-700 mb-2">{t("rateList.toAdd")}</h3>
            <ul data-testid="rate-confirm-creates" className="space-y-1 text-sm">
              {news.map((r) => (
                <li key={r.key}>
                  {itemName(r.names, lang)} — {rupees(Number(r.price))} {perUnit(r.unit, t)}
                  <span className="block text-xs text-slate-500">{t("rateList.addedNote")}</span>
                </li>
              ))}
            </ul>
          </section>
        )}
        <p className="text-sm text-slate-600">
          {t("rateList.unchangedCount", { n: unchangedClient })} · {t("rateList.skippedCount", { n: skipped })}
        </p>
        {step === "applying" && <p className="text-slate-600">{t("rateList.applying")}</p>}
        <div className="flex gap-2">
          <button data-testid="rate-confirm-back" disabled={step === "applying"}
            onClick={() => { setProblem(null); setStep("review"); }} className={BTN}>{t("rateList.back")}</button>
          <button data-testid="rate-apply" disabled={step === "applying"}
            onClick={() => void apply()} className={BTN}>{t("rateList.apply")}</button>
        </div>
      </div>
    );
  }

  // done
  const updated = result?.updated ?? [];
  const created = result?.created ?? [];
  return (
    <div className="space-y-4">
      <h2 className="font-semibold text-emerald-800">{t("rateList.completed")}</h2>
      <p className="text-sm text-slate-700">
        {t("rateList.resultTitle", { changed: updated.length, added: created.length })}
      </p>
      {updated.length > 0 && (
        <section className="bg-white border border-slate-200 rounded-xl p-4">
          <h3 className="font-medium text-slate-700 mb-2">{t("rateList.pricesChanged")}</h3>
          <ul data-testid="rate-result-updated" className="space-y-1 text-sm">
            {updated.map((u) => {
              const oldP = Number(u.old_price), newP = Number(u.new_price);
              return (
                <li key={u.item_id}>
                  {itemName(u, lang)} — {rupees(oldP)} → {rupees(newP)} {perUnit(u.unit, t)}{" "}
                  {newP > oldP && <span className="text-red-700">▲</span>}
                  {newP < oldP && <span className="text-emerald-700">▼</span>}
                </li>
              );
            })}
          </ul>
        </section>
      )}
      {created.length > 0 && (
        <section className="bg-white border border-slate-200 rounded-xl p-4">
          <h3 className="font-medium text-slate-700 mb-2">{t("rateList.itemsAdded")}</h3>
          <ul data-testid="rate-result-created" className="space-y-1 text-sm">
            {created.map((c) => (
              <li key={c.item_id}>
                {itemName(c, lang)} — {rupees(Number(c.price))} {perUnit(c.unit, t)}
                <span className="block text-xs text-slate-500">{t("rateList.addedNote")}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
      <p className="text-sm text-slate-600">
        {t("rateList.unchangedCount", { n: Number(result?.unchanged ?? 0) + unchangedClient })} ·{" "}
        {t("rateList.skippedCount", { n: skipped })}
      </p>
      <div className="flex gap-2">
        <Link to="/items" className={`${BTN} inline-flex items-center`}>{t("rateList.done")}</Link>
        <button onClick={reset} className={BTN}>{t("rateList.another")}</button>
      </div>
    </div>
  );
}

function RowView({ r, items, put, relink }: {
  r: ReviewRow; items: MatchItem[]; put: (r: ReviewRow) => void; relink: (key: number, item: MatchItem) => void;
}) {
  const { t, i18n } = useTranslation();
  const lang = i18n.language as Lang;
  const err = rowError(r);
  const priceInput = (rr: Exclude<ReviewRow, { kind: "duplicate" }>, unit: Unit) => (
    <span className="inline-flex items-center gap-1">
      <input data-testid={`rate-price-${rr.key}`} inputMode="decimal" value={rr.price}
        onChange={(e) => {
          const price = e.target.value;
          put({ ...rr, price, include: (rr.kind === "mismatch" || (rr.kind === "new" && rr.quantity)) && validPrice(price) ? true : rr.include } as ReviewRow);
        }}
        className={`${INPUT} w-24`} />
      <span className="text-sm text-slate-500">{perUnit(unit, t)}</span>
    </span>
  );

  return (
    <li data-testid={`rate-row-${r.key}`} className="bg-white border border-slate-200 rounded-xl p-3 space-y-2">
      <div className="flex items-start justify-between gap-2">
        <div className="text-sm">
          <span className="font-medium text-slate-800">{r.row.name_as_written}</span>{" "}
          <span className="text-slate-500">{r.row.sold_by_as_written}</span>
          {r.row.confidence === "low" && (
            <span className="ml-2 text-xs bg-amber-100 text-amber-800 rounded px-1">{t("rateList.lowConfidence")}</span>
          )}
        </div>
        {r.kind !== "duplicate" && (
          <label className="flex items-center gap-1 text-sm text-slate-600 min-h-[44px]">
            <input type="checkbox" data-testid={`rate-include-${r.key}`} checked={r.include}
              onChange={(e) => put({ ...r, include: e.target.checked })} />
            {t("rateList.include")}
          </label>
        )}
      </div>

      {r.kind === "update" && (
        <div className="text-sm text-slate-700 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <span>{itemName(r.item, lang)} — {rupees(r.item.price)} →</span>
            {priceInput(r, r.item.unit)}
          </div>
          {r.grams !== null && (
            <p className="text-xs text-slate-500">
              {t("rateList.converted", { grams: r.grams, listPrice: r.row.price, price: r.price })}
            </p>
          )}
        </div>
      )}

      {r.kind === "mismatch" && (
        <div className="text-sm text-slate-700 space-y-1">
          <p className="text-amber-700">
            {r.reason === "quantity"
              ? t("rateList.quantity", { soldBy: r.row.sold_by_as_written, unit: t(`unit.name.${r.item.unit}`) })
              : t("rateList.mismatch", { listUnit: t(`unit.name.${r.listUnit}`), unit: t(`unit.name.${r.item.unit}`) })}
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <span>{itemName(r.item, lang)} — {rupees(r.item.price)} →</span>
            {priceInput(r, r.item.unit)}
          </div>
        </div>
      )}

      {r.kind === "new" && (
        <div className="text-sm space-y-2">
          <span className="text-xs bg-sky-100 text-sky-800 rounded px-1">{t("rateList.newItem")}</span>
          {r.quantity && (
            <p className="text-amber-700">
              {t("rateList.quantity", { soldBy: r.row.sold_by_as_written, unit: t(`unit.name.${r.unit}`) })}
            </p>
          )}
          {(["name_en", "name_hi", "name_mr"] as const).map((f) => (
            <input key={f} data-testid={`rate-name-${f.slice(5)}-${r.key}`} value={r.names[f]}
              aria-label={t(`items.name${f.slice(5, 6).toUpperCase()}${f.slice(6)}`)}
              onChange={(e) => put({ ...r, names: { ...r.names, [f]: e.target.value } })}
              className={`${INPUT} w-full`} />
          ))}
          <div className="flex flex-wrap items-center gap-2">
            <select data-testid={`rate-unit-${r.key}`} value={r.unit}
              onChange={(e) => put({ ...r, unit: e.target.value as Unit })} className={INPUT}>
              {UNITS.map((u) => <option key={u} value={u}>{t(`unit.name.${u}`)}</option>)}
            </select>
            {priceInput(r, r.unit)}
          </div>
          {r.suggestion && (
            <button data-testid={`rate-suggest-${r.key}`} onClick={() => relink(r.key, r.suggestion!)}
              className={BTN}>{t("rateList.didYouMean", { name: itemName(r.suggestion, lang) })}</button>
          )}
          <select data-testid={`rate-link-${r.key}`} value="" aria-label={t("rateList.linkTo")}
            onChange={(e) => { const it = items.find((i) => i.id === e.target.value); if (it) relink(r.key, it); }}
            className={`${INPUT} w-full`}>
            <option value="">{t("rateList.linkTo")}</option>
            {items.map((i) => <option key={i.id} value={i.id}>{itemName(i, lang)}</option>)}
          </select>
        </div>
      )}

      {r.kind === "duplicate" && <p className="text-sm text-slate-400">{t("rateList.duplicate")}</p>}
      {err && <p className="text-xs text-red-700">{t(err)}</p>}
    </li>
  );
}
