/* ============================================================
   Service worker — offline cache for the app shell.
   Strategy: cache-first for shell assets, network fallback.
   User content (comic pages) lives in IndexedDB, not here.
   ============================================================ */

const CACHE = 'manga-reader-v1';

const SHELL = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './reader.js',
  './vendor/jszip.min.js',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;

  // never intercept blob: URLs (comic pages) or non-GET
  if (req.method !== 'GET' || req.url.startsWith('blob:')) return;

  e.respondWith(
    caches.match(req).then((hit) => {
      if (hit) return hit;
      return fetch(req).then((res) => {
        // cache same-origin successful responses
        if (res.ok && new URL(req.url).origin === location.origin) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy));
        }
        return res;
      }).catch(() => caches.match('./index.html'));
    })
  );
});
