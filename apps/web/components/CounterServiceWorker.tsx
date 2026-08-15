'use client';

import { useEffect, useState } from 'react';

// Registers the counter's service worker.
//
// It is scoped to /counter and registered only from inside the POS, so nothing
// a passenger loads is ever served from a cache. The banner exists because a
// clerk should be able to tell the difference between "this terminal can
// survive a reload" and "this terminal cannot" without asking anybody.

export function CounterServiceWorker() {
  const [state, setState] = useState<'unknown' | 'ready' | 'unsupported' | 'failed'>('unknown');

  useEffect(() => {
    if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) {
      setState('unsupported');
      return;
    }
    navigator.serviceWorker
      .register('/counter-sw.js', { scope: '/counter' })
      .then(() => setState('ready'))
      .catch(() => setState('failed'));
  }, []);

  if (state === 'ready' || state === 'unknown') return null;

  return (
    <div className="notice notice-warn small" data-testid="sw-warning">
      <strong>This terminal cannot survive a reload while offline.</strong>{' '}
      {state === 'unsupported'
        ? 'This browser does not support service workers.'
        : 'The offline shell failed to install.'}{' '}
      The offline queue and the quota cache still work as long as the page stays
      open — but do not refresh while the line is down.
    </div>
  );
}
