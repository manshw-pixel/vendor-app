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
import { Button } from "../ui/Button";
import { Banner } from "../ui/Banner";
import { Card } from "../ui/Card";
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
      <Card className="p-4 space-y-3 max-w-md" title={t("settings.loyaltySection")}>
        <p data-testid="settings-future-only" className="text-sm text-slate-600">
          {t("settings.futureOnly")}
        </p>

        {problem && (
          <Banner tone="error"><span data-testid="settings-problem">{t(problem.key)}</span></Banner>
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
              <Banner tone="success"><span data-testid="settings-saved">{t("settings.saved")}</span></Banner>
            )}

            <Button type="submit" data-testid="settings-save" disabled={busy}>
              {t("settings.save")}
            </Button>
          </form>
        )}
      </Card>

      <Card className="p-4 space-y-3 max-w-md" title={t("shop.section")}>
        <p className="text-sm text-slate-600">{t("shop.help")}</p>

        {shopProblem && (
          <Banner tone="error"><span data-testid="shop-problem">{t(shopProblem.key)}</span></Banner>
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
            <Banner tone="success"><span data-testid="shop-saved">{t("shop.saved")}</span></Banner>
          )}

          <Button type="submit" data-testid="shop-save" disabled={shopBusy || !shopLoaded}>
            {t("shop.save")}
          </Button>
        </form>
      </Card>

      {/* No heading here: Staff renders its own <h2>{t("staff.title")}</h2>, and it has to
          -- the router mounts that screen standalone too. A wrapper heading saying the
          same word stacked two identical "Staff" headings on this page. */}
      <section className="space-y-3">
        <Staff />
      </section>

      {/* Last on the page and visually separated on purpose: everything above this line is
          reversible, and nothing below it is. */}
      <Card className="border-red-300 p-4 space-y-3 max-w-md" title={t("danger.title")}>
        <p className="text-sm text-slate-600">{t("danger.body")}</p>
        <p className="text-sm text-slate-600">{t("danger.keeps")}</p>

        {wiped && (
          <Banner tone="success">
            <span data-testid="danger-done">
              {t("danger.done", {
                bills: wiped.bills, customers: wiped.customers, points: wiped.points_rows,
              })}
            </span>
          </Banner>
        )}
        {wipeProblem && (
          <Banner tone="error"><span data-testid="danger-problem">{t(wipeProblem.key)}</span></Banner>
        )}

        {!wiping ? (
          <Button
            variant="secondary"
            data-testid="danger-open"
            onClick={() => { setWiping(true); setWiped(null); setWipeProblem(null); }}
            className="border-red-300 text-red-700"
          >
            {t("danger.clear")}
          </Button>
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
              <Button
                variant="danger"
                data-testid="danger-go" disabled={wipeBusy || typedName.trim() !== vendorName}
                onClick={() => void clearData()}
              >
                {t("danger.confirm")}
              </Button>
              <Button
                type="button" variant="secondary" onClick={() => { setWiping(false); setTypedName(""); }}
              >
                {t("staff.cancel")}
              </Button>
            </div>
          </div>
        )}
      </Card>
    </div>
  );
}
