// The app shell only. Data never passes through here: Supabase is another origin, and the
// device's own cache of prices and balances lives in IndexedDB (src/offline).
//
// Navigations are network-first with a cached index.html fallback, not cache-first: GitHub
// Pages serves fresh (no-cache) HTML, and a cached page could point at hashed assets a
// newer deploy removed. Network-first with the fallback gives the same offline result
// without that failure mode.
const SCOPE = self.registration.scope;

async function currentVersion() {
  const hit = await (await caches.open("shell-meta")).match("version");
  return hit ? hit.text() : null;
}

self.addEventListener("install", (e) => {
  e.waitUntil((async () => {
    const { version, files } = await (await fetch(SCOPE + "precache.json", { cache: "no-store" })).json();
    await (await caches.open("shell-" + version)).addAll(files);
    // Recorded for activate: a worker can be stopped between the two events, so nothing
    // may be carried across them in memory.
    await (await caches.open("shell-meta")).put("version", new Response(version));
  })());
});

self.addEventListener("activate", (e) => {
  e.waitUntil((async () => {
    const mine = "shell-" + (await currentVersion());
    const old = (await caches.keys()).filter((k) => k.startsWith("shell-") && k !== "shell-meta" && k !== mine);
    await Promise.all(old.map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener("message", (e) => { if (e.data === "skip-waiting") self.skipWaiting(); });

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET" || !req.url.startsWith(SCOPE)) return;
  if (req.mode === "navigate") {
    e.respondWith(fetch(req).catch(async () => (await caches.match(SCOPE + "index.html")) ?? Response.error()));
    return;
  }
  if (new URL(req.url).pathname.includes("/assets/")) {
    e.respondWith(caches.match(req).then((hit) => hit ?? fetch(req)));
  }
});
