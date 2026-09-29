import type { ReactNode } from "react";

type Tone = "error" | "warn" | "info" | "success";

const TONE: Record<Tone, string> = {
  error: "border-red-200 bg-red-50 text-red-700",
  warn: "border-amber-200 bg-amber-50 text-amber-800",
  info: "border-slate-200 bg-slate-50 text-slate-700",
  success: "border-emerald-200 bg-emerald-50 text-emerald-800",
};

/** error is announced immediately (role=alert); the rest politely (role=status), unless
 *  `role` overrides that default -- e.g. a warn-toned notice that still needs assertive
 *  announcement, without nesting a second live region to get it. */
export function Banner({ tone, role, action, className = "", children }:
  { tone: Tone; role?: "alert" | "status"; action?: ReactNode; className?: string; children: ReactNode }) {
  return (
    <div role={role ?? (tone === "error" ? "alert" : "status")}
         className={`border rounded-xl p-3 text-sm flex items-start justify-between gap-3 ${TONE[tone]} ${className}`}>
      <div className="min-w-0">{children}</div>
      {action}
    </div>
  );
}
