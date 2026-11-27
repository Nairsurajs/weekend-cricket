// Offline support: keeps the app working at grounds with no signal.
const CACHE = 'cricket-scorer-v6';
const CORE = ['./', './index.html', './manifest.webmanifest',
  './icons/icon-192.png', './icons/icon-512.png', './icons/maskable-512.png',
  './icons/apple-touch-icon.png', './icons/favicon-48.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(CORE)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // Live data from the API always comes from the network, never the cache.
  if (url.origin === location.origin && url.pathname.startsWith('/api/')) return;

  // The app page: try the network for updates, fall back to the saved copy offline.
  if (req.mode === 'navigate') {
    e.respondWith(fetch(req).then(res => {
      const copy = res.clone();
      caches.open(CACHE).then(c => c.put('./index.html', copy));
      return res;
    }).catch(() => caches.match('./index.html')));
    return;
  }

  // Fonts and app files: serve the saved copy straight away, refresh it in the background.
  if (url.origin === location.origin || /fonts\.(googleapis|gstatic)\.com$/.test(url.hostname)) {
    e.respondWith(caches.open(CACHE).then(async c => {
      const hit = await c.match(req);
      const net = fetch(req).then(res => {
        if (res && (res.ok || res.type === 'opaque')) c.put(req, res.clone());
        return res;
      }).catch(() => hit);
      return hit || net;
    }));
  }
});
