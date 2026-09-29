import type { HTMLAttributes, ReactNode } from "react";

/** Something is on its way. The label is visible text, not just an aria-label: on a slow
 *  connection the words tell staff it is working, where a bare ring looks frozen. */
export function Spinner({ label, className = "", ...rest }:
  { label: ReactNode } & HTMLAttributes<HTMLDivElement>) {
  return (
    <div role="status" className={`flex items-center gap-2 text-sm text-muted py-2 ${className}`} {...rest}>
      <span aria-hidden="true"
            className="inline-block w-4 h-4 rounded-full border-2 border-slate-300 border-t-brand animate-spin" />
      {label}
    </div>
  );
}
