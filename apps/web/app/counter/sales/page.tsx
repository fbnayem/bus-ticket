'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { ApiError } from '@/lib/api';
import { sget } from '@/lib/staff';
import { queue, type QueuedSale } from '@/lib/offline';
import { ErrorNotice, Loading, StatusPill } from '@/components/ui';
import { PageHead, Money } from '@/components/staff-ui';
import { dateTimeOf, timeOf } from '@/lib/format';

interface Sale {
  pnr: string; status: string; total_poisha: number; created_at: string;
  depart_at: string; operator: string; seats: string; provider: string;
}

export default function CounterSalesPage() {
  const [sales, setSales] = useState<Sale[]>([]);
  const [pending, setPending] = useState<QueuedSale[]>([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    sget<{ sales: Sale[] }>('/counter/sales')
      .then((r) => setSales(r.sales))
      .catch((e: ApiError) => setError(e.message))
      .finally(() => setLoading(false));
    setPending(queue.all());
  }, []);

  if (loading) return <Loading rows={2} />;

  return (
    <div className="stack">
      <PageHead title="Sales from this counter" sub="Most recent first · reprint from the ticket page" />
      {error && <ErrorNotice message={error} />}

      {pending.length > 0 && (
        <div className="card card-pad stack-sm">
          <h3 style={{ marginBottom: 0 }}>Not yet synced ({pending.length})</h3>
          <p className="small muted" style={{ marginBottom: '.3rem' }}>
            Sold offline from this counter&apos;s own reserved seats. They have no
            PNR until the terminal reconnects and the queue is replayed.
          </p>
          <div className="table-wrap">
            <table className="data">
              <thead><tr><th>Reference</th><th>Seats</th><th>Sold</th><th className="num">Amount</th></tr></thead>
              <tbody>
                {pending.map((p) => (
                  <tr key={p.client_ref}>
                    <td className="mono small">{p.client_ref.slice(-8)}</td>
                    <td className="mono">{p.seats.join(', ')}</td>
                    <td>{dateTimeOf(p.sold_at)}</td>
                    <td className="num"><Money poisha={p.total_poisha} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <div className="table-wrap">
        <table className="data">
          <thead>
            <tr>
              <th>PNR</th><th>Departure</th><th>Seats</th><th>Paid with</th>
              <th className="num">Amount</th><th>Status</th><th>Sold</th><th />
            </tr>
          </thead>
          <tbody>
            {sales.map((s) => (
              <tr key={s.pnr}>
                <td className="mono"><strong>{s.pnr}</strong></td>
                <td>{s.operator} · {timeOf(s.depart_at)}</td>
                <td className="mono">{s.seats}</td>
                <td>{s.provider || '—'}</td>
                <td className="num"><Money poisha={s.total_poisha} /></td>
                <td><StatusPill status={s.status} /></td>
                <td className="muted small">{dateTimeOf(s.created_at)}</td>
                <td><Link className="btn btn-sm btn-ghost" href={`/tickets/${s.pnr}`}>Reprint</Link></td>
              </tr>
            ))}
            {sales.length === 0 && (
              <tr><td colSpan={8} className="muted center">Nothing sold from this counter yet.</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
