import { useState } from "react";
import { useTranslation } from "react-i18next";
import { PRESETS, presetRange, validateRange, type Preset, type Range } from "../dateRange";
import "../i18n";

/** Presets plus a custom range, shared by /completed and /dashboards so the two screens
 *  cannot disagree about what "this week" means. */
export function DateFilter({
  value,
  onChange,
}: {
  value: Range;
  onChange: (r: Range) => void;
}) {
  const { t } = useTranslation();
  const [custom, setCustom] = useState(false);
  const [from, setFrom] = useState(value.from);
  const [to, setTo] = useState(value.to);
  const [error, setError] = useState<string | null>(null);

  function pick(p: Preset) {
    setCustom(false);
    setError(null);
    onChange(presetRange(p, new Date()));
  }

  function apply() {
    const checked = validateRange(from, to);
    if (!checked.ok) {
      setError(checked.error);
      return;
    }
    setError(null);
    onChange(checked.value);
  }

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-2">
        {PRESETS.map((p) => (
          <button
            key={p}
            data-testid={`range-${p}`}
            onClick={() => pick(p)}
            className="border border-slate-300 rounded-lg px-3 py-2 text-sm bg-white min-h-[44px]"
          >
            {t(`range.${p}`)}
          </button>
        ))}
        <button
          data-testid="range-custom"
          onClick={() => setCustom((c) => !c)}
          className="border border-slate-300 rounded-lg px-3 py-2 text-sm bg-white min-h-[44px]"
        >
          {t("range.custom")}
        </button>
      </div>

      {custom && (
        <div className="flex flex-wrap items-end gap-2 bg-white border border-slate-200 rounded-xl p-3">
          <label className="text-sm text-slate-600">
            {t("range.from")}
            <input
              type="date"
              data-testid="range-from"
              value={from}
              onChange={(e) => setFrom(e.target.value)}
              className="mt-1 block border border-slate-300 rounded-lg px-3 py-2 min-h-[44px]"
            />
          </label>
          <label className="text-sm text-slate-600">
            {t("range.to")}
            <input
              type="date"
              data-testid="range-to"
              value={to}
              onChange={(e) => setTo(e.target.value)}
              className="mt-1 block border border-slate-300 rounded-lg px-3 py-2 min-h-[44px]"
            />
          </label>
          <button
            data-testid="range-apply"
            onClick={apply}
            className="rounded-lg px-4 py-2 text-sm bg-slate-800 text-white min-h-[44px]"
          >
            {t("range.apply")}
          </button>
        </div>
      )}

      {error && (
        <p data-testid="range-error" className="text-sm text-red-700">
          {t(error)}
        </p>
      )}
    </div>
  );
}
