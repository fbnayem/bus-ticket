'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { ApiError } from '@/lib/api';
import { sget } from '@/lib/staff';
import { ErrorNotice, Loading, StatusPill } from '@/components/ui';
import { PageHead, Money } from '@/components/staff-ui';
import { dateTimeOf, timeOf } from '@/lib/format';

interface Booking {
  pnr: string; status: string; channel: string; total_poisha: number;
  created_at: string; depart_at: string; passenger: string; seats: string;
  counter: string; agency: string;
}

export default function OperatorBookingsPage() {
  const [rows, setRows] = useState<Booking[]>([]);
  const [channel, setChannel] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    sget<{ bookings: Booking[] }>('/operator/bookings')
      .then((r) => setRows(r.bookings))
      .catch((e: ApiError) => setError(e.message))
      .finally(() => setLoading(false));
  }, []);

  const channels = useMemo(() => [...new Set(rows.map((r) => r.channel))].sort(), [rows]);
  const shown = channel ? rows.filter((r) => r.channel === channel) : rows;

  if (loading) return <Loading rows={2} />;

  return (
    <div className="stack">
      <PageHead
        title="Bookings"
        sub="Every channel, one list — the seat came from the same inventory whichever door it was sold through"
        actions={
          <select className="select" style={{ width: 190 }} value={channel}
                  onChange={(e) => setChannel(e.target.value)} aria-label="Filter by channel">
            <option value="">All channels</option>
            {channels.map((c) => <option key={c} value={c}>{c.replace(/_/g, ' ')}</option>)}
          </select>
        }
      />
      {error && <ErrorNotice message={error} />}

      <div className="table-wrap">
        <table className="data">
          <thead>
            <tr>
              <th>PNR</th><th>Passenger</th><th>Departure</th><th>Seats</th>
              <th>Sold via</th><th className="num">Amount</th><th>Status</th><th>Booked</th><th />
            </tr>
          </thead>
          <tbody>
            {shown.map((b) => (
              <tr key={b.pnr}>
                <td className="mono"><strong>{b.pnr}</strong></td>
                <td>{b.passenger || '—'}</td>
                <td>{timeOf(b.depart_at)}</td>
                <td className="mono small">{b.seats}</td>
                <td className="small">
                  {b.channel.replace(/_/g, ' ').toLowerCase()}
                  {(b.counter || b.agency) && (
                    <div className="muted" style={{ fontSize: '.74rem' }}>{b.counter || b.agency}</div>
                  )}
                </td>
                <td className="num"><Money poisha={b.total_poisha} /></td>
                <td><StatusPill status={b.status} /></td>
                <td className="muted small">{dateTimeOf(b.created_at)}</td>
                <td><Link className="btn btn-sm btn-ghost" href={`/helpdesk/booking/${b.pnr}`}>Timeline</Link></td>
              </tr>
            ))}
            {shown.length === 0 && (
              <tr><td colSpan={9} className="muted center">No bookings.</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
