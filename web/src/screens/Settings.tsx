import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
// i18next initialises as a side effect of this import, exactly as the sibling screens do.
import "../i18n";
import {
  clearVendorData, loadVendorConfig, updateVendorConfig, type ClearedCounts,
  loadShopDetails, updateShopDetails, type ShopDetails,
} from "../admin";
import { validateSettings, type SettingsInput, type SettingsField } from "../adminRules";
import { useSession } from "../components/SessionProvider";
import { describeError } from "../errors";
import Staff from "./Staff";

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

  // Items and Staff gate on useSession()'s own `session.kind !== "ready"`; Customers needs
  // no vendorId at all. Settings uses a vendorId ternary plus this separate `loaded` flag
  // because loadVendorConfig uses .maybeSingle(), which returns { data: null, error: null }
  // rather than raising when RLS filters the vendor row out -- rendering the form over that
  // would invite an admin to save blanks over their real loyalty configuration. The other
  // screens don't need this because a filtered list read there is legitimately "nothing
  // yet", not a form waiting to clobber real data.
  const vendorId = session.kind === "ready" ? session.vendorId : null;
  const vendorName = session.kind === "ready" ? session.vendorName : "";

  // Shop details (address/phone for the receipt header). Separate state and save button
  // from the loyalty form above: those fields run through validateSettings, which demands
  // a positive number and rejects a blank, and these are optional free text.
  const [shop, setShop] = useState<ShopDetails>({ address: "", phone: "" });
  const [shopSaved, setShopSaved] = useState(false);
  const [shopProblem, setShopProblem] = useState<{ key: string; detail: string } | null>(null);
  const [shopBusy, setShopBusy] = useState(false);
  // Distinct from the fields being empty: loadShopDetails uses .maybeSingle(), so an
  // RLS-filtered read returns { data: null, error: null } -- the same shape as a genuinely
  // blank row. Without this flag, that filtered read would leave `shop` at its initial
  // { address: "", phone: "" } with Save still enabled, and clicking Save would write
  // those blanks over a real stored address and phone. Same trap `loaded` guards against
  // in the loyalty form above.
  const [shopLoaded, setShopLoaded] = useState(false);

  useEffect(() => {
    if (!vendorId) return;
    void (async () => {
      const { data, error } = await loadShopDetails(vendorId);
      if (data) {
        setShop({ address: data.address ?? "", phone: data.phone ?? "" });
        setShopProblem(describeError(error));
        setShopLoaded(true);
      } else {
        // Zero rows from .maybeSingle() is not an exception, same as loadVendorConfig's
        // equivalent case -- report it explicitly and leave shopLoaded false so Save
        // cannot fire against a read that never resolved to a definite row.
        setShopProblem(describeError(error) ?? { key: "error.unknown", detail: "" });
      }
    })();
  }, [vendorId]);

  async function saveShop() {
    if (!shopLoaded) return;
    setShopSaved(false);
    setShopProblem(null);
    setShopBusy(true);
    const { error } = await updateShopDetails(vendorId!, shop);
    setShopBusy(false);
    const described = describeError(error);
    setShopProblem(described);
    if (!described) setShopSaved(true);
  }

  // Danger zone. Kept in its own state so a failed or abandoned wipe cannot disturb the
  // loyalty form above it -- they share a screen, not a workflow.
  const [wiping, setWiping] = useState(false);
  const [typedName, setTypedName] = useState("");
  const [wipeBusy, setWipeBusy] = useState(false);
  const [wiped, setWiped] = useState<ClearedCounts | null>(null);
  const [wipeProblem, setWipeProblem] = useState<{ key: string; detail: string } | null>(null);

  async function clearData() {
    setWipeBusy(true);
    setWipeProblem(null);
    const { data, error } = await clearVendorData();
    setWipeBusy(false);
    const described = describeError(error);
    if (described) { setWipeProblem(described); return; }
    // A returns-table function arrives from PostgREST as an array of one row.
    const row = (Array.isArray(data) ? data[0] : data) as ClearedCounts | undefined;
    setWiped(row ?? { bills: 0, customers: 0, points_rows: 0 });
    setWiping(false);
    setTypedName("");
  }

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
    setProblem(null);
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
    <div className="space-y-6">
      <section className="bg-white border border-slate-200 rounded-xl p-4 space-y-3 max-w-md">
        <h2 className="font-semibold text-slate-800">{t("settings.loyaltySection")}</h2>
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
                  onChange={(e) => {
                    // Any edit retracts the "Saved." claim below -- it was true of the
                    // form as submitted, not of the form as it now reads.
                    setSaved(false);
                    setInput({ ...input, [field]: e.target.value });
                  }}
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
      </section>

      <section className="bg-white border border-slate-200 rounded-xl p-4 space-y-3 max-w-md">
        <h2 className="font-semibold text-slate-800">{t("shop.section")}</h2>
        <p className="text-sm text-slate-600">{t("shop.help")}</p>

        {shopProblem && (
          <p data-testid="shop-problem" className="text-sm text-red-700">{t(shopProblem.key)}</p>
        )}

        <form onSubmit={(e) => { e.preventDefault(); void saveShop(); }} className="space-y-3">
          <div>
            <label className="block text-sm text-slate-600 mb-1" htmlFor="shop-address">
              {t("shop.address")}
            </label>
            <input
              id="shop-address" data-testid="shop-address" value={shop.address ?? ""}
              onChange={(e) => { setShopSaved(false); setShop({ ...shop, address: e.target.value }); }}
              className="w-full border border-slate-300 rounded-lg px-3 py-2 min-h-[44px]"
            />
          </div>
          <div>
            <label className="block text-sm text-slate-600 mb-1" htmlFor="shop-phone">
              {t("shop.phone")}
            </label>
            <input
              id="shop-phone" data-testid="shop-phone" value={shop.phone ?? ""} inputMode="tel"
              onChange={(e) => { setShopSaved(false); setShop({ ...shop, phone: e.target.value }); }}
              className="w-full border border-slate-300 rounded-lg px-3 py-2 min-h-[44px]"
            />
          </div>

          {shopSaved && (
            <p data-testid="shop-saved" className="text-sm text-green-700">{t("shop.saved")}</p>
          )}

          <button
            type="submit" data-testid="shop-save" disabled={shopBusy || !shopLoaded}
            className="rounded-lg px-4 py-2 text-sm bg-slate-800 text-white min-h-[44px] disabled:opacity-50"
          >
            {t("shop.save")}
          </button>
        </form>
      </section>

      {/* No heading here: Staff renders its own <h2>{t("staff.title")}</h2>, and it has to
          -- the router mounts that screen standalone too. A wrapper heading saying the
          same word stacked two identical "Staff" headings on this page. */}
      <section className="space-y-3">
        <Staff />
      </section>

      {/* Last on the page and visually separated on purpose: everything above this line is
          reversible, and nothing below it is. */}
      <section className="bg-white border border-red-300 rounded-xl p-4 space-y-3 max-w-md">
        <h2 className="font-semibold text-red-800">{t("danger.title")}</h2>
        <p className="text-sm text-slate-600">{t("danger.body")}</p>
        <p className="text-sm text-slate-600">{t("danger.keeps")}</p>

        {wiped && (
          <p data-testid="danger-done" className="text-sm text-green-700">
            {t("danger.done", {
              bills: wiped.bills, customers: wiped.customers, points: wiped.points_rows,
            })}
          </p>
        )}
        {wipeProblem && (
          <p data-testid="danger-problem" className="text-sm text-red-700">{t(wipeProblem.key)}</p>
        )}

        {!wiping ? (
          <button
            data-testid="danger-open"
            onClick={() => { setWiping(true); setWiped(null); setWipeProblem(null); }}
            className="border border-red-300 text-red-700 rounded-lg px-4 py-2 text-sm bg-white min-h-[44px]"
          >
            {t("danger.clear")}
          </button>
        ) : (
          <div className="space-y-2 border-t border-slate-200 pt-3">
            {/* Typing the shop's name, not a bare confirm button. The remove-a-person
                dialog can be a single click because it undoes one row a person can be
                re-added to; this deletes every bill, customer and point the shop has, and
                a click made by accident is indistinguishable from one made on purpose. */}
            <label className="block text-sm text-slate-600" htmlFor="danger-confirm">
              {t("danger.typeName", { name: vendorName })}
              <input
                id="danger-confirm" data-testid="danger-confirm"
                value={typedName} autoComplete="off"
                onChange={(e) => setTypedName(e.target.value)}
                className="mt-1 w-full border border-slate-300 rounded-lg px-3 py-2 min-h-[44px]"
              />
            </label>
            <div className="flex gap-2">
              <button
                data-testid="danger-go" disabled={wipeBusy || typedName.trim() !== vendorName}
                onClick={() => void clearData()}
                className="rounded-lg px-4 py-2 text-sm bg-red-700 text-white min-h-[44px] disabled:opacity-50"
              >
                {t("danger.confirm")}
              </button>
              <button
                type="button" onClick={() => { setWiping(false); setTypedName(""); }}
                className="border border-slate-300 rounded-lg px-4 py-2 text-sm bg-white min-h-[44px]"
              >
                {t("staff.cancel")}
              </button>
            </div>
          </div>
        )}
      </section>
    </div>
  );
}
