'use client';

import { useEffect, useState } from 'react';
import { useT } from './LangProvider';

/**
 * The ticket page's two pieces of offline machinery, kept together because they
 * only make sense together.
 *
 * **It registers the passenger service worker**, and does it from here rather
 * than from the layout, so the scope stays exactly one route family. The
 * counter's worker carries a comment warning that the passenger site must not
 * be cached — a stale seat map is worse than an error — and that warning is
 * correct and still stands. A ticket is the exception, and it is an exception
 * for a reason worth stating: nothing on the ticket page is a claim about seat
 * availability. It is a record of a purchase already made, carrying a signed
 * token that the crew's scanner verifies against the platform at the door. The
 * scan is what decides who boards, and the scan happens somewhere else.
 *
 * **It says where the copy came from.** A passenger looking at a ticket that
 * has not been checked with the platform since Tuesday should be told so, in
 * the same words the app uses.
 */
export function TicketOffline({ fromDevice }: { fromDevice: boolean }) {
  const t = useT();
  const [swFailed, setSwFailed] = useState(false);

  useEffect(() => {
    if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) {
      setSwFailed(true);
      return;
    }
    // Waiting for an *active* worker is not the same as waiting for one that is
    // driving this page. A page that loaded before any worker existed stays
    // uncontrolled until `clients.claim()` lands, and a warm-up fetch sent in
    // that window goes straight to the network and caches nothing — which is
    // how this looked like it worked in development, where the extra hundreds
    // of milliseconds hid the race, and cached exactly one file in production.
    const controlled = async () => {
      if (navigator.serviceWorker.controller) return;
      await new Promise<void>((resolve) => {
        navigator.serviceWorker.addEventListener('controllerchange', () => resolve(), { once: true });
        // Never hang the page on this. A ticket that failed to arm itself for
        // offline use is still a ticket, and the reader is told below.
        setTimeout(resolve, 4000);
      });
    };

    // Registered at the root scope, and that is not the same as caching the
    // root. Scope decides which *documents* a worker may control; the worker's
    // own fetch handler decides what it will touch, and that stays narrowed to
    // /tickets and the built assets.
    //
    // It has to be this way round because of how people reach this page. After
    // checkout they arrive by client-side navigation, so the document they are
    // holding was loaded from `/` — outside a `/tickets` scope, never
    // controlled, and the worker sat there armed and useless until they
    // happened to reload. Which is the one moment it was supposed to help.
    navigator.serviceWorker
      .register('/ticket-sw.js', { scope: '/' })
      .then(() => navigator.serviceWorker.ready)
      .then(controlled)
      .then(async () => {
        // Warm this exact page, and everything it is standing on.
        //
        // A worker registered from a page cannot have cached the page it was
        // registered from: those requests went out before any worker existed to
        // intercept them. So the first visit installed the machinery and cached
        // nothing, and a passenger who opened their ticket at home and reloaded
        // it at the bus stand got a browser error page.
        //
        // Warming the document alone is not enough either, and the failure is a
        // quiet one — the HTML comes back from cache, the scripts it needs do
        // not, and the reader gets a blank page instead of an error, which is
        // worse. So the page asks the browser what it actually loaded and warms
        // that: the document plus its own scripts, styles and fonts.
        const here = window.location.href;
        const assets = performance
          .getEntriesByType('resource')
          .map((e) => e.name)
          .filter((u) => u.startsWith(window.location.origin) && u.includes('/_next/'));
        await Promise.all(
          [here, ...new Set(assets)].map((u) =>
            fetch(u, { cache: 'reload' }).catch(() => undefined),
          ),
        );
      })
      .catch(() => setSwFailed(true));
  }, []);

  if (fromDevice) {
    return (
      <p className="small muted no-print" data-testid="ticket-from-device">
        {t('ticket.onThisDevice')}
      </p>
    );
  }
  // Only worth saying while the line is up, when there is still time to do
  // something about it. Shouting it at somebody already offline is no help.
  if (swFailed && typeof navigator !== 'undefined' && navigator.onLine) {
    return (
      <p className="small muted no-print" data-testid="ticket-sw-warning">
        {t('ticket.offlineUnavailable')}
      </p>
    );
  }
  return null;
}
