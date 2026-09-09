import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
// i18next initialises as a side effect of this import, exactly as the sibling screens do.
import "../i18n";
import { loadVendorConfig, updateVendorConfig } from "../admin";
import { validateSettings, type SettingsInput, type SettingsField } from "../adminRules";
import { useSession } from "../components/SessionProvider";
import { describeError } from "../errors";

const FIELDS = [
  ["points_threshold_1", "settings.threshold1"],
  ["points_reward_1", "settings.reward1"],
  ["points_threshold_2", "settings.threshold2"],
  ["points_reward_2", "settings.reward2"],
  ["redeem_days", "settings.redeemDays"],
] as const;

const BLANK: SettingsInput = {
  points_threshold_1: "", points_reward_1: "",
  points_threshold_2: "", points_reward_2: "", redeem_days: "",
};

export default function Settings() {
  const { t } = useTranslation();
  const session = useSession();
  const [input, setInput] = useState<SettingsInput>(BLANK);
  const [errors, setErrors] = useState<Partial<Record<SettingsField, string>>>({});
  const [problem, setProblem] = useState<{ key: string; detail: string } | null>(null);
  const [saved, setSaved] = useState(false);
  // Distinct from `problem`: it's not just that the load failed, it's that we never got
  // a row to edit at all, so the form must not render -- rendering it would put up blank
  // inputs that pass validateSettings and let an admin "save" the required-field minimums
  // over their real configuration.
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);

  const vendorId = session.kind === "ready" ? session.vendorId : null;

  useEffect(() => {
    if (!vendorId) return;
    void (async () => {
      const { data, error } = await loadVendorConfig(vendorId);
      if (data) {
        setInput({
          points_threshold_1: String(data.points_threshold_1),
          points_reward_1: String(data.points_reward_1),
          points_threshold_2: String(data.points_threshold_2),
          points_reward_2: String(data.points_reward_2),
          redeem_days: String(data.redeem_days),
        });
        setProblem(describeError(error));
        setLoaded(true);
      } else {
        // .maybeSingle() returns { data: null, error: null } for zero rows, same as a
        // clean "not found" -- not an exception. The vendor row is guaranteed to exist in
        // practice, but if RLS ever filters it away (stale/wrong vendorId, a session
        // desync) this is where that shows up, and describeError(null) would say nothing
        // is wrong. Report it explicitly and leave `loaded` false.
        setProblem(describeError(error) ?? { key: "error.unknown", detail: "" });
      }
    })();
  }, [vendorId]);

  if (!vendorId) return null;

  async function save() {
    setSaved(false);
    const result = validateSettings(input);
    if (!result.ok) { setErrors(result.errors); return; }
    setErrors({});
    setBusy(true);
    const { error } = await updateVendorConfig(vendorId!, result.value);
    setBusy(false);
    const described = describeError(error);
    setProblem(described);
    if (!described) setSaved(true);
  }

  return (
    <div className="bg-white border border-slate-200 rounded-xl p-4 space-y-3 max-w-md">
      <h2 className="font-semibold text-slate-800">{t("settings.title")}</h2>
      <p data-testid="settings-future-only" className="text-sm text-slate-600">
        {t("settings.futureOnly")}
      </p>

      {problem && (
        <p data-testid="settings-problem" className="text-sm text-red-700">{t(problem.key)}</p>
      )}

      {loaded && (
        <form
          onSubmit={(e) => { e.preventDefault(); void save(); }}
          className="space-y-3"
        >
          {FIELDS.map(([field, labelKey]) => (
            <div key={field}>
              <label className="block text-sm text-slate-600 mb-1" htmlFor={`settings-${field}`}>
                {t(labelKey)}
              </label>
              <input
                id={`settings-${field}`} data-testid={`settings-${field}`}
                value={input[field]} inputMode="decimal"
                onChange={(e) => setInput({ ...input, [field]: e.target.value })}
                className="w-full border border-slate-300 rounded-lg px-3 py-2 min-h-[44px]"
              />
              {errors[field] && (
                <p data-testid={`settings-error-${field}`} className="text-xs text-red-700 mt-1">
                  {t(errors[field]!)}
                </p>
              )}
            </div>
          ))}

          {saved && (
            <p data-testid="settings-saved" className="text-sm text-green-700">{t("settings.saved")}</p>
          )}

          <button
            type="submit" data-testid="settings-save" disabled={busy}
            className="rounded-lg px-4 py-2 text-sm bg-slate-800 text-white min-h-[44px] disabled:opacity-50"
          >
            {t("settings.save")}
          </button>
        </form>
      )}
    </div>
  );
}
