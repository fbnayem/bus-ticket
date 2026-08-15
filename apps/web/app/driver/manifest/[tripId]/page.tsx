'use client';

import { use, useEffect, useState } from 'react';
import Link from 'next/link';
import { ApiError } from '@/lib/api';
import { sget } from '@/lib/staff';
import { ErrorNotice, Loading } from '@/components/ui';
import { PageHead, Bar } from '@/components/staff-ui';
import { dateTimeOf } from '@/lib/format';

interface Manifest {
  trip: { depart_at: string; route: string; operator: string; registration: string; status: string };
  passengers: {
    seat_no: string; pnr: string; channel: string; passenger: string; phone: string;
    ticket_status: string; from: string; to: string;
  }[];
  total: number; boarded: number;
}

export default function DriverManifestPage({ params }: { params: Promise<{ tripId: string }> }) {
  const { tripId } = use(params);
  const [m, setM] = useState<Manifest | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    sget<Manifest>(`/driver/trips/${tripId}/manifest`)
      .then((r) => { setM(r); localStorage.setItem('jatra.manifest.' + tripId, JSON.stringify(r)); })
      .catch((e: ApiError) => {
        const cached = localStorage.getItem('jatra.manifest.' + tripId);
        if (cached) { setM(JSON.parse(cached)); setError('Showing the copy saved on this device — the service is unreachable.'); }
        else setError(e.message);
      });
  }, [tripId]);

  if (!m && error) return <ErrorNotice message={error} />;
  if (!m) return <Loading rows={2} />;

  return (
    <div className="stack">
      <PageHead
        title="Manifest"
        sub={`${m.trip.route} · ${dateTimeOf(m.trip.depart_at)} · ${m.trip.registration}`}
        actions={
          <>
            <Link className="btn btn-brand" href={`/driver/scan?trip=${tripId}`}>Board passengers</Link>
            <button className="btn btn-ghost" onClick={() => window.print()}>Print</button>
          </>
        }
      />
      {error && <div className="notice notice-warn">{error}</div>}

      <div className="row" style={{ gap: '.7rem' }}>
        <span className="small muted">{m.boarded} of {m.total} boarded</span>
        <div style={{ flex: '0 1 200px' }}><Bar value={m.boarded} max={Math.max(1, m.total)} /></div>
      </div>

      <div className="table-wrap">
        <table className="data">
          <thead>
            <tr><th>Seat</th><th>Passenger</th><th>Gets on / off</th><th>PNR</th><th>Phone</th><th>Boarded</th></tr>
          </thead>
          <tbody>
            {m.passengers.map((p) => (
              <tr key={p.seat_no + p.pnr}>
                <td className="mono"><strong>{p.seat_no}</strong></td>
                <td>{p.passenger || '—'}</td>
                <td className="small">{p.from} → {p.to}</td>
                <td className="mono small">{p.pnr}</td>
                <td className="mono small">{p.phone}</td>
                <td>
                  {p.ticket_status === 'BOARDED'
                    ? <span className="pill pill-ok">yes</span>
                    : <span className="pill">—</span>}
                </td>
              </tr>
            ))}
            {m.passengers.length === 0 && (
              <tr><td colSpan={6} className="muted center">Nobody booked on this departure.</td></tr>
            )}
          </tbody>
        </table>
      </div>

      <p className="small muted">
        Not everyone boards at the first stop. The third column is who gets on
        where — a passenger joining at Cumilla is not a no-show in Dhaka.
      </p>
    </div>
  );
}
