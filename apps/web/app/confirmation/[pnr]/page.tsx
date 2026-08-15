'use client';

import { use, useEffect, useState } from 'react';
import Link from 'next/link';
import { api, ApiError, type Booking } from '@/lib/api';
import { ErrorNotice, Loading, Stepper, StatusPill } from '@/components/ui';
import { dateTimeOf, taka } from '@/lib/format';

export default function ConfirmationPage({ params }: { params: Promise<{ pnr: string }> }) {
  const { pnr } = use(params);
  const [booking, setBooking] = useState<Booking | null>(null);
  const [error, setError] = useState('');
  const [tries, setTries] = useState(0);

  // The webhook that issues tickets is asynchronous. Poll briefly rather than
  // claiming failure the instant the page loads ahead of the callback.
  useEffect(() => {
    let alive = true;
    const load = () => {
      api.booking(pnr)
        .then((b) => {
          if (!alive) return;
          setBooking(b);
          if (b.status !== 'TICKETED' && tries < 6) {
            setTimeout(() => setTries((t) => t + 1), 900);
          }
        })
        .catch((e: ApiError) => alive && setError(e.message));
    };
    load();
    return () => { alive = false; };
  }, [pnr, tries]);

  if (error) return <div className="page container-narrow"><ErrorNotice message={error} /></div>;
  if (!booking) return <div className="page container-narrow"><Loading rows={2} /></div>;

  const ticketed = booking.status === 'TICKETED';

  return (
    <div className="page container-narrow">
      <Stepper current="Ticket" />

      <div className="card card-pad stack" style={{ textAlign: 'center', alignItems: 'center' }}>
        <div aria-hidden="true" style={{
          width: 54, height: 54, borderRadius: '50%',
          background: ticketed ? 'var(--ok-tint)' : 'var(--warn-tint)',
          color: ticketed ? 'var(--ok)' : 'var(--warn)',
          display: 'grid', placeItems: 'center', fontSize: '1.6rem', fontWeight: 700,
        }}>
          {ticketed ? '✓' : '…'}
        </div>

        <h1 style={{ fontSize: '1.4rem' }}>
          {ticketed ? 'Booking confirmed' : 'Confirming your payment'}
        </h1>

        {ticketed ? (
          <p className="muted" style={{ marginBottom: 0 }}>
            We sent your ticket to {booking.phone}
            {booking.email ? ` and ${booking.email}` : ''}.
          </p>
        ) : (
          <p className="muted" style={{ marginBottom: 0 }}>
            Your provider is confirming the payment. This page updates itself —
            you do not need to pay again.
          </p>
        )}

        <div className="pnr">{booking.pnr}</div>
        <StatusPill status={booking.status} />

        <dl className="kv" style={{ textAlign: 'left', marginTop: '.5rem' }}>
          <dt>Operator</dt><dd>{booking.brand}</dd>
          <dt>Journey</dt><dd>{booking.origin} → {booking.destination}</dd>
          <dt>Departs</dt><dd>{dateTimeOf(booking.depart_at)}</dd>
          <dt>Seats</dt><dd className="mono">{booking.seats.join(', ')}</dd>
          <dt>Paid</dt><dd className="tnum">{taka(booking.total_poisha)}</dd>
        </dl>

        <div className="row" style={{ gap: '.5rem', justifyContent: 'center' }}>
          <Link className="btn btn-primary" href={`/tickets/${booking.pnr}`}>View ticket</Link>
          <Link className="btn btn-ghost" href={`/tracking/${booking.pnr}`}>Track bus</Link>
          <Link className="btn btn-ghost" href="/account">My trips</Link>
        </div>
      </div>
    </div>
  );
}
