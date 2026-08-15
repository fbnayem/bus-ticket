'use client';

import { useCallback, useEffect, useState } from 'react';
import { ApiError } from '@/lib/api';
import { sget, spost } from '@/lib/staff';
import { ErrorNotice, Loading } from '@/components/ui';
import { PageHead, TableWrap, Tile } from '@/components/staff-ui';

// Partners.
//
// A partner is another sales channel and books from the same inventory service
// as everything else. What this screen is actually about is the perimeter: who
// is allowed in, how much of the API they may use, and whether the events we
// promised to send them arrived.

interface Partner {
  partner_id: string;
  name: string;
  contact_email: string;
  tier: string;
  daily_quota: number;
  rate_per_min: number;
  calls_today: number;
  rejected_today: number;
  certified_at: string | null;
  subscriptions: number;
  dead_letters: number;
}

interface Delivery {
  delivery_id: string;
  partner: string;
  event_type: string;
  event_id: string;
  status: string;
  attempts: number;
  last_status_code: number | null;
  last_error: string;
  next_attempt_at: string;
  created_at: string;
  delivered_at: string | null;
  url: string;
}

export default function PartnersPage() {
  const [partners, setPartners] = useState<Partner[]>([]);
  const [deliveries, setDeliveries] = useState<Delivery[]>([]);
  const [error, setError] = useState('');
  const [flash, setFlash] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    Promise.all([
      sget<{ partners: Partner[] }>('/admin/partners'),
      sget<{ deliveries: Delivery[] }>('/admin/partners/deliveries?limit=60'),
    ])
      .then(([p, d]) => { setPartners(p.partners); setDeliveries(d.deliveries); })
      .catch((e: ApiError) => setError(e.message));
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(load, 15000);
    return () => clearInterval(t);
  }, [load]);

  if (error) return <ErrorNotice message={error} onRetry={load} />;
  if (partners.length === 0) return <Loading rows={2} />;

  const dead = deliveries.filter((d) => d.status === 'DEAD');
  const retrying = deliveries.filter((d) => d.status === 'RETRYING');

  return (
    <div className="stack">
      <PageHead
        title="Partners"
        sub="Signed requests, per-partner quotas, and a delivery log the partner can see."
        actions={
          <button className="btn btn-ghost btn-sm" disabled={busy}
            onClick={async () => {
              setBusy(true); setFlash('');
              try {
                const r = await spost<{ delivered: number; retrying: number; dead: number }>(
                  '/admin/partners/dispatch');
                setFlash(`${r.delivered} delivered, ${r.retrying} retrying, ${r.dead} dead-lettered.`);
              } catch (e) { setFlash((e as ApiError).message); }
              finally { setBusy(false); load(); }
            }}>
            {busy ? 'Dispatching…' : 'Dispatch due webhooks'}
          </button>
        }
      />

      <div className="tiles">
        <Tile k="Partners" n={partners.length} />
        <Tile k="Live" n={partners.filter((p) => p.tier === 'LIVE').length} />
        <Tile k="In sandbox" n={partners.filter((p) => p.tier === 'SANDBOX').length} />
        <Tile k="Retrying" n={retrying.length} hint="endpoint is down" />
        <Tile k="Dead-lettered" n={dead.length} hint="gave up after 24 hours" />
      </div>

      {flash && <div className="notice notice-info small">{flash}</div>}

      <section className="stack">
        <h2>Accounts</h2>
        <TableWrap>
          <table className="data">
            <thead>
              <tr><th>Partner</th><th>Tier</th><th>Today</th><th>Refused</th>
                <th>Rate limit</th><th>Subscriptions</th><th /></tr>
            </thead>
            <tbody>
              {partners.map((p) => (
                <tr key={p.partner_id}>
                  <td>
                    <strong>{p.name}</strong>
                    <div className="small muted">{p.contact_email}</div>
                  </td>
                  <td>
                    <span className={`pill ${p.tier === 'LIVE' ? 'pill-ok'
                      : p.tier === 'SUSPENDED' ? 'pill-danger' : 'pill-warn'}`}>
                      {p.tier.toLowerCase()}
                    </span>
                  </td>
                  <td className="tnum">{p.calls_today.toLocaleString()} / {p.daily_quota.toLocaleString()}</td>
                  <td className="tnum">{p.rejected_today}</td>
                  <td className="tnum">{p.rate_per_min}/min</td>
                  <td className="tnum">{p.subscriptions}</td>
                  <td>
                    {p.tier === 'SANDBOX' && (
                      <button className="btn btn-ghost btn-sm"
                        onClick={async () => {
                          setFlash('');
                          try {
                            await spost(`/admin/partners/${p.partner_id}/certify`);
                            setFlash(`${p.name} is certified and live.`);
                          } catch (e) { setFlash((e as ApiError).message); }
                          load();
                        }}>
                        Certify
                      </button>
                    )}
                    {p.certified_at && (
                      <span className="small muted">
                        certified {new Date(p.certified_at).toLocaleDateString('en-GB')}
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableWrap>
        <p className="muted small">
          A partner cannot be certified without having actually completed a run in
          sandbox. The check is on the server, not on this button.
        </p>
      </section>

      <section className="stack">
        <h2>Webhook deliveries</h2>
        <p className="muted small">
          Signed with the partner&apos;s own secret, retried with backoff for up to a
          day, and dead-lettered after that rather than dropped. This is the log a
          partner sees when they ask whether we sent something.
        </p>
        {deliveries.length === 0 ? (
          <div className="notice notice-info">Nothing queued.</div>
        ) : (
          <TableWrap>
            <table className="data">
              <thead>
                <tr><th>Partner</th><th>Event</th><th>Status</th><th>Attempts</th>
                  <th>Response</th><th>Next try</th><th /></tr>
              </thead>
              <tbody>
                {deliveries.map((d) => (
                  <tr key={d.delivery_id}>
                    <td className="small">{d.partner}</td>
                    <td className="mono small">{d.event_type}</td>
                    <td>
                      <span className={`pill ${d.status === 'DELIVERED' ? 'pill-ok'
                        : d.status === 'DEAD' ? 'pill-danger' : 'pill-warn'}`}>
                        {d.status.toLowerCase()}
                      </span>
                    </td>
                    <td className="tnum">{d.attempts}</td>
                    <td className="small">
                      {d.last_status_code ? `HTTP ${d.last_status_code}` : (d.last_error || '—')}
                    </td>
                    <td className="small muted">
                      {d.status === 'DELIVERED' ? '—'
                        : new Date(d.next_attempt_at).toLocaleTimeString('en-GB')}
                    </td>
                    <td>
                      {(d.status === 'DEAD' || d.status === 'RETRYING') && (
                        <button className="btn btn-ghost btn-sm"
                          onClick={async () => {
                            await spost(`/admin/partners/deliveries/${d.delivery_id}/replay`);
                            load();
                          }}>Replay</button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableWrap>
        )}
      </section>
    </div>
  );
}
