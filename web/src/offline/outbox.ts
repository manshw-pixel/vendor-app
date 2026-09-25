import type { Draft } from "../billing";
import type { PaymentMode } from "../payments";
import { recordOfflineBill } from "../data";
import { getKV } from "./kv";

export type OfflineBill = {
  clientId: string; vendorId: string; seq: number; occurredAt: string;
  customerId: string; customerLabel: string; lines: Draft[]; mode: PaymentMode;
  redeemPoints: number; collectDue: number; total: number;
  state: "waiting" | "attention"; error?: string;
};
type Reply = { data: unknown; error: { message?: string; code?: string } | null };
export type FlushResult = { sent: number; attention: number; stoppedOffline: boolean };

const billKey = (v: string, id: string) => `outbox:${v}:${id}`;
const seqKey = (v: string) => `outbox-seq:${v}`;

export function isNetworkError(e: { message?: string; code?: string } | null): boolean {
  return !!e && !e.code && /fetch|network|load failed/i.test(e.message ?? "");
}

// Serialises enqueue() calls so two quick enqueues (e.g. fired concurrently) can't both
// read the same seq before either writes it back.
let enqueueChain: Promise<unknown> = Promise.resolve();

export function enqueue(
  b: Omit<OfflineBill, "seq" | "state" | "clientId" | "occurredAt">,
): Promise<OfflineBill> {
  const next = enqueueChain.then(async () => {
    const kv = getKV();
    const seq = ((await kv.get<number>(seqKey(b.vendorId))) ?? 0) + 1;
    await kv.set(seqKey(b.vendorId), seq);
    const bill: OfflineBill = { ...b, seq, state: "waiting", clientId: crypto.randomUUID(),
                                occurredAt: new Date().toISOString() };
    await kv.set(billKey(b.vendorId, bill.clientId), bill);
    return bill;
  });
  // Keep the chain alive even if this call rejects, so a later enqueue isn't blocked forever.
  enqueueChain = next.catch(() => {});
  return next;
}

export async function listOutbox(vendorId: string): Promise<OfflineBill[]> {
  const kv = getKV();
  const keys = await kv.keys(`outbox:${vendorId}:`);
  const bills = await Promise.all(keys.map((k) => kv.get<OfflineBill>(k)));
  return (bills.filter(Boolean) as OfflineBill[]).sort((a, b) => a.seq - b.seq);
}

export async function retry(vendorId: string, clientId: string) {
  const kv = getKV();
  const b = await kv.get<OfflineBill>(billKey(vendorId, clientId));
  if (b) await kv.set(billKey(vendorId, clientId), { ...b, state: "waiting", error: undefined });
}

/** One at a time and in order, so tokens come out in the order the sales happened. A
 *  network failure stops the run -- the next bill would fail the same way. A rejection is
 *  this bill's alone, so it is set aside and the rest still go. */
export async function flush(
  vendorId: string, send: (b: OfflineBill) => Promise<Reply> = recordOfflineBill,
): Promise<FlushResult> {
  const kv = getKV();
  const r: FlushResult = { sent: 0, attention: 0, stoppedOffline: false };
  for (const b of await listOutbox(vendorId)) {
    if (b.state !== "waiting") continue;
    let reply: Reply;
    try { reply = await send(b); }
    catch (e) { reply = { data: null, error: { message: String((e as Error)?.message ?? e) } }; }
    // A sender that resolves with nothing (e.g. a test double with no return value) is
    // not a success -- treat it the same as any other refusal, not a crash.
    if (!reply) reply = { data: null, error: { message: "no reply" } };
    if (!reply.error) { await kv.del(billKey(vendorId, b.clientId)); r.sent++; continue; }
    // A resend of the same clientId racing another can come back as Postgres 23505
    // (unique_violation) instead of the RPC's own idempotent success; pause the run like a
    // network error so the bill stays waiting and the next attempt hits the idempotent path.
    const pause = isNetworkError(reply.error) || reply.error.code === "23505";
    if (pause) { r.stoppedOffline = true; break; }
    await kv.set(billKey(vendorId, b.clientId), { ...b, state: "attention", error: reply.error.message ?? "" });
    r.attention++;
  }
  return r;
}
