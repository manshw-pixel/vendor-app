import type { ReactNode } from "react";

export function Card({ title, className = "", children }:
  { title?: ReactNode; className?: string; children: ReactNode }) {
  return (
    <section className={`border border-slate-200 rounded-xl bg-surface ${className}`}>
      {title && <h2 className="font-semibold text-ink px-3 pt-3">{title}</h2>}
      {children}
    </section>
  );
}
