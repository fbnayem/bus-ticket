'use client';

import { use, useEffect, useState } from 'react';
import Link from 'next/link';
import { api, ApiError, type Booking } from '@/lib/api';
import { QrCode } from '@/components/QrCode';
import { ErrorNotice, Loading, StatusPill } from '@/components/ui';
import { dateOf, dateTimeOf, taka, timeOf } from '@/lib/format';

export default function TicketPage({ params }: { params: Promise<{ pnr: string }> }) {
  const { pnr } = use(params);
  const [booking, setBooking] = useState<Booking | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    api.booking(pnr).then(setBooking).catch((e: ApiError) => setError(e.message));
  }, [pnr]);

  if (error) return <div className="page container-narrow"><ErrorNotice message={error} /></div>;
  if (!booking) return <div className="page container-narrow"><Loading rows={2} /></div>;

  const cancelled = ['CANCELLED', 'REFUNDED', 'REFUND_PENDING'].includes(booking.status);

  return (
    <div className="page container-narrow">
      <div className="row-between no-print" style={{ marginBottom: '1rem' }}>
        <h1 style={{ fontSize: '1.3rem' }}>Your ticket</h1>
        <div className="row" style={{ gap: '.4rem' }}>
          <button className="btn btn-ghost btn-sm" onClick={() => window.print()}>Print</button>
          <Link className="btn btn-ghost btn-sm" href={`/tracking/${booking.pnr}`}>Track</Link>
          <Link className="btn btn-ghost btn-sm" href={`/manage/${booking.pnr}`}>Manage</Link>
        </div>
      </div>

      {cancelled && (
        <div className="notice notice-danger" style={{ marginBottom: '1rem' }}>
          This booking is {booking.status.toLowerCase().replace(/_/g, ' ')}. The QR codes below will not scan at boarding.
        </div>
      )}

      <div className="ticket">
        <div className="ticket-head">
          <div className="row-between">
            <div>
              <div style={{ fontSize: '.76rem', opacity: .85, textTransform: 'uppercase', letterSpacing: '.08em' }}>
                Booking reference
              </div>
              <div className="pnr">{booking.pnr}</div>
            </div>
            <div style={{ textAlign: 'right' }}>
              <div style={{ fontWeight: 700 }}>{booking.brand}</div>
              <div style={{ fontSize: '.82rem', opacity: .9 }}>{booking.bus_type}</div>
            </div>
          </div>
        </div>

        <div className="ticket-body">
          <div className="stack">
            <div className="row" style={{ gap: '1.5rem', alignItems: 'flex-start' }}>
              <div>
                <div className="small muted">From</div>
                <div style={{ fontWeight: 700, fontSize: '1.05rem' }}>{booking.origin}</div>
                <div className="mono tnum">{timeOf(booking.depart_at)}</div>
                <div className="small muted">{dateOf(booking.depart_at)}</div>
              </div>
              <div style={{ paddingTop: '1.2rem', color: 'var(--muted)' }} aria-hidden="true">→</div>
              <div>
                <div className="small muted">To</div>
                <div style={{ fontWeight: 700, fontSize: '1.05rem' }}>{booking.destination}</div>
              </div>
            </div>

            <dl className="kv">
              <dt>Bus</dt><dd className="mono">{booking.registration}</dd>
              <dt>Seats</dt><dd className="mono">{booking.seats.join(', ')}</dd>
              <dt>Status</dt><dd><StatusPill status={booking.status} /></dd>
              <dt>Paid</dt><dd className="tnum">{taka(booking.total_poisha)}</dd>
              <dt>Booked</dt><dd>{dateTimeOf(booking.created_at)}</dd>
            </dl>
          </div>

          <div className="stack-sm" style={{ alignItems: 'center' }}>
            {booking.tickets[0]?.qr_token
              ? <QrCode value={booking.tickets[0].qr_token} />
              : <div className="qr-box" style={{ width: 148, height: 148 }}>
                  <span className="small muted center">Issued once payment clears</span>
                </div>}
            <span className="small muted">Show at boarding</span>
          </div>
        </div>

        <div className="ticket-perf" />

        <div className="card-pad">
          <div className="small muted" style={{ marginBottom: '.5rem' }}>
            One code per passenger — each seat scans separately.
          </div>
          <table className="data">
            <thead>
              <tr><th>Seat</th><th>Passenger</th><th>Status</th><th>Code</th></tr>
            </thead>
            <tbody>
              {booking.tickets.map((t) => (
                <tr key={t.seat_no}>
                  <td className="mono">{t.seat_no}</td>
                  <td>{t.passenger || <span className="muted">—</span>}</td>
                  <td><StatusPill status={t.status} /></td>
                  <td className="mono small" style={{ wordBreak: 'break-all', maxWidth: 200 }}>
                    {t.qr_token ? t.qr_token.slice(0, 22) + '…' : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="stack" style={{ marginTop: '1rem' }}>
        {booking.tickets.length > 1 && (
          <details className="card card-pad no-print">
            <summary style={{ cursor: 'pointer', fontWeight: 600 }}>
              Show a separate QR for each passenger
            </summary>
            <div className="row" style={{ gap: '1rem', marginTop: '.9rem', alignItems: 'flex-start' }}>
              {booking.tickets.filter((t) => t.qr_token).map((t) => (
                <div key={t.seat_no} className="stack-sm" style={{ alignItems: 'center' }}>
                  <QrCode value={t.qr_token} size={120} />
                  <span className="small"><strong className="mono">{t.seat_no}</strong> {t.passenger}</span>
                </div>
              ))}
            </div>
          </details>
        )}
      </div>
    </div>
  );
}
