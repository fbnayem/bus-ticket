'use client';

import { use, useEffect, useState } from 'react';
import Link from 'next/link';
import { api, ApiError, type Booking } from '@/lib/api';
import { QrCode } from '@/components/QrCode';
import { Ref } from '@/components/Ref';
import { ErrorNotice, Loading, StatusPill } from '@/components/ui';
import { useLang, useT } from '@/components/LangProvider';
import { errorText, STRINGS, type Key } from '@/lib/i18n';
import { recallTicket, rememberTicket } from '@/lib/offlineTickets';
import { TicketOffline } from '@/components/TicketOffline';

export default function TicketPage({ params }: { params: Promise<{ pnr: string }> }) {
  const { pnr } = use(params);
  const t = useT();
  const { fmt } = useLang();
  const [booking, setBooking] = useState<Booking | null>(null);
  const [fromDevice, setFromDevice] = useState(false);
  const [error, setError] = useState('');

  // The device first, the platform second — the same order the app uses, and
  // for the same reason. This page is read at a bus door, which is exactly
  // where there is no signal, and the homepage promises in both languages that
  // it works there. It used to fetch and then show an error, so the promise was
  // kept by the app and broken by the website making it.
  //
  // Reading the cached copy is not a shortcut past the platform: the fetch
  // still runs, the fresh answer replaces what is drawn, and it is written back
  // so a cancellation seen once is remembered. What changes is only what
  // happens when the fetch cannot finish.
  useEffect(() => {
    const cached = recallTicket(pnr);
    if (cached) {
      setBooking(cached);
      setFromDevice(true);
    }
    api.booking(pnr)
      .then((b) => {
        setBooking(b);
        setFromDevice(false);
        rememberTicket(b);
      })
      .catch((e: ApiError) => {
        // A copy in hand outranks a refusal. Only say nothing when we have
        // nothing — this device has never seen this ticket.
        if (!cached) setError(errorText(t, e));
      });
    // `t` is stable for a given language and is not a reason to refetch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pnr]);

  if (error) return <div className="page container-narrow"><ErrorNotice message={error} /></div>;
  if (!booking) return <div className="page container-narrow"><Loading rows={2} /></div>;

  const cancelled = ['CANCELLED', 'REFUNDED', 'REFUND_PENDING'].includes(booking.status);
  const statusKey = `status.${booking.status}` as Key;
  const statusWord = statusKey in STRINGS ? t(statusKey) : booking.status;

  return (
    <div className="page container-narrow">
      <div className="row-between no-print" style={{ marginBottom: '1rem' }}>
        <h1 style={{ fontSize: '1.3rem' }}>{t('ticket.title')}</h1>
        <div className="row" style={{ gap: '.4rem' }}>
          <button className="btn btn-ghost btn-sm" onClick={() => window.print()}>{t('ticket.print')}</button>
          <Link className="btn btn-ghost btn-sm" href={`/tracking/${booking.pnr}`}>{t('ticket.track')}</Link>
          <Link className="btn btn-ghost btn-sm" href={`/manage/${booking.pnr}`}>{t('ticket.manage')}</Link>
        </div>
      </div>

      {cancelled && (
        <div className="notice notice-danger" style={{ marginBottom: '1rem' }}>
          {t('ticket.wontScan', { status: statusWord })}
        </div>
      )}

      {/* A voided ticket is overprinted rather than merely captioned — the one
          place in the system where colour is drawn across content. */}
      <div className={`ticket${cancelled ? ' is-void' : ''}`}>
        <div className="ticket-head">
          <div className="row-between">
            <div>
              <div className="ticket-eyebrow">{t('ticket.bookingRef')}</div>
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
                <div className="small muted">{t('ticket.from')}</div>
                <div style={{ fontWeight: 700, fontSize: '1.05rem' }}>{booking.origin}</div>
                <div className="mono tnum">{fmt.time(booking.depart_at)}</div>
                <div className="small muted">{fmt.date(booking.depart_at)}</div>
              </div>
              <div style={{ paddingTop: '1.2rem', color: 'var(--muted)' }} aria-hidden="true">→</div>
              <div>
                <div className="small muted">{t('ticket.to')}</div>
                <div style={{ fontWeight: 700, fontSize: '1.05rem' }}>{booking.destination}</div>
              </div>
            </div>

            <dl className="kv">
              <dt>{t('ticket.bus')}</dt><dd><Ref value={booking.registration} /></dd>
              <dt>{t('ticket.seats')}</dt><dd className="mono">{booking.seats.join(', ')}</dd>
              <dt>{t('ticket.status')}</dt><dd><StatusPill status={booking.status} /></dd>
              <dt>{t('money.paid')}</dt><dd className="tnum">{fmt.taka(booking.total_poisha)}</dd>
              <dt>{t('ticket.booked')}</dt><dd>{fmt.dateTime(booking.created_at)}</dd>
            </dl>
          </div>

          <div className="stack-sm" style={{ alignItems: 'center' }}>
            {booking.tickets[0]?.qr_token
              ? <QrCode value={booking.tickets[0].qr_token} />
              : <div className="qr-box" style={{ width: 148, height: 148 }}>
                  <span className="small muted center">{t('ticket.issuedOnPay')}</span>
                </div>}
            <span className="small muted">{t('ticket.showAtGate')}</span>
            <TicketOffline fromDevice={fromDevice} />
          </div>
        </div>

        <div className="ticket-perf" />

        <div className="card-pad">
          <div className="small muted" style={{ marginBottom: '.5rem' }}>
            {t('ticket.perPassenger')}
          </div>
          <table className="data">
            <thead>
              <tr>
                <th>{t('ticket.seat')}</th>
                <th>{t('ticket.passenger')}</th>
                <th>{t('ticket.status')}</th>
                <th>{t('ticket.code')}</th>
              </tr>
            </thead>
            <tbody>
              {booking.tickets.map((tk) => (
                <tr key={tk.seat_no}>
                  <td className="mono">{tk.seat_no}</td>
                  <td>{tk.passenger || <span className="muted">—</span>}</td>
                  <td><StatusPill status={tk.status} /></td>
                  <td className="small" style={{ maxWidth: 190 }}>
                    {/* Both ends of the token, not the first 22 characters of
                        an HMAC — the tail is the part that differs. */}
                    <Ref value={tk.qr_token} truncate={13} copyable />
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
              {t('ticket.separateQr')}
            </summary>
            <div className="row" style={{ gap: '1rem', marginTop: '.9rem', alignItems: 'flex-start' }}>
              {booking.tickets.filter((tk) => tk.qr_token).map((tk) => (
                <div key={tk.seat_no} className="stack-sm" style={{ alignItems: 'center' }}>
                  <QrCode value={tk.qr_token} size={120} />
                  <span className="small"><strong className="mono">{tk.seat_no}</strong> {tk.passenger}</span>
                </div>
              ))}
            </div>
          </details>
        )}
      </div>
    </div>
  );
}
