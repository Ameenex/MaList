// MaList service worker — caches the app shell so it opens offline.
// Live data (prayer times, weather) is always fetched from the network and never cached here.
// Bump CACHE whenever the shell file list changes so old caches are cleared.
const CACHE = 'malist-shell-v2';
const SHELL = [
  './', './index.html', './css/tailwind.css', './css/app.css', './js/app.js',
  './manifest.webmanifest', './data/builtin.json', './data/advisories.json',
  './icons/icon-192.png', './icons/icon-512.png', './icons/icon-512-maskable.png',
  './icons/apple-touch-icon.png', './icons/favicon.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // Same-origin files: network first (so updates show up), fall back to cache offline.
  // The cache key ignores the query string, so data/data.json?t=… still has an offline copy.
  if (url.origin === self.location.origin) {
    const key = url.origin + url.pathname;
    event.respondWith(
      fetch(req)
        .then((res) => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(key, copy));
          }
          return res;
        })
        .catch(() => caches.match(key).then((hit) => hit || (req.mode === 'navigate' ? caches.match('./index.html') : Response.error())))
    );
    return;
  }

  // Google Fonts: cache after first use so the typography survives offline.
  if (url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com') {
    event.respondWith(
      caches.match(req).then((hit) => hit || fetch(req).then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(req, copy));
        return res;
      }))
    );
  }
  // Everything else (Aladhan, Open-Meteo, etc.) goes straight to the network.
});
