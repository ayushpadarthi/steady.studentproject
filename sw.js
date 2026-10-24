// Offline support. Every page and file of the app is stored on the device the first time any page opens, so the
// app keeps working with bad or no Wi-Fi (for example at the fair). Network first, so updates arrive as soon as
// there is a connection; the stored copy is used when the network fails or takes longer than 3 s.
// VERSION must match the ?v=N used by the pages (bump both when publishing).
const VERSION = 16;
const CACHE = `steady-v${VERSION}`;
const q = `?v=${VERSION}`;
const FILES = [
  './', 'index.html', 'draw.html', 'trace.html', 'checkin.html', 'lab.html', 'manifest.webmanifest',
  'icons/icon-192.png', 'icons/icon-512.png', 'icons/apple-touch-icon.png',
  ...['css/draw.css', 'css/pages.css', 'css/style.css'].map((f) => f + q),
  ...['calib', 'checkin', 'compare', 'draw', 'filters', 'main', 'pad', 'pagekit', 'penmeter', 'replay', 'serial', 'settle',
    'shakestyle', 'store', 'study', 'tasks', 'trace', 'tremor'].map((f) => `js/${f}.js${q}`),
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(FILES)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k.startsWith('steady-') && k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const req = e.request, url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== self.location.origin) return;
  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const net = fetch(req).then((res) => { if (res.ok && res.type === 'basic') cache.put(req, res.clone()); return res; });
    const timeout = new Promise((resolve) => setTimeout(resolve, 3000));
    try {
      const res = await Promise.race([net, timeout]);
      if (res) return res;
    } catch {}
    const hit = await cache.match(req, { ignoreSearch: req.mode === 'navigate' });
    return hit || net;
  })());
});
