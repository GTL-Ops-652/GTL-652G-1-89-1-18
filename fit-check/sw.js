/* Fit Check — service worker · DEPLOY: fit-check/sw.js · build v2.21-2026-09-09-2113b7bc
   Caches the encrypted app shell so Fit Check opens with no signal (attics, rooftops).
   Navigation: network first (4 s), then the saved copy.  Assets: saved copy first, refreshed in the background.
   A new build changes this file, which makes the browser install the new worker; the app shows "Update now". */
const BUILD = 'v2.21-2026-09-09-2113b7bc';
const CACHE = 'fitcheck-' + BUILD;
const SHELL = ['./index.html', './manifest.webmanifest', './icon-192.png', './icon-512.png', './icon-512-maskable.png', './apple-touch-icon.png'];
const INDEX = new URL('./index.html', self.location.href).href;

self.addEventListener('install', e => {
  e.waitUntil((async () => {
    const c = await caches.open(CACHE);
    // the app itself must land in the cache or the install fails and is retried on the next visit
    const idx = await fetch('./index.html', { cache: 'no-cache', credentials: 'same-origin' });
    if (!idx.ok) throw new Error('index.html ' + idx.status);
    await c.put(INDEX, idx);
    // icons + manifest are best-effort
    await Promise.all(SHELL.slice(1).map(async u => {
      try { const r = await fetch(u, { cache: 'no-cache', credentials: 'same-origin' }); if (r.ok) await c.put(new URL(u, self.location.href).href, r); } catch (_) {}
    }));
  })());
});

self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k.startsWith('fitcheck-') && k !== CACHE) await caches.delete(k);
    await self.clients.claim();
  })());
});

self.addEventListener('message', e => { if (e.data && e.data.type === 'SKIP_WAITING') self.skipWaiting(); });

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (req.mode === 'navigate') { e.respondWith(navigate(req)); return; }
  if (url.pathname.startsWith(new URL('./', self.location.href).pathname)) e.respondWith(asset(req));
});

function withTimeout(p, ms) {
  return new Promise((res, rej) => { const t = setTimeout(() => rej(new Error('timeout')), ms); p.then(v => { clearTimeout(t); res(v); }, err => { clearTimeout(t); rej(err); }); });
}

async function navigate(req) {
  const c = await caches.open(CACHE);
  try {
    const r = await withTimeout(fetch(req.url, { cache: 'no-cache', credentials: 'same-origin' }), 4000);
    if (r && r.ok) { c.put(INDEX, r.clone()); return r; }
    throw new Error('status ' + (r && r.status));
  } catch (_) {
    return (await c.match(INDEX)) || new Response('<h2 style="font-family:sans-serif;padding:24px">Fit Check is not saved on this device yet — open it once while online.</h2>', { status: 503, headers: { 'Content-Type': 'text/html' } });
  }
}

async function asset(req) {
  const c = await caches.open(CACHE);
  const hit = await c.match(req, { ignoreSearch: true });
  const net = fetch(req).then(r => { if (r && r.ok) c.put(req, r.clone()); return r; }).catch(() => null);
  return hit || (await net) || Response.error();
}
