'use client';

import { use, useEffect, useState } from 'react';
import Link from 'next/link';
import { api, ApiError, type Booking } from '@/lib/api';
import { ErrorNotice, Loading, Stepper, StatusPill } from '@/components/ui';
import { useLang, useT } from '@/components/LangProvider';

export default function ConfirmationPage({ params }: { params: Promise<{ pnr: string }> }) {
  const { pnr } = use(params);
  const t = useT();
  const { fmt } = useLang();
  const [booking, setBooking] = useState<Booking | null>(null);
  const [error, setError] = useState('');
  const [tries, setTries] = useState(0);

  // The webhook that issues tickets is asynchronous. Poll briefly rather than
  // claiming failure the instant the page loads ahead of the callback.
  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = () => {
      api.booking(pnr)
        .then((b) => {
          if (!alive) return;
          setBooking(b);
          if (b.status !== 'TICKETED' && tries < 6) {
            timer = setTimeout(() => setTries((n) => n + 1), 900);
          }
        })
        .catch((e: ApiError) => alive && setError(e.message));
    };
    load();
    return () => { alive = false; if (timer) clearTimeout(timer); };
  }, [pnr, tries]);

  if (error) return <div className="page container-narrow"><ErrorNotice message={error} /></div>;
  if (!booking) return <div className="page container-narrow"><Loading rows={2} /></div>;

  const ticketed = booking.status === 'TICKETED';
  const to = [booking.phone, booking.email].filter(Boolean).join(', ');

  return (
    <div className="page container-narrow">
      <Stepper current="Ticket" />

      <div className="card card-pad stack" style={{ textAlign: 'center', alignItems: 'center' }}>
        {/*
          Waiting is NOT a warning. This mark used to be amber, which told a
          passenger something might be wrong with their money at the precise
          moment the honest message is "the provider has not called us back
          yet". In-flight periwinkle says unresolved without saying failed.
        */}
        <div
          aria-hidden="true"
          className={`verdict-mark ${ticketed ? 'is-ok' : 'is-inflight'}`}
        >
          {ticketed ? '✓' : '···'}
        </div>

        <h1 style={{ fontSize: '1.4rem' }}>
          {ticketed ? t('confirm.done') : t('confirm.waiting')}
        </h1>

        <p className="muted" style={{ marginBottom: 0 }}>
          {ticketed ? t('confirm.sentTo', { to }) : t('confirm.stillWaiting')}
        </p>

        <div className="pnr">{booking.pnr}</div>
        <StatusPill status={booking.status} />

        <dl className="kv" style={{ textAlign: 'left', marginTop: '.5rem' }}>
          <dt>{t('trip.operator')}</dt><dd>{booking.brand}</dd>
          <dt>{t('confirm.journey')}</dt><dd>{booking.origin} → {booking.destination}</dd>
          {/* board_at is this passenger's own pickup time, which is depart_at
              only when they board at the origin; a mid-route boarder must see
              when the bus reaches THEIR stop. */}
          <dt>{t('trip.departs')}</dt><dd>{fmt.dateTime(booking.board_at)}</dd>
          <dt>{t('ticket.seats')}</dt><dd className="mono">{booking.seats.join(', ')}</dd>
          {/* Only called "paid" once the money is actually confirmed. */}
          <dt>{ticketed ? t('money.paid') : t('money.total')}</dt>
          <dd className="tnum">{fmt.taka(booking.total_poisha)}</dd>
        </dl>

        <div className="row" style={{ gap: '.5rem', justifyContent: 'center' }}>
          <Link className="btn btn-primary" href={`/tickets/${booking.pnr}`}>{t('ticket.view')}</Link>
          <Link className="btn btn-ghost" href={`/tracking/${booking.pnr}`}>{t('confirm.trackBus')}</Link>
          <Link className="btn btn-ghost" href="/account">{t('confirm.myTrips')}</Link>
        </div>
      </div>
    </div>
  );
}
