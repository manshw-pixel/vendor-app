import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import { DAY_CLOSES_CHANGED, loadUnclosedDays } from "../dayClose";
import { formatBusinessDate } from "../closeRules";
import type { Role } from "../config";

const EVERY_MS = 5 * 60 * 1000;

/**
 * "22 Sept is not closed." A nudge, never a block: billing works regardless (the owner
 * chose a warning over stopping the first sale of the morning). Admin and biller only --
 * a recorder cannot close a day, so telling them is noise.
 *
 * Polls like useLowStock, and also re-reads the moment the close screen closes or reopens
 * a day, so the banner never lingers over the day just closed.
 */
export function UnclosedBanner({ role }: { role: Role }) {
  const { t, i18n } = useTranslation();
  const enabled = role === "admin" || role === "biller";
  const [days, setDays] = useState<string[]>([]);

  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    const read = async () => {
      const { data, error } = await loadUnclosedDays();
      // A failed read keeps what was shown rather than flashing the banner away.
      if (alive && !error && data) setDays(data);
    };
    void read();
    const timer = setInterval(() => void read(), EVERY_MS);
    window.addEventListener("focus", read);
    window.addEventListener(DAY_CLOSES_CHANGED, read);
    return () => {
      alive = false;
      clearInterval(timer);
      window.removeEventListener("focus", read);
      window.removeEventListener(DAY_CLOSES_CHANGED, read);
    };
  }, [enabled]);

  if (!enabled || days.length === 0) return null;
  // Newest first from the server; name the OLDEST, which is the one most overdue.
  const date = formatBusinessDate(days[days.length - 1] as string, i18n.language);
  return (
    <div data-testid="unclosed-banner"
         className="bg-amber-50 text-amber-900 text-sm px-4 py-2 flex items-center justify-center gap-3">
      <span>
        {days.length === 1 ? t("close.banner", { date }) : t("close.bannerMore", { date, n: days.length - 1 })}
      </span>
      <Link to="/close" className="underline font-semibold">{t("close.bannerAction")}</Link>
    </div>
  );
}
