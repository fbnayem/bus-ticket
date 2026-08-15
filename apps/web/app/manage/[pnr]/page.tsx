'use client';

import { use, useEffect, useState } from 'react';
import Link from 'next/link';
import { api, ApiError, type Booking, type CancellationQuote } from '@/lib/api';
import { ErrorNotice, Loading, StatusPill } from '@/components/ui';
import { dateTimeOf, taka } from '@/lib/format';

export default function ManageBookingPage({ params }: { params: Promise<{ pnr: string }> }) {
  const { pnr } = use(params);

  const [booking, setBooking] = useState<Booking | null>(null);
  const [quote, setQuote] = useState<CancellationQuote | null>(null);
  const [error, setError] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<CancellationQuote | null>(null);

  const load = () => {
    api.booking(pnr).then(setBooking).catch((e: ApiError) => setError(e.message));
    api.cancellationQuote(pnr).then(setQuote).catch(() => {});
  };
  useEffect(load, [pnr]);

  const cancel = async () => {
    setBusy(true);
    setError('');
    try {
      const res = await api.cancel(pnr, 'Cancelled by passenger');
      setDone(res);
      setConfirming(false);
      load();
    } catch (e) {
      setError((e as ApiError).message);
    } finally {
      setBusy(false);
    }
  };

  const settle = async () => {
    setBusy(true);
    try { await api.settleRefund(pnr); load(); }
    catch (e) { setError((e as ApiError).message); }
    finally { setBusy(false); }
  };

  if (error && !booking) return <div className="page container-narrow"><ErrorNotice message={error} /></div>;
  if (!booking) return <div className="page container-narrow"><Loading rows={2} /></div>;

  const active = ['TICKETED', 'CONFIRMED'].includes(booking.status);

  return (
    <div className="page container-narrow">
      <div className="row-between" style={{ marginBottom: '1rem' }}>
        <div>
          <h1 style={{ fontSize: '1.3rem' }}>Booking <span className="mono">{booking.pnr}</span></h1>
          <p className="muted small" style={{ margin: 0 }}>
            {booking.brand} · {booking.origin} → {booking.destination} · {dateTimeOf(booking.depart_at)}
          </p>
        </div>
        <StatusPill status={booking.status} />
      </div>

      {done && (
        <div className="notice notice-info" style={{ marginBottom: '1rem' }}>
          Cancelled. {done.refund_poisha > 0
            ? <>A refund of <strong>{taka(done.refund_poisha)}</strong> ({done.refund_pct}% of {taka(done.total_poisha)}) is being processed.</>
            : <>No refund is due under the policy for this departure time.</>}
        </div>
      )}

      <div className="stack">
        <div className="card">
          <div className="card-head">Trip</div>
          <div className="card-pad">
            <dl className="kv">
              <dt>Operator</dt><dd>{booking.brand} · {booking.bus_type}</dd>
              <dt>Bus</dt><dd className="mono">{booking.registration}</dd>
              <dt>Seats</dt><dd className="mono">{booking.seats.join(', ')}</dd>
              <dt>Passengers</dt>
              <dd>{booking.tickets.map((t) => t.passenger).filter(Boolean).join(', ') || '—'}</dd>
              <dt>Contact</dt><dd>{booking.phone}{booking.email ? ` · ${booking.email}` : ''}</dd>
              <dt>Total paid</dt><dd className="tnum">{taka(booking.total_poisha)}</dd>
            </dl>
          </div>
        </div>

        <div className="row" style={{ gap: '.5rem' }}>
          <Link className="btn btn-brand" href={`/tickets/${booking.pnr}`}>View ticket</Link>
          <Link className="btn btn-ghost" href={`/tracking/${booking.pnr}`}>Track bus</Link>
          {active && (
            <Link className="btn btn-ghost" href={`/manage/${booking.pnr}/reschedule`}>
              Change departure
            </Link>
          )}
        </div>

        {booking.refund && (
          <div className="card">
            <div className="card-head">Refund</div>
            <div className="card-pad row-between">
              <div>
                <div className="tnum" style={{ fontSize: '1.2rem', fontWeight: 700 }}>
                  {taka(booking.refund.amount_poisha)}
                </div>
                <StatusPill status={booking.refund.status} />
              </div>
              {booking.refund.status === 'REQUESTED' && (
                <div style={{ textAlign: 'right' }}>
                  <p className="small muted" style={{ marginBottom: '.4rem' }}>
                    Normally settled by your provider within 3–7 working days.
                  </p>
                  <button className="btn btn-ghost btn-sm" onClick={settle} disabled={busy}>
                    Simulate provider settlement
                  </button>
                </div>
              )}
            </div>
          </div>
        )}

        {active && quote && (
          <div className="card">
            <div className="card-head">Cancel this booking</div>
            <div className="card-pad stack">
              {quote.cancellable ? (
                <>
                  <div className="row-between">
                    <div>
                      <div className="small muted">
                        {quote.hours_before.toFixed(0)} hours before departure — {quote.refund_pct}% refundable
                      </div>
                      <div className="tnum" style={{ fontSize: '1.25rem', fontWeight: 700 }}>
                        {taka(quote.refund_poisha)} back
                      </div>
                      {quote.fee_poisha > 0 && (
                        <div className="small muted">{taka(quote.fee_poisha)} cancellation charge</div>
                      )}
                    </div>
                    {!confirming ? (
                      <button className="btn btn-danger" onClick={() => setConfirming(true)}>
                        Cancel booking
                      </button>
                    ) : (
                      <div className="row" style={{ gap: '.4rem' }}>
                        <button className="btn btn-ghost btn-sm" onClick={() => setConfirming(false)} disabled={busy}>
                          Keep it
                        </button>
                        <button className="btn btn-danger btn-sm" onClick={cancel} disabled={busy}>
                          {busy ? 'Cancelling…' : 'Yes, cancel'}
                        </button>
                      </div>
                    )}
                  </div>

                  <table className="data">
                    <thead><tr><th>Cancelled</th><th>You get back</th></tr></thead>
                    <tbody>
                      <tr><td>24 hours or more before departure</td><td>90%</td></tr>
                      <tr><td>12 – 24 hours before</td><td>70%</td></tr>
                      <tr><td>6 – 12 hours before</td><td>50%</td></tr>
                      <tr><td>Under 6 hours</td><td>No refund</td></tr>
                    </tbody>
                  </table>
                </>
              ) : (
                <p className="muted" style={{ marginBottom: 0 }}>
                  {quote.reason ?? 'This booking can no longer be cancelled.'}
                </p>
              )}
            </div>
          </div>
        )}

        {error && <ErrorNotice message={error} />}
      </div>
    </div>
  );
}
