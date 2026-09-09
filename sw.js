// Network-first for the app shell so players always get the latest client
// when online (prevents online version drift between devices); cache is just
// the offline fallback for single-player.
const VER = 'v47';                       // keep in step with APP_VERSION in index.html
const CACHE = 'bnb-' + VER;
// game-core.js carries the version in its URL: a stale cached copy can then
// never be served to a fresh index.html, which is how a v36 page ended up
// running a v35 sim.
const ASSETS = ['./', './index.html', './game-core.js?' + VER, './manifest.webmanifest', './icon.svg'];

self.addEventListener('install', e => {
  // cache:'reload' on every asset too: GitHub Pages' max-age=600 could otherwise
  // pair a fresh index.html with a stale game-core.js, and the sim would quietly
  // play by the old rules.
  const fresh = ASSETS.map(u => new Request(u, { cache: 'reload' }));
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(fresh)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});
self.addEventListener('fetch', e => {
  const req = e.request;
  const url = new URL(req.url);
  const isShell = req.mode === 'navigate' || url.pathname.endsWith('/') || url.pathname.endsWith('/index.html');
  if (isShell) {
    // Network-first, bypassing the browser HTTP cache (GitHub Pages sends
    // max-age=600, which would otherwise serve a stale index.html for 10 min
    // and cause version drift). Fall back to the SW cache when offline.
    const fresh = new Request(url.origin + url.pathname, { cache: 'reload' });
    e.respondWith(
      fetch(fresh).then(r => { const c = r.clone(); caches.open(CACHE).then(ca => ca.put('./index.html', c)); return r; })
        .catch(() => caches.match(req).then(r => r || caches.match('./index.html')))
    );
  } else {
    e.respondWith(caches.match(req).then(r => r || fetch(req)));
  }
});
