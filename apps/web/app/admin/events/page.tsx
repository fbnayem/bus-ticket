'use client';

import { useCallback, useEffect, useState } from 'react';
import { ApiError } from '@/lib/api';
import { sget, spost } from '@/lib/staff';
import { ErrorNotice, Loading } from '@/components/ui';
import { PageHead, TableWrap, Tile } from '@/components/staff-ui';

// The event backbone.
//
// Three numbers on this page matter more than the log itself. Unrelayed outbox
// rows mean the relay has stopped and everything downstream is going quiet.
// Rejected events mean a producer changed shape and the schema registry caught
// it before any consumer did. Dead letters mean a consumer could not process
// something and moved past it — which is correct, and needs a human.

interface EventRow {
  offset: number;
  event_id: string;
  topic: string;
  event_type: string;
  producer: string;
  payload: Record<string, unknown>;
  occurred_at: string;
}

interface Consumer {
  consumer: string;
  position: number;
  head: number;
  lag: number;
  delivered: number;
  failed: number;
  dead_letters: number;
  updated_at: string;
}

interface DeadLetter {
  dl_id: number;
  consumer: string;
  event_id: string;
  event_type: string;
  attempts: number;
  last_error: string;
  created_at: string;
  resolved_at: string | null;
}

export default function EventsPage() {
  const [events, setEvents] = useState<EventRow[]>([]);
  const [totals, setTotals] = useState({ total: 0, rejected: 0, unrelayed: 0 });
  const [consumers, setConsumers] = useState<Consumer[]>([]);
  const [dead, setDead] = useState<DeadLetter[]>([]);
  const [topic, setTopic] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    Promise.all([
      sget<{ events: EventRow[]; total: number; rejected_by_registry: number; unrelayed_outbox: number }>(
        `/admin/events?limit=60${topic ? '&topic=' + topic : ''}`),
      sget<{ consumers: Consumer[] }>('/admin/events/consumers'),
      sget<{ dead_letters: DeadLetter[] }>('/admin/events/dead-letters'),
    ])
      .then(([e, c, d]) => {
        setEvents(e.events);
        setTotals({ total: e.total, rejected: e.rejected_by_registry, unrelayed: e.unrelayed_outbox });
        setConsumers(c.consumers);
        setDead(d.dead_letters);
      })
      .catch((err: ApiError) => setError(err.message));
  }, [topic]);

  useEffect(() => {
    load();
    const t = setInterval(load, 10000);
    return () => clearInterval(t);
  }, [load]);

  if (error) return <ErrorNotice message={error} onRetry={load} />;
  if (events.length === 0 && consumers.length === 0) return <Loading rows={3} />;

  const maxLag = consumers.reduce((m, c) => Math.max(m, c.lag), 0);
  const topics = [...new Set(events.map((e) => e.topic))].sort();

  return (
    <div className="stack">
      <PageHead
        title="Event backbone"
        sub="Every producer writes to its own outbox in the same transaction as the state change. The relay is the only thing that publishes."
        actions={
          <button
            className="btn btn-ghost btn-sm"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try { await spost('/admin/events/drain'); load(); } finally { setBusy(false); }
            }}
          >
            {busy ? 'Draining…' : 'Relay and deliver now'}
          </button>
        }
      />

      <div className="tiles">
        <Tile k="Events published" n={totals.total.toLocaleString()} />
        <Tile k="Unrelayed outbox" n={totals.unrelayed} hint="should be near zero" />
        <Tile k="Rejected by the registry" n={totals.rejected} hint="producer changed shape" />
        <Tile k="Worst consumer lag" n={maxLag} hint="events behind the head" />
        <Tile k="Open dead letters" n={dead.filter((d) => !d.resolved_at).length} />
      </div>

      <section className="stack">
        <h2>Consumer groups</h2>
        <TableWrap>
          <table className="data">
            <thead>
              <tr><th>Group</th><th>Position</th><th>Head</th><th>Lag</th>
                <th>Delivered</th><th>Dead-lettered</th><th>Last moved</th></tr>
            </thead>
            <tbody>
              {consumers.map((c) => (
                <tr key={c.consumer}>
                  <td><strong>{c.consumer}</strong></td>
                  <td className="tnum">{c.position}</td>
                  <td className="tnum">{c.head}</td>
                  <td>
                    <span className={`pill ${c.lag === 0 ? 'pill-ok' : c.lag > 500 ? 'pill-danger' : 'pill-warn'}`}>
                      {c.lag}
                    </span>
                  </td>
                  <td className="tnum">{c.delivered.toLocaleString()}</td>
                  <td className="tnum">{c.dead_letters}</td>
                  <td className="small muted">{new Date(c.updated_at).toLocaleTimeString('en-GB')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableWrap>
      </section>

      {dead.length > 0 && (
        <section className="stack">
          <h2>Dead letters</h2>
          <p className="muted small">
            A consumer that cannot process an event parks it here and moves on. A
            poisoned message must never wedge everything queued behind it — but it
            does need somebody to look.
          </p>
          <TableWrap>
            <table className="data">
              <thead><tr><th>Group</th><th>Event</th><th>Attempts</th><th>Error</th><th /></tr></thead>
              <tbody>
                {dead.map((d) => (
                  <tr key={d.dl_id}>
                    <td>{d.consumer}</td>
                    <td className="mono small">{d.event_type}</td>
                    <td className="tnum">{d.attempts}</td>
                    <td className="small">{d.last_error}</td>
                    <td>
                      {d.resolved_at ? (
                        <span className="pill pill-ok">Resolved</span>
                      ) : (
                        <button
                          className="btn btn-ghost btn-sm"
                          onClick={async () => {
                            try {
                              await spost('/admin/events/replay',
                                { consumer: d.consumer, event_id: d.event_id });
                            } catch { /* the error shows on reload */ }
                            load();
                          }}
                        >
                          Replay
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableWrap>
        </section>
      )}

      <section className="stack">
        <div className="row-between">
          <h2 style={{ marginBottom: 0 }}>The log</h2>
          <div className="row" style={{ gap: '.3rem', flexWrap: 'wrap' }}>
            <button className={`btn btn-sm ${topic === '' ? 'btn-primary' : 'btn-ghost'}`}
              onClick={() => setTopic('')}>All</button>
            {topics.map((t) => (
              <button key={t} className={`btn btn-sm ${topic === t ? 'btn-primary' : 'btn-ghost'}`}
                onClick={() => setTopic(t)}>{t}</button>
            ))}
          </div>
        </div>
        <TableWrap>
          <table className="data">
            <thead><tr><th>Offset</th><th>Type</th><th>Producer</th><th>Payload</th><th>At</th></tr></thead>
            <tbody>
              {events.map((e) => (
                <tr key={e.event_id}>
                  <td className="tnum">{e.offset}</td>
                  <td className="mono small">{e.event_type}</td>
                  <td className="small muted">{e.producer}</td>
                  <td className="mono small" style={{ maxWidth: 420, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {JSON.stringify(e.payload)}
                  </td>
                  <td className="small muted">{new Date(e.occurred_at).toLocaleTimeString('en-GB')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableWrap>
      </section>
    </div>
  );
}
