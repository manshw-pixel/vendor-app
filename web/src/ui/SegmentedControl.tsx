import { useRef, type KeyboardEvent, type ReactNode } from "react";

export function SegmentedControl<T extends string>({ label, options, value, onChange }: {
  label: string; options: { value: T; label: ReactNode }[]; value: T; onChange: (v: T) => void;
}) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  // If value matches no option, the first option stays reachable by Tab.
  const tabStop = Math.max(0, options.findIndex((o) => o.value === value));
  function onKeyDown(e: KeyboardEvent, i: number) {
    const n = options.length;
    const next = { ArrowRight: i + 1, ArrowDown: i + 1, ArrowLeft: i - 1, ArrowUp: i - 1, Home: 0, End: n - 1 }[e.key];
    if (next === undefined) return;
    e.preventDefault();
    const j = (next + n) % n;
    onChange(options[j]!.value);
    refs.current[j]?.focus();
  }
  return (
    <div role="radiogroup" aria-label={label} className="flex rounded-lg border border-slate-300 bg-surface p-0.5 gap-0.5">
      {options.map((o, i) => {
        const on = o.value === value;
        return (
          <button key={o.value} ref={(el) => { refs.current[i] = el; }} type="button" role="radio"
                  aria-checked={on} tabIndex={i === tabStop ? 0 : -1}
                  onClick={() => onChange(o.value)} onKeyDown={(e) => onKeyDown(e, i)}
                  className={`flex-1 min-h-[44px] px-2 rounded-md text-sm ${
                    on ? "bg-brand text-white font-semibold" : "text-ink active:bg-slate-100"}`}>
            {o.label}
          </button>
        );
      })}
    </div>
  );
}
