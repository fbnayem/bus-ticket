// Service worker for the counter POS.
//
// The counter already survived a network cut: the offline queue, the quota
// cache and the manifest cache all live in localStorage and keep working. What
// it could not survive was a RELOAD while offline — the browser had nothing to
// serve, and a terminal that a clerk accidentally refreshed at 6am in Arambagh
// became a blank page until the line came back.
//
// This closes that. It is deliberately narrow:
//
//   - It only claims /counter routes. The passenger site is not cached, because
//     a passenger seeing a stale seat map is worse than a passenger seeing an
//     error.
//   - API calls are NEVER served from cache. Not once. A cached seat map is a
//     double-booked seat waiting to happen, and the entire platform rests on the
//     rule that seat state comes from inventory-service or not at all.
//   - What it caches is the shell: the HTML, the JavaScript, the CSS. Enough to
//     bring the terminal back up so it can read its own offline caches and keep
//     selling from its owned quota.

const CACHE = 'jatra-counter-v1';

// The pages a counter terminal actually opens.
const SHELL = [
  '/counter',
  '/counter/quota',
  '/counter/sales',
  '/counter/shift',
];

// Install does as little as possible. Pre-fetching four pages here would put
// four requests in flight during the exact moment a clerk is navigating, and a
// service worker that slows down the page it is meant to protect is a bad
// trade. The warm-up happens after activation, detached.
self.addEventListener('install', (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)));
    await self.clients.claim();
    // Warm the shell in the background so a terminal that has never opened the
    // shift screen can still reach it after a reload with the line down.
    const cache = await caches.open(CACHE);
    SHELL.forEach((u) => cache.add(u).catch(() => undefined));
  })());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  // Anything that is not this origin, or is the API, goes straight to the
  // network. If it fails offline, it must fail — the POS handles that itself,
  // and a cached answer here would be a lie about seat state.
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/')) return;

  // Only the counter's own pages are claimed.
  const isCounter = url.pathname === '/counter' || url.pathname.startsWith('/counter/');
  const isAsset = url.pathname.startsWith('/_next/');
  if (!isCounter && !isAsset) return;

  // Network first, so a terminal on a working line is never a version behind.
  // The cache is the fallback, not the source.
  event.respondWith(
    fetch(req)
      .then((res) => {
        if (res && res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((cache) => cache.put(req, copy)).catch(() => undefined);
        }
        return res;
      })
      .catch(async () => {
        const hit = await caches.match(req);
        if (hit) return hit;
        if (isCounter) {
          const shell = await caches.match('/counter');
          if (shell) return shell;
        }
        return new Response(
          'The counter is offline and this page has not been opened on this terminal before.',
          { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' } },
        );
      }),
  );
});
