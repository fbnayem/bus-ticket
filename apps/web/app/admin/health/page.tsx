'use client';

import { useCallback, useEffect, useState } from 'react';
import { ApiError } from '@/lib/api';
import { sget } from '@/lib/staff';
import { ErrorNotice, Loading } from '@/components/ui';
import { PageHead, Tile } from '@/components/staff-ui';
import { taka } from '@/lib/format';

// System health.
//
// Two of the numbers here exist to catch silent failure rather than loud
// failure: overdue holds means the expiry sweeper has stopped (seats slowly
// disappearing from sale), and wallet cache drift means a balance column has
// diverged from its transaction log. Neither raises an error anywhere; both
// would quietly cost money.

interface Health {
  database: { up: boolean };
  holds: { held: number; expired: number; confirmed: number };
  overdue_holds: number;
  events: {
    unrelayed_outbox: number;
    published: number;
    rejected_by_registry: number;
    dead_letters: number;
    max_consumer_lag: number;
  };
  notifications: {
    sent: number; failed: number; suppressed: number;
    spent_poisha: number; cap_poisha: number;
  };
  search_index: { legs: number; seconds_behind: number };
  ledger: { variance_poisha: number; balanced: boolean };
  wallets: { cache_drift: number };
}

export default function HealthPage() {
  const [h, setH] = useState<Health | null>(null);
  const [error, setError] = useState('');
  const [at, setAt] = useState('');

  const load = useCallback(() => {
    sget<Health>('/admin/health')
      .then((r) => { setH(r); setAt(new Date().toLocaleTimeString('en-GB')); })
      .catch((e: ApiError) => setError(e.message));
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(load, 15000);
    return () => clearInterval(t);
  }, [load]);

  if (error) return <ErrorNotice message={error} onRetry={load} />;
  if (!h) return <Loading rows={2} />;

  const problems: string[] = [];
  if (!h.database.up) problems.push('The database is unreachable.');
  if (!h.ledger.balanced) problems.push('The trial balance does not net to zero.');
  if (h.overdue_holds > 5) problems.push(`${h.overdue_holds} holds are past their deadline and still held — the expiry sweeper may have stopped.`);
  if (h.wallets.cache_drift > 0) problems.push(`${h.wallets.cache_drift} agent wallet(s) disagree with their transaction log.`);
  if (h.events.unrelayed_outbox > 100) problems.push(`${h.events.unrelayed_outbox} events are written but not relayed — the relay may have stopped.`);
  if (h.events.rejected_by_registry > 0) problems.push(`${h.events.rejected_by_registry} event(s) were rejected by the schema registry — a producer has changed shape.`);
  if (h.events.dead_letters > 0) problems.push(`${h.events.dead_letters} event(s) are dead-lettered and waiting for somebody.`);
  if (h.events.max_consumer_lag > 500) problems.push(`A consumer group is ${h.events.max_consumer_lag} events behind.`);
  if (h.notifications.cap_poisha > 0 && h.notifications.spent_poisha >= h.notifications.cap_poisha) problems.push('The monthly notification budget is spent; operational messages are being suppressed.');
  if (h.search_index.seconds_behind > 900) problems.push(`The search projection is ${Math.round(h.search_index.seconds_behind / 60)} minutes stale.`);

  return (
    <div className="stack">
      <PageHead title="System health" sub={`Refreshed ${at}`} actions={
        <button className="btn btn-ghost btn-sm" onClick={load}>Refresh</button>
      } />

      {problems.length === 0 ? (
        <div className="notice notice-info">
          <strong>Nothing is wrong.</strong> The books balance, no wallet has drifted
          from its log, and no seat is stuck held past its deadline.
        </div>
      ) : (
        <div className="notice notice-danger">
          <strong>Attention needed</strong>
          <ul style={{ margin: '.4rem 0 0', paddingLeft: '1.1rem' }}>
            {problems.map((p) => <li key={p}>{p}</li>)}
          </ul>
        </div>
      )}

      <div className="tiles">
        <Tile k="Database" n={h.database.up ? 'Up' : 'Down'} />
        <Tile k="Live seat holds" n={h.holds.held} hint="in flight right now" />
        <Tile k="Holds past deadline" n={h.overdue_holds} hint="should be near zero" />
        <Tile k="Confirmed holds" n={h.holds.confirmed} />
        <Tile k="Expired holds" n={h.holds.expired} hint="released back to sale" />
        <Tile k="Ledger variance" n={h.ledger.balanced ? '0' : taka(h.ledger.variance_poisha, { decimals: true })} />
        <Tile k="Wallet cache drift" n={h.wallets.cache_drift} hint="cached vs recomputed" />
        <Tile k="Events published" n={h.events.published.toLocaleString()} />
        <Tile k="Unrelayed outbox" n={h.events.unrelayed_outbox} hint="written, not yet published" />
        <Tile k="Rejected by the registry" n={h.events.rejected_by_registry} hint="a producer changed shape" />
        <Tile k="Dead letters" n={h.events.dead_letters} />
        <Tile k="Worst consumer lag" n={h.events.max_consumer_lag} />
        <Tile k="Notifications sent" n={h.notifications.sent.toLocaleString()} />
        <Tile k="Notification spend" n={taka(h.notifications.spent_poisha, { decimals: true })}
          hint={`cap ${taka(h.notifications.cap_poisha, { decimals: true })}`} />
        <Tile k="Search index" n={h.search_index.legs.toLocaleString()}
          hint={`${h.search_index.seconds_behind}s behind`} />
      </div>

      <div className="notice notice-warn">
        <strong>What these numbers are for.</strong> None of them raises an error
        anywhere. A stalled relay, a drifted wallet, a stale search projection and
        a stranded hold all keep serving traffic while quietly costing money —
        which is exactly why they are counted here rather than left to be noticed.
      </div>
    </div>
  );
}
