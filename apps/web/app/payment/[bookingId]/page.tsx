'use client';

import { Suspense, use, useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { api, ApiError, type Booking } from '@/lib/api';
import { ErrorNotice, Loading, Stepper, StatusPill } from '@/components/ui';
import { useLang, useT } from '@/components/LangProvider';
import type { Key } from '@/lib/i18n';

/**
 * The fare board.
 *
 * bKash and Nagad are two of the most recognised commercial marks in
 * Bangladesh, and this screen used to render them as a 30px coloured square
 * containing the letters "b" and "N" — so a first-time passenger could not
 * pattern-match the brand they trust and had to read English words instead.
 *
 * Each provider now gets its wordmark at a size that reads, in its own colour,
 * on a full-width plate. The colours live in --provider-* tokens quarantined
 * from the semantic palette, so an orange Nagad tile can never be mistaken for
 * a warning.
 */
const PROVIDERS: { id: string; name: string; note: Key; token: string; ink: string }[] = [
  { id: 'BKASH', name: 'bKash', note: 'pay.wallet',    token: 'var(--provider-bkash)', ink: '#fff' },
  { id: 'NAGAD', name: 'Nagad', note: 'pay.wallet',    token: 'var(--provider-nagad)', ink: '#fff' },
  { id: 'CARD',  name: 'Card',  note: 'pay.cardNote',  token: '#1A1F71',               ink: '#fff' },
  { id: 'BANK',  name: 'Bank',  note: 'pay.bankNote',  token: 'var(--field)',          ink: '#fff' },
];

function Payment({ bookingId }: { bookingId: string }) {
  const params = useSearchParams();
  const router = useRouter();
  const t = useT();
  const { fmt } = useLang();
  const pnr = params.get('pnr') ?? '';

  const [booking, setBooking] = useState<Booking | null>(null);
  const [provider, setProvider] = useState('BKASH');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!pnr) { setLoading(false); return; }
    api.booking(pnr)
      .then(setBooking)
      .catch((e: ApiError) => setError(e.message))
      .finally(() => setLoading(false));
  }, [pnr]);

  const pay = async () => {
    setBusy(true);
    setError('');
    try {
      const intent = await api.paymentIntent(bookingId, provider);
      // In production this is a redirect to the provider's hosted checkout.
      router.push(`/payment/sandbox?ref=${encodeURIComponent(intent.payment_ref)}&pnr=${intent.pnr}`);
    } catch (e) {
      setError((e as ApiError).message);
      setBusy(false);
    }
  };

  if (loading) return <div className="page container"><Loading rows={2} /></div>;

  if (booking && booking.status !== 'PAYMENT_PENDING') {
    return (
      <div className="page container-narrow">
        <div className="card card-pad stack">
          <h1 style={{ fontSize: '1.2rem' }}>{t('pay.forBooking')}</h1>
          <div className="row"><StatusPill status={booking.status} /></div>
          <Link className="btn btn-brand" href={`/tickets/${booking.pnr}`}>{t('ticket.view')}</Link>
        </div>
      </div>
    );
  }

  const amount = booking ? fmt.taka(booking.total_poisha) : '';

  return (
    <div className="page container-narrow">
      <Stepper current="Payment" />

      <div className="card" style={{ marginBottom: '1rem' }}>
        <div className="card-head">
          {t('pay.forBooking')} {pnr && <span className="mono">{pnr}</span>}
        </div>
        <div className="card-pad stack">
          {booking && (
            <div className="row-between">
              <div>
                <strong>{booking.brand}</strong>
                <div className="small muted">
                  {booking.origin} → {booking.destination} · {fmt.dateTime(booking.depart_at)}
                </div>
                <div className="small muted">
                  {t('ticket.seats')} {booking.seats.join(', ')}
                </div>
              </div>
              <div className="br-fare">{amount}</div>
            </div>
          )}

          <fieldset className="fareboard">
            <legend className="label">{t('pay.chooseHow')}</legend>
            {PROVIDERS.map((p) => (
              <label key={p.id} className="fare-plate" data-selected={provider === p.id}>
                <input type="radio" name="provider" value={p.id}
                       checked={provider === p.id} onChange={() => setProvider(p.id)} />
                <span className="fare-mark" style={{ background: p.token, color: p.ink }} aria-hidden="true">
                  {p.name}
                </span>
                <span className="fare-name">
                  <strong>{p.name}</strong>
                  <span className="small muted">{t(p.note)}</span>
                </span>
                {/* Every plate repeats the amount. A "Continue to pay" button
                    with no price attached to the method becomes unwritable. */}
                {amount && <span className="fare-amount">{amount}</span>}
              </label>
            ))}
          </fieldset>

          {error && <ErrorNotice message={error} />}

          <button className="btn btn-primary btn-lg btn-block" onClick={pay} disabled={busy || !booking}>
            {busy ? t('pay.opening') : t('pay.pay', { amount })}
          </button>

          <p className="small muted" style={{ margin: 0 }}>{t('pay.safety')}</p>
        </div>
      </div>
    </div>
  );
}

export default function PaymentPage({ params }: { params: Promise<{ bookingId: string }> }) {
  const { bookingId } = use(params);
  return (
    <Suspense fallback={<div className="page container"><Loading rows={2} /></div>}>
      <Payment bookingId={bookingId} />
    </Suspense>
  );
}
