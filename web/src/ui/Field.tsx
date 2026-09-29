import { useId, type ReactNode } from "react";

/** A label, a control, and the text that explains it -- wired so a screen reader reads the
 *  hint and the error with the control. The control is a render prop so any input, select
 *  or custom widget can take the ids. */
export function Field({ label, hint, error, children }: {
  label: ReactNode; hint?: ReactNode; error?: ReactNode;
  children: (ids: { id: string; describedBy: string | undefined }) => ReactNode;
}) {
  const id = useId();
  const hintId = `${id}-hint`, errorId = `${id}-error`;
  const describedBy = [hint ? hintId : null, error ? errorId : null].filter(Boolean).join(" ") || undefined;
  return (
    <div className="space-y-1">
      <label htmlFor={id} className="block text-sm text-slate-600">{label}</label>
      {children({ id, describedBy })}
      {hint && <p id={hintId} className="text-xs text-muted">{hint}</p>}
      {error && <p id={errorId} className="text-sm text-danger">{error}</p>}
    </div>
  );
}
