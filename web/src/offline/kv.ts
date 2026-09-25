/** The device's own storage for offline work. IndexedDB in the browser; a Map in tests
 *  and wherever IndexedDB is missing (jsdom), so nothing here needs a polyfill. */
export interface KV {
  get<T>(key: string): Promise<T | undefined>;
  set(key: string, value: unknown): Promise<void>;
  del(key: string): Promise<void>;
  keys(prefix: string): Promise<string[]>;
}

export function memoryKV(): KV {
  const m = new Map<string, unknown>();
  return {
    async get<T>(k: string) { return structuredClone(m.get(k)) as T | undefined; },
    async set(k, v) { m.set(k, structuredClone(v)); },
    async del(k) { m.delete(k); },
    async keys(p) { return [...m.keys()].filter((k) => k.startsWith(p)); },
  };
}

const STORE = "kv";

export function idbKV(name = "vendor-app-offline"): KV {
  let db: Promise<IDBDatabase> | null = null;
  const open = () => (db ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(name, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  }));
  const run = async <T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest): Promise<T> => {
    const d = await open();
    return new Promise((resolve, reject) => {
      const req = fn(d.transaction(STORE, mode).objectStore(STORE));
      req.onsuccess = () => resolve(req.result as T);
      req.onerror = () => reject(req.error);
    });
  };
  return {
    get: <T,>(k: string) => run<T | undefined>("readonly", (s) => s.get(k)),
    set: async (k, v) => { await run("readwrite", (s) => s.put(v, k)); },
    del: async (k) => { await run("readwrite", (s) => s.delete(k)); },
    keys: async (p) =>
      (await run<IDBValidKey[]>("readonly", (s) => s.getAllKeys(IDBKeyRange.bound(p, p + "￿"))))
        .map(String),
  };
}

let current: KV = typeof indexedDB === "undefined" ? memoryKV() : idbKV();
export const getKV = (): KV => current;
/** Tests only. */
export const setKV = (k: KV): void => { current = k; };
