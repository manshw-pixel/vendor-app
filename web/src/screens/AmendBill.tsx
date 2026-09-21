import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate, useParams } from "react-router-dom";
// i18next initialises as a side effect of this import, exactly as Bill.tsx does.
import "../i18n";
import { runningTotal, type Draft } from "../billing";
import { amendPendingBill, billDraftLines, listItems, type Item } from "../data";
import { describeError } from "../errors";
import { LANGS, type Lang } from "../i18n/locales";
import { rupees } from "../money";
import { ItemGrid } from "./bill/ItemGrid";
import { Basket } from "./bill/Basket";

// Copied from Bill.tsx rather than exported from locales.ts -- duplicating four lines is
// cheaper than a shared export only two screens want.
const asLang = (tag: string | undefined): Lang =>
  (LANGS as readonly string[]).includes(tag ?? "") ? (tag as Lang) : "en";

/**
 * Correcting a bill that already has a token.
 *
 * A separate screen from Bill.tsx rather than a mode inside it. Bill.tsx is a state
 * machine over customer -> items -> token whose whole job is bringing a bill into
 * existence; this screen starts from a bill that already exists and never touches the
 * customer or the token. Sharing ItemGrid and Basket -- already extracted -- gives the
 * reuse that matters without threading a second lifecycle through the first one's phases.
 *
 * The OLD total is kept on screen beside the new one for the whole edit. The customer has
 * already been told a number; the biller has to be able to read them the corrected one
 * and see, at a glance, that it changed.
 */
export default function AmendBill() {
  const { billId = "" } = useParams();
  const navigate = useNavigate();
  const { t, i18n } = useTranslation();

  const [items, setItems] = useState<readonly Item[]>([]);
  const [lines, setLines] = useState<Draft[] | null>(null);
  const [oldTotal, setOldTotal] = useState<number | null>(null);
  const [problem, setProblem] = useState<{ key: string; detail: string } | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    void (async () => {
      const [drafts, catalogue] = await Promise.all([billDraftLines(billId), listItems()]);
      setProblem(describeError(drafts.error) ?? describeError(catalogue.error));
      const loaded = drafts.data ?? [];
      setLines(loaded);
      // Captured ONCE, from the lines as they were stored. Recomputing it later would
      // make it track the edit and the comparison would always read "no change".
      setOldTotal(runningTotal(loaded));
      setItems((catalogue.data ?? []) as unknown as Item[]);
    })();
  }, [billId]);

  async function save() {
    if (!lines || lines.length === 0) return;
    setSaving(true);
    const { error } = await amendPendingBill(billId, lines);
    setSaving(false);
    const described = describeError(error);
    setProblem(described);
    if (described) { setConfirming(false); return; }
    navigate("/pending");
  }

  if (lines === null) return null;
  const newTotal = runningTotal(lines);

  return (
    <div className="space-y-4">
      <h2 className="font-semibold text-slate-800">{t("amend.title")}</h2>

      {problem && (
        <p data-testid="amend-error"
           className="text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg p-3">
          {t(problem.key)}
        </p>
      )}

      <div className="bg-white border border-slate-200 rounded-xl p-3 flex gap-6">
        <span className="text-sm text-slate-500">
          {t("amend.oldTotal")}{" "}
          <span data-testid="amend-old-total" className="tabular-nums line-through">
            {rupees(oldTotal ?? 0)}
          </span>
        </span>
        <span className="text-sm font-medium text-slate-800">
          {t("amend.newTotal")}{" "}
          <span data-testid="amend-new-total" className="tabular-nums">{rupees(newTotal)}</span>
        </span>
      </div>

      <Basket
        lines={lines}
        onRemove={(i) => setLines(lines.filter((_, n) => n !== i))}
      />

      <ItemGrid
        items={items}
        lang={asLang(i18n.language)}
        onAdd={(line) => setLines([...lines, line])}
      />

      {confirming ? (
        <div className="bg-white border border-slate-200 rounded-xl p-3 space-y-3">
          <p className="text-sm text-slate-700">
            {t("amend.confirm", { old: rupees(oldTotal ?? 0), next: rupees(newTotal) })}
          </p>
          <div className="flex gap-2">
            <button
              data-testid="amend-confirm" onClick={() => void save()} disabled={saving}
              className="rounded-lg px-4 py-2 text-sm bg-slate-800 text-white min-h-[44px] disabled:opacity-50"
            >
              {t("amend.confirmSave")}
            </button>
            <button
              onClick={() => setConfirming(false)}
              className="border border-slate-300 rounded-lg px-4 py-2 text-sm bg-white min-h-[44px]"
            >
              {t("amend.cancel")}
            </button>
          </div>
        </div>
      ) : (
        <div className="flex gap-2">
          <button
            data-testid="amend-save"
            onClick={() => setConfirming(true)}
            disabled={lines.length === 0}
            className="rounded-lg px-4 py-2 text-sm bg-slate-800 text-white min-h-[44px] disabled:opacity-50"
          >
            {t("amend.save")}
          </button>
          <button
            onClick={() => navigate("/pending")}
            className="border border-slate-300 rounded-lg px-4 py-2 text-sm bg-white min-h-[44px]"
          >
            {t("amend.cancel")}
          </button>
        </div>
      )}
    </div>
  );
}
