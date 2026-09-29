import type { ReactNode } from "react";

export function EmptyState({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return (
    <div className="text-center py-8 px-4 space-y-3">
      <p className="text-sm text-muted">{children}</p>
      {action}
    </div>
  );
}
