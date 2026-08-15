/**
 * NeedMusic web — service worker.
 *
 * Makes the app installable (PWA) and able to OPEN offline from a secure
 * origin (HTTPS, e.g. GitHub Pages). Downloaded tracks live in IndexedDB on
 * the same origin, so an installed app opens offline and plays them.
 *
 * Rules:
 *  - NEVER touch /api/, /audio/, /online/ requests (LAN server data stays
 *    network-only — no stale tokens, no cached audio).
 *  - App shell (navigation) is network-first so updates arrive, with the
 *    cached copy as the offline fallback.
 *  - Hashed /assets/ and /icons/ are cache-first (immutable builds).
 */
const CACHE = "needmusic-shell-v1";
const SHELL = ["./", "./index.html", "./manifest.json", "./icons/icon-128.png", "./icons/icon-256.png"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);

  // LAN data endpoints: always go to the network (never cache).
  if (
    url.pathname.startsWith("/api/") ||
    url.pathname.startsWith("/audio/") ||
    url.pathname.startsWith("/online/")
  ) {
    return;
  }

  // App shell (page navigation): network-first, cache fallback for offline.
  if (event.request.mode === "navigate") {
    event.respondWith(
      fetch(event.request)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((cache) => cache.put(event.request, copy));
          return res;
        })
        .catch(() =>
          caches.match(event.request).then((hit) => hit || caches.match("./index.html"))
        )
    );
    return;
  }

  // Static assets: cache-first, then network (and cache the response).
  event.respondWith(
    caches.match(event.request).then((hit) => {
      if (hit) return hit;
      return fetch(event.request).then((res) => {
        if (res.ok && (url.pathname.startsWith("/assets/") || url.pathname.startsWith("/icons/"))) {
          const copy = res.clone();
          caches.open(CACHE).then((cache) => cache.put(event.request, copy));
        }
        return res;
      });
    })
  );
});
