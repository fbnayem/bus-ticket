'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { ApiError } from '@/lib/api';
import { sget } from '@/lib/staff';
import { ErrorNotice, Loading, StatusPill } from '@/components/ui';
import { PageHead, Money } from '@/components/staff-ui';
import { dateTimeOf, timeOf } from '@/lib/format';

interface Booking {
  pnr: string; status: string; total_poisha: number; created_at: string;
  depart_at: string; operator: string; seats: string;
  commission_poisha: number; passenger: string;
}

export default function AgentBookingsPage() {
  const [rows, setRows] = useState<Booking[]>([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    sget<{ bookings: Booking[] }>('/agent/bookings')
      .then((r) => setRows(r.bookings))
      .catch((e: ApiError) => setError(e.message))
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <Loading rows={2} />;

  return (
    <div className="stack">
      <PageHead title="Bookings you sold" sub="Newest first" />
      {error && <ErrorNotice message={error} />}

      <div className="table-wrap">
        <table className="data">
          <thead>
            <tr>
              <th>PNR</th><th>Passenger</th><th>Departure</th><th>Seats</th>
              <th className="num">Fare</th><th className="num">Commission</th>
              <th>Status</th><th>Sold</th><th />
            </tr>
          </thead>
          <tbody>
            {rows.map((b) => (
              <tr key={b.pnr}>
                <td className="mono"><strong>{b.pnr}</strong></td>
                <td>{b.passenger || '—'}</td>
                <td>{b.operator} · {timeOf(b.depart_at)}</td>
                <td className="mono">{b.seats}</td>
                <td className="num"><Money poisha={b.total_poisha} /></td>
                <td className="num" style={{ color: b.commission_poisha ? 'var(--ok)' : undefined }}>
                  {b.commission_poisha ? <Money poisha={b.commission_poisha} decimals /> : '—'}
                </td>
                <td><StatusPill status={b.status} /></td>
                <td className="muted small">{dateTimeOf(b.created_at)}</td>
                <td><Link className="btn btn-sm btn-ghost" href={`/manage/${b.pnr}`}>Manage</Link></td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr><td colSpan={9} className="muted center">You have not sold anything yet.</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
