/** Holds the service worker registration once a new worker has installed alongside the
 *  currently active one. main.tsx can set this before Shell has mounted -- a plain window
 *  event fired at that point would be lost, so UpdateBanner reads this holder on mount
 *  (via get) as well as subscribing for later updates (via onUpdateReady). */
let pending: ServiceWorkerRegistration | null = null;
const listeners = new Set<(reg: ServiceWorkerRegistration) => void>();

export function setUpdateReady(reg: ServiceWorkerRegistration): void {
  pending = reg;
  for (const l of listeners) l(reg);
}

export function getUpdateReady(): ServiceWorkerRegistration | null {
  return pending;
}

export function onUpdateReady(cb: (reg: ServiceWorkerRegistration) => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}
