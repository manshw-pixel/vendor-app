import { useEffect, useRef, type KeyboardEvent, type ReactNode, type RefObject } from "react";

const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * A modal: a bottom sheet on phones, centred from sm: up.
 *
 * Deliberately a div with role="dialog", not a native <dialog>: jsdom's showModal support
 * is partial, and the existing tests find dialogs by role. Focus goes to the first control
 * on open, Tab is trapped inside, Escape calls onClose, and focus returns to whatever had
 * it before -- the button that opened it, in practice. Tapping the dimmed backdrop
 * (not the panel) also calls onClose, so a sheet can always be dismissed.
 *
 * A caller that must not be dismissed right now (a write in flight) passes an onClose that
 * does nothing.
 */
export function Dialog({ label, onClose, className = "", children, initialFocusRef }:
  { label: string; onClose: () => void; className?: string; children: ReactNode;
    initialFocusRef?: RefObject<HTMLElement | null> }) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    (initialFocusRef?.current ?? ref.current?.querySelector<HTMLElement>(FOCUSABLE))?.focus();
    return () => previous?.focus?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
    const first = nodes[0]!, last = nodes[nodes.length - 1]!;
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  }

  return (
    <div role="dialog" aria-modal="true" aria-label={label} onKeyDown={onKeyDown}
         onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
         className="fixed inset-0 z-50 bg-black/40 flex items-end sm:items-center justify-center p-4">
      <div ref={ref} className={`bg-surface rounded-xl p-4 w-full max-w-sm space-y-3 ${className}`}>
        {children}
      </div>
    </div>
  );
}
