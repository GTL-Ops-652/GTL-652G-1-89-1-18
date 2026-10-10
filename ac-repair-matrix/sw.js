/* AC Repair Matrix — service worker.
   Caches the app so it opens with no signal (attics, rooftops).
   Pages: network first (4 s), then the saved copy. Other files: saved copy first, refreshed in the background.
   Change BUILD on every deploy so phones pick up the new content. */
const BUILD = '2026-10-10.2';
const CACHE = 'acrm-' + BUILD;
const SHELL = ['./', './index.html', './matrix.js', './pt-data.js', './manifest.webmanifest',
  './icon-192.png', './icon-512.png', './icon-512-maskable.png', './apple-touch-icon.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL.map(u => new Request(u, { cache: 'no-cache' })))).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k.startsWith('acrm-') && k !== CACHE) await caches.delete(k);
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;
  e.respondWith(req.mode === 'navigate' ? page(req) : asset(req, e));
});

async function page(req) {
  const cache = await caches.open(CACHE);
  try {
    const res = await Promise.race([fetch(req), new Promise((_, no) => setTimeout(() => no(new Error('timeout')), 4000))]);
    if (res.ok) cache.put('./index.html', res.clone());
    return res;
  } catch {
    return (await cache.match('./index.html')) || Response.error();
  }
}

async function asset(req, e) {
  const cache = await caches.open(CACHE);
  const hit = await cache.match(req, { ignoreSearch: true });
  const fresh = fetch(req).then(res => { if (res.ok) cache.put(req, res.clone()); return res; }).catch(() => null);
  if (hit) { e.waitUntil(fresh); return hit; }
  return (await fresh) || Response.error();
}
