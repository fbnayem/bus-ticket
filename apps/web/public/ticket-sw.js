// Service worker for the passenger's ticket.
//
// The homepage promises, in Bangla and English, that your ticket works without
// signal. The ticket data now lives on the device (lib/offlineTickets.ts), but
// data alone does not survive a reload: a passenger who refreshes at a bus stand
// with no bars gets a browser error page, and the promise is broken by the one
// action people take when a page looks stuck.
//
// This closes that, and what it touches is deliberately narrow:
//
//   - It is registered at the root scope but CLAIMS ONLY /tickets routes.
//     Those are two different things and the difference matters: scope decides
//     which documents this worker may control, and the handler below decides
//     what it will do about them. It has to be able to control a document
//     loaded at `/`, because a passenger arriving from checkout gets here by
//     client-side navigation and is still holding that document — a worker
//     scoped to /tickets would never control them and would never arm.
//     Everything that is not a ticket page or a built asset falls straight
//     through to the network, untouched, below.
//   - Search, seat maps and checkout are never cached. The counter worker's
//     warning holds — a passenger seeing a stale seat map is worse than a
//     passenger seeing an error — and a ticket is the one page that is not a
//     claim about seat state.
//   - API calls are NEVER served from cache. Not once, not the booking itself.
//     The page reads its own saved copy from localStorage and says on screen
//     that it did; a cached HTTP response would let it claim to be live.
//   - What it caches is the shell: the HTML and the built assets. Enough to get
//     the page back up so it can read that saved copy and draw the QR.
//
// The QR is a signed token the crew's scanner verifies against the platform.
// A stale copy of it cannot board anyone who should not be boarded — that
// decision is made at the door, by the scan, against the platform.

const CACHE = 'jatra-ticket-v1';

self.addEventListener('install', (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(
      keys.filter((k) => k !== CACHE && k.startsWith('jatra-ticket')).map((k) => caches.delete(k)),
    );
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  // The API is never cached. The ticket the page draws comes from the device's
  // own store, which says so on screen; a cached 200 here would let the page
  // present a three-day-old answer as a fresh one.
  if (url.pathname.startsWith('/api/')) return;

  const isTicket = url.pathname === '/tickets' || url.pathname.startsWith('/tickets/');
  const isAsset = url.pathname.startsWith('/_next/');
  if (!isTicket && !isAsset) return;

  // Network first, so a passenger with a working line is never a version
  // behind. The cache is the fallback, never the source.
  event.respondWith(
    fetch(req)
      .then((res) => {
        if (res && res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => undefined);
        }
        return res;
      })
      .catch(async () => {
        const hit = await caches.match(req);
        if (hit) return hit;
        // Any ticket shell will do — the page reads which PNR to draw from the
        // URL and finds it in the device's own store.
        if (isTicket) {
          const keys = await caches.open(CACHE).then((c) => c.keys());
          const shell = keys.find((k) => new URL(k.url).pathname.startsWith('/tickets/'));
          if (shell) return caches.match(shell);
        }
        return new Response(
          'This ticket has not been opened on this device before, so there is no copy to show.',
          { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' } },
        );
      }),
  );
});
