'use client';

import { Fragment, useCallback, useEffect, useState } from 'react';
import { ApiError } from '@/lib/api';
import { sget, staffCall } from '@/lib/staff';
import { ErrorNotice, Loading } from '@/components/ui';
import { PageHead, TableWrap, Tile } from '@/components/staff-ui';
import { taka } from '@/lib/format';

// The notification platform.
//
// The delivery log is the point of this screen. "I never got the SMS" is the
// most common support call there is, and the answer has to be a row: which
// template, in which language, through which aggregator, at what cost, and
// whether the first one refused it.

interface Notification {
  notification_id: string;
  event_type: string;
  template_key: string;
  lang: string;
  event_class: string;
  to_phone: string;
  to_email: string;
  status: string;
  suppress_reason: string;
  created_at: string;
  attempts: string;
  cost_poisha: number;
  rendered: string;
}

interface Provider {
  provider: string;
  channel: string;
  priority: number;
  cost_poisha: number;
  enabled: boolean;
  simulate_failure: boolean;
  failure_streak: number;
  last_error: string;
  cooldown_until: string | null;
  sent: number;
  failed: number;
}

interface Spend {
  cap_poisha: number;
  spent_poisha: number;
  breaker_tripped_at: string | null;
  by_provider: { channel: string; provider: string; sent: number; failed: number; cost_poisha: number }[];
}

export default function NotificationsPage() {
  const [rows, setRows] = useState<Notification[]>([]);
  const [providers, setProviders] = useState<Provider[]>([]);
  const [spend, setSpend] = useState<Spend | null>(null);
  const [filter, setFilter] = useState('');
  const [error, setError] = useState('');
  const [open, setOpen] = useState<string | null>(null);

  const load = useCallback(() => {
    Promise.all([
      sget<{ notifications: Notification[] }>(`/admin/notifications?limit=80${filter ? '&status=' + filter : ''}`),
      sget<{ providers: Provider[] }>('/admin/notifications/providers'),
      sget<Spend>('/admin/notifications/spend'),
    ])
      .then(([n, p, s]) => { setRows(n.notifications); setProviders(p.providers); setSpend(s); })
      .catch((e: ApiError) => setError(e.message));
  }, [filter]);

  useEffect(() => {
    load();
    const t = setInterval(load, 12000);
    return () => clearInterval(t);
  }, [load]);

  if (error) return <ErrorNotice message={error} onRetry={load} />;
  if (!spend) return <Loading rows={3} />;

  const sent = rows.filter((r) => r.status === 'SENT').length;
  const suppressed = rows.filter((r) => r.status === 'SUPPRESSED').length;

  return (
    <div className="stack">
      <PageHead title="Notifications"
        sub="Every message, in the language the passenger chose, with the aggregator that carried it and what it cost." />

      <div className="tiles">
        <Tile k="Sent (recent)" n={sent} />
        <Tile k="Suppressed" n={suppressed} hint="budget or preference" />
        <Tile k="Spent this month" n={taka(spend.spent_poisha, { decimals: true })} />
        <Tile k="Monthly cap" n={taka(spend.cap_poisha, { decimals: true })} />
        <Tile k="Budget breaker" n={spend.breaker_tripped_at ? 'Tripped' : 'Closed'}
          hint={spend.breaker_tripped_at ? 'operational traffic suppressed' : 'nothing suppressed'} />
      </div>

      {spend.breaker_tripped_at && (
        <div className="notice notice-warn">
          <strong>The monthly notification budget is spent.</strong> Operational and
          marketing messages are being suppressed. Ticket confirmations, refunds and
          one-time codes still go out — a blown budget must never leave a passenger
          who paid without their PNR.
        </div>
      )}

      <section className="stack">
        <h2>Providers</h2>
        <p className="muted small">
          Two SMS aggregators, tried in priority order. Taking the primary down here
          is how you check the secondary actually carries the traffic before you
          find out during Eid.
        </p>
        <TableWrap>
          <table className="data">
            <thead>
              <tr><th>Provider</th><th>Channel</th><th>Priority</th><th>Cost</th>
                <th>Sent</th><th>Failed</th><th>State</th><th /></tr>
            </thead>
            <tbody>
              {providers.map((p) => (
                <tr key={p.provider}>
                  <td><strong>{p.provider}</strong></td>
                  <td>{p.channel}</td>
                  <td className="tnum">{p.priority}</td>
                  <td className="tnum">{taka(p.cost_poisha, { decimals: true })}</td>
                  <td className="tnum">{p.sent}</td>
                  <td className="tnum">{p.failed}</td>
                  <td>
                    {p.simulate_failure
                      ? <span className="pill pill-danger">Down</span>
                      : p.cooldown_until
                        ? <span className="pill pill-warn">Cooling off</span>
                        : <span className="pill pill-ok">Healthy</span>}
                  </td>
                  <td>
                    <button
                      className="btn btn-ghost btn-sm"
                      onClick={async () => {
                        await staffCall(`/admin/notifications/providers/${p.provider}`,
                          { method: 'PATCH', body: { simulate_failure: !p.simulate_failure } });
                        load();
                      }}
                    >
                      {p.simulate_failure ? 'Bring back up' : 'Take down'}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableWrap>
      </section>

      <section className="stack">
        <div className="row-between">
          <h2 style={{ marginBottom: 0 }}>Delivery log</h2>
          <div className="row" style={{ gap: '.3rem' }}>
            {['', 'SENT', 'FAILED', 'SUPPRESSED'].map((f) => (
              <button key={f || 'all'}
                className={`btn btn-sm ${filter === f ? 'btn-primary' : 'btn-ghost'}`}
                onClick={() => setFilter(f)}>{f || 'All'}</button>
            ))}
          </div>
        </div>
        <TableWrap>
          <table className="data">
            <thead>
              <tr><th>Event</th><th>To</th><th>Lang</th><th>Class</th>
                <th>Attempts</th><th>Cost</th><th>Status</th><th>At</th></tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <Fragment key={r.notification_id}>
                  <tr onClick={() => setOpen(open === r.notification_id ? null : r.notification_id)}
                      style={{ cursor: 'pointer' }}>
                    <td className="mono small">{r.event_type}</td>
                    <td className="mono small">{r.to_phone || r.to_email || '—'}</td>
                    <td>{r.lang === 'bn' ? 'বাংলা' : 'English'}</td>
                    <td className="small muted">{r.event_class.toLowerCase()}</td>
                    <td className="small">{r.attempts || '—'}</td>
                    <td className="tnum">{taka(r.cost_poisha, { decimals: true })}</td>
                    <td>
                      <span className={`pill ${r.status === 'SENT' ? 'pill-ok'
                        : r.status === 'SUPPRESSED' ? 'pill-warn' : 'pill-danger'}`}>
                        {r.status}
                      </span>
                    </td>
                    <td className="small muted">{new Date(r.created_at).toLocaleTimeString('en-GB')}</td>
                  </tr>
                  {open === r.notification_id && (
                    <tr>
                      <td colSpan={8} style={{ background: 'var(--surface-2, #f7f7f8)' }}>
                        <div className="small" style={{ whiteSpace: 'pre-wrap', padding: '.4rem 0' }}>
                          {r.rendered || '(nothing was rendered — no template for this channel and language)'}
                        </div>
                        {r.suppress_reason && (
                          <div className="small muted">Suppressed: {r.suppress_reason}</div>
                        )}
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
            </tbody>
          </table>
        </TableWrap>
      </section>

      <div className="notice notice-warn">
        <strong>What is simulated.</strong> A &ldquo;sent&rdquo; message lands in a table,
        not on a handset — there is no aggregator contract behind this build. The
        routing, the language, the failover, the cost and this log are all real.
      </div>
    </div>
  );
}
