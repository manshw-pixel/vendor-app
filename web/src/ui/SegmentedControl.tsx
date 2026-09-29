import type { ReactNode } from "react";

export function SegmentedControl<T extends string>({ label, options, value, onChange }: {
  label: string; options: { value: T; label: ReactNode }[]; value: T; onChange: (v: T) => void;
}) {
  return (
    <div role="radiogroup" aria-label={label} className="flex rounded-lg border border-slate-300 bg-surface p-0.5 gap-0.5">
      {options.map((o) => {
        const on = o.value === value;
        return (
          <button key={o.value} type="button" role="radio" aria-checked={on} onClick={() => onChange(o.value)}
                  className={`flex-1 min-h-[44px] px-2 rounded-md text-sm ${
                    on ? "bg-brand text-white font-semibold" : "text-ink active:bg-slate-100"}`}>
            {o.label}
          </button>
        );
      })}
    </div>
  );
}
