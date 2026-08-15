'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { ApiError } from '@/lib/api';
import { sget } from '@/lib/staff';
import { ErrorNotice, Loading, StatusPill } from '@/components/ui';
import { PageHead, Money } from '@/components/staff-ui';
import { dateTimeOf, timeOf } from '@/lib/format';

interface Booking {
  pnr: string; status: string; channel: string; total_poisha: number;
  created_at: string; operator: string; phone: string; depart_at: string;
}

export default function AdminBookingsPage() {
  const [rows, setRows] = useState<Booking[]>([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    sget<{ bookings: Booking[] }>('/admin/bookings')
      .then((r) => setRows(r.bookings))
      .catch((e: ApiError) => setError(e.message))
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <Loading rows={2} />;

  return (
    <div className="stack">
      <PageHead title="Bookings" sub="Every operator, newest first" />
      {error && <ErrorNotice message={error} />}
      <div className="table-wrap">
        <table className="data">
          <thead>
            <tr>
              <th>PNR</th><th>Operator</th><th>Departure</th><th>Channel</th>
              <th>Contact</th><th className="num">Amount</th><th>Status</th><th>Booked</th><th />
            </tr>
          </thead>
          <tbody>
            {rows.map((b) => (
              <tr key={b.pnr}>
                <td className="mono"><strong>{b.pnr}</strong></td>
                <td>{b.operator}</td>
                <td>{timeOf(b.depart_at)}</td>
                <td className="small muted">{b.channel.replace(/_/g, ' ').toLowerCase()}</td>
                <td className="mono small">{b.phone}</td>
                <td className="num"><Money poisha={b.total_poisha} /></td>
                <td><StatusPill status={b.status} /></td>
                <td className="muted small">{dateTimeOf(b.created_at)}</td>
                <td><Link className="btn btn-sm btn-ghost" href={`/helpdesk/booking/${b.pnr}`}>Timeline</Link></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
