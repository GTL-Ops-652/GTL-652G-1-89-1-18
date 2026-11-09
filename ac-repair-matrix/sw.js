/* AC Repair Matrix — service worker.
   Keeps a copy of the app so it opens with no signal (attics, rooftops).
   Everything is network first (4 s), then the saved copy, so an online phone always gets the
   current build and an offline one gets the last build it saw, never a mix of the two.
   Change BUILD on every deploy. */
const BUILD = '2026-10-10.3';
const CACHE = 'acrm-' + BUILD;
const SHELL = ['./', './index.html', './manifest.webmanifest',
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
  e.respondWith(networkFirst(req));
});

async function networkFirst(req) {
  const cache = await caches.open(CACHE);
  try {
    const res = await Promise.race([fetch(req), new Promise((_, no) => setTimeout(() => no(new Error('timeout')), 4000))]);
    if (res.ok) cache.put(req.mode === 'navigate' ? './index.html' : req, res.clone());
    return res;
  } catch {
    const hit = req.mode === 'navigate' ? await cache.match('./index.html') : await cache.match(req, { ignoreSearch: true });
    return hit || Response.error();
  }
}
