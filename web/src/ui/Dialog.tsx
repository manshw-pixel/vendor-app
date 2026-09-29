import { useEffect, useRef, type KeyboardEvent, type ReactNode } from "react";

const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * A modal: a bottom sheet on phones, centred from sm: up.
 *
 * Deliberately a div with role="dialog", not a native <dialog>: jsdom's showModal support
 * is partial, and the existing tests find dialogs by role. Focus goes to the first control
 * on open, Tab is trapped inside, Escape calls onClose, and focus returns to whatever had
 * it before -- the button that opened it, in practice.
 *
 * A caller that must not be dismissed right now (a write in flight) passes an onClose that
 * does nothing.
 */
export function Dialog({ label, onClose, className = "", children }:
  { label: string; onClose: () => void; className?: string; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    ref.current?.querySelector<HTMLElement>(FOCUSABLE)?.focus();
    return () => previous?.focus?.();
  }, []);

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    if (e.key === "Escape") {
      e.stopPropagation();
      onClose();
      return;
    }
    if (e.key !== "Tab" || !ref.current) return;
    const nodes = [...ref.current.querySelectorAll<HTMLElement>(FOCUSABLE)];
    if (nodes.length === 0) return;
    const first = nodes[0], last = nodes[nodes.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  }

  return (
    <div role="dialog" aria-modal="true" aria-label={label} onKeyDown={onKeyDown}
         className="fixed inset-0 z-50 bg-black/40 flex items-end sm:items-center justify-center p-4">
      <div ref={ref} className={`bg-surface rounded-xl p-4 w-full max-w-sm space-y-3 ${className}`}>
        {children}
      </div>
    </div>
  );
}
