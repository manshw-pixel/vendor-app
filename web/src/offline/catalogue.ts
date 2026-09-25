import { listCustomers, listItems, offlineBalances, type Item } from "../data";
import type { Customer } from "../customers";
import { getKV } from "./kv";

export type Balance = { points: number; due: number };
export type Snapshot = {
  vendorId: string; cachedAt: number; items: Item[]; customers: Customer[];
  balances: Record<string, Balance>;
};

const key = (vendorId: string) => `snapshot:${vendorId}`;
const DAY = 24 * 3600e3;

export const saveSnapshot = (s: Snapshot) => getKV().set(key(s.vendorId), s);
export const loadSnapshot = (vendorId: string) => getKV().get<Snapshot>(key(vendorId));
export const isStale = (s: Snapshot, now = Date.now()) => now - s.cachedAt > DAY;

/** All three reads must succeed, or nothing is written: a half-fresh snapshot would show
 *  today's prices against last week's balances with no way to tell. */
export async function refreshSnapshot(vendorId: string): Promise<Snapshot | null> {
  const [i, c, b] = await Promise.all([listItems(), listCustomers(), offlineBalances()]);
  if (i.error || c.error || b.error || !i.data || !c.data || !b.data) return null;
  const balances: Record<string, Balance> = {};
  for (const r of b.data as { customer_id: string; points: number; due: number | string }[]) {
    balances[r.customer_id] = { points: Number(r.points), due: Number(r.due) };
  }
  const s: Snapshot = { vendorId, cachedAt: Date.now(), items: i.data as Item[],
                        customers: c.data as Customer[], balances };
  await saveSnapshot(s);
  return s;
}
