'use client';

import { use, useEffect, useState } from 'react';
import { api, ApiError, type Booking, type CancellationQuote } from '@/lib/api';
import { ErrorNotice, Loading, StatusPill } from '@/components/ui';
import { Ref } from '@/components/Ref';
import { PickLink } from '@/components/Glyph';
import { useLang } from '@/components/LangProvider';

/**
 * One booking, and the four things anyone ever wants to do to it.
 *
 * The change that matters here is the cancellation panel. It used to print the
 * refund policy as a four-row table and leave the passenger to work out which
 * row they were standing in — from a departure time in one place and a
 * percentage in another. That is arithmetic under stress, and it is arithmetic
 * the server has already done: the quote endpoint returns the exact refund.
 *
 * So the table became a ladder with the passenger's own rung marked. The other
 * rungs stay visible, because someone deciding whether to cancel now or sleep
 * on it needs to see what sleeping on it costs — but nobody has to find
 * themselves in it.
 */

/** The published tiers. Ordered as time runs out, which is how they are lived. */
const TIERS = [
  { key: 'cx.tier24' as const, pct: 90, from: 24 },
  { key: 'cx.tier12' as const, pct: 70, from: 12 },
  { key: 'cx.tier6' as const,  pct: 50, from: 6 },
  { key: 'cx.tier0' as const,  pct: 0,  from: 0 },
];

export default function BookingPage({ params }: { params: Promise<{ pnr: string }> }) {
  const { pnr } = use(params);
  const { t, fmt } = useLang();

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
  const names = booking.tickets.map((x) => x.passenger).filter(Boolean);

  // Which rung the passenger is standing on, from the server's own hours figure
  // rather than a second clock in the browser.
  const hours = quote?.hours_before ?? 0;
  const hereIdx = TIERS.findIndex((tier) => hours >= tier.from);

  return (
    <div className="page container-narrow">
      <div className="row-between" style={{ marginBottom: '.3rem' }}>
        <h1 style={{ fontSize: '1.35rem', marginBottom: 0 }}>{t('mb.title')}</h1>
        <StatusPill status={booking.status} />
      </div>
      <p className="muted small" style={{ marginBottom: '1.1rem' }}>
        {t('find.label')} <Ref value={booking.pnr} copyable />
      </p>

      {done && (
        <div className={`notice ${done.refund_poisha > 0 ? 'notice-info' : 'notice-warn'}`}
             style={{ marginBottom: '1rem' }} role="status">
          <strong>{t('mb.cancelled')}</strong>{' '}
          {done.refund_poisha > 0
            ? t('mb.refundOnWay', { amount: fmt.taka(done.refund_poisha) })
            : t('mb.noRefundDue')}
        </div>
      )}

      <div className="stack">
        {/* ------------------------------------------------- what you bought */}
        <div className="card">
          <div className="card-head">{t('mb.trip')}</div>
          <div className="card-pad">
            <div style={{ fontSize: '1.15rem', fontWeight: 680, marginBottom: '.15rem' }}>
              {booking.origin} → {booking.destination}
            </div>
            <div className="muted" style={{ marginBottom: '.9rem' }}>
              {fmt.dateTime(booking.depart_at)}
            </div>
            <dl className="kv">
              <dt>{t('trip.operator')}</dt><dd>{booking.brand} · {booking.bus_type}</dd>
              <dt>{t('mb.bus')}</dt><dd><Ref value={booking.registration} /></dd>
              <dt>{t('mb.seats')}</dt><dd><Ref value={booking.seats.join(', ')} /></dd>
              {names.length > 0 && <><dt>{t('mb.passengers')}</dt><dd>{names.join(', ')}</dd></>}
              <dt>{t('mb.contact')}</dt>
              <dd><Ref value={booking.phone} />{booking.email ? ` · ${booking.email}` : ''}</dd>
              <dt>{t('mb.paid')}</dt>
              <dd className="tnum" style={{ fontWeight: 700 }}>{fmt.taka(booking.total_poisha)}</dd>
            </dl>
          </div>
        </div>

        {/* ------------------------------------------------- what you can do */}
        {/*
          Three full-width rows rather than a line of ghost buttons. Each says
          what happens if you tap it, because "Track bus" and "Manage booking"
          side by side is two pieces of jargon and no information.
        */}
        <div className="stack-sm">
          <PickLink href={`/tickets/${booking.pnr}`} glyph="ticket"
                    title={t('mb.viewTicket')} note={t('mb.viewTicketNote')} />
          <PickLink href={`/tracking/${booking.pnr}`} glyph="pin"
                    title={t('mb.track')} note={t('mb.trackNote')} />
          {active && (
            <PickLink href={`/manage/${booking.pnr}/reschedule`} glyph="clock"
                      title={t('mb.change')} note={t('mb.changeNote')} />
          )}
        </div>

        {/* ------------------------------------------------------ the refund */}
        {booking.refund && (
          <div className="card">
            <div className="card-head">{t('mb.refund')}</div>
            <div className="card-pad row-between">
              <div className="moneyline is-back">
                <span className="m-what"><StatusPill status={booking.refund.status} /></span>
                <span className="m-amount">{fmt.taka(booking.refund.amount_poisha)}</span>
              </div>
              {booking.refund.status === 'REQUESTED' && (
                <div style={{ textAlign: 'right', maxWidth: 260 }}>
                  <p className="small muted" style={{ marginBottom: '.4rem' }}>
                    {t('mb.refundWait')}
                  </p>
                  {/*
                    A development control, kept because there is no real provider
                    to wait for in this build — labelled as one rather than
                    dressed as something a passenger would press.
                  */}
                  <button className="btn btn-ghost btn-sm" onClick={settle} disabled={busy}>
                    {t('mb.settleDemo')}
                  </button>
                </div>
              )}
            </div>
          </div>
        )}

        {/* ------------------------------------------------- the way out */}
        {active && quote && (
          <div className="card">
            <div className="card-head">{t('cx.title')}</div>
            <div className="card-pad stack">
              {quote.cancellable ? (
                <>
                  <div className="row-between" style={{ alignItems: 'flex-end' }}>
                    <div className="moneyline is-back" data-testid="refund-quote">
                      <span className="m-what">{t('cx.youGetBack')}</span>
                      <span className="m-amount">{fmt.taka(quote.refund_poisha)}</span>
                      <span className="m-what">
                        {t('cx.ofWhatYouPaid', {
                          pct: quote.refund_pct,
                          total: fmt.taka(quote.total_poisha),
                        })}
                        {quote.fee_poisha > 0
                          ? ` · ${t('cx.charge', { amount: fmt.taka(quote.fee_poisha) })}`
                          : ''}
                      </span>
                    </div>
                    {!confirming && (
                      <button className="btn btn-danger" onClick={() => setConfirming(true)}>
                        {t('cx.start')}
                      </button>
                    )}
                  </div>

                  {/*
                    The ladder. `is-here` is the rung the server says they are on;
                    the rungs above are marked spent, because that money is
                    already gone and pretending otherwise would be a lie of
                    omission when they are choosing whether to act now.
                  */}
                  <div>
                    <div className="label" style={{ marginBottom: '.4rem' }}>{t('cx.ladder')}</div>
                    <div className="ladder">
                      {TIERS.map((tier, i) => (
                        <div
                          key={tier.key}
                          className={`ladder-rung${i === hereIdx ? ' is-here' : ''}${i < hereIdx ? ' is-gone' : ''}`}
                        >
                          <span className="r-when">{t(tier.key)}</span>
                          {i === hereIdx && <span className="ladder-tag">{t('cx.youAreHere')}</span>}
                          <span className="r-gets">
                            {tier.pct > 0 ? `${tier.pct}%` : t('cx.nothing')}
                          </span>
                        </div>
                      ))}
                    </div>
                    <p className="hint" style={{ marginTop: '.4rem' }}>
                      {t('cx.hoursLeft', { hours: Math.round(quote.hours_before) })}
                    </p>
                  </div>

                  {/*
                    Confirmation names the consequence. "Yes, cancel" on its own
                    asks someone to commit to an irreversible thing without ever
                    having been told it is irreversible.
                  */}
                  {confirming && (
                    <div className="notice notice-danger stack-sm" role="alertdialog" aria-label={t('cx.confirmQ')}>
                      <strong>{t('cx.confirmQ')}</strong>
                      <span>{t('cx.confirmBody')}</span>
                      <div className="row" style={{ gap: '.5rem', marginTop: '.3rem' }}>
                        <button className="btn btn-danger btn-sm" onClick={cancel} disabled={busy}>
                          {busy ? t('cx.working') : t('cx.confirm')}
                        </button>
                        <button className="btn btn-ghost btn-sm" onClick={() => setConfirming(false)} disabled={busy}>
                          {t('cx.keep')}
                        </button>
                      </div>
                    </div>
                  )}
                </>
              ) : (
                <p className="muted" style={{ marginBottom: 0 }}>
                  {quote.reason ?? t('cx.notPossible')}
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
