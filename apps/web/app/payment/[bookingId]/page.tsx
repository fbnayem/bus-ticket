'use client';

import { Suspense, use, useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { api, ApiError, type Booking } from '@/lib/api';
import { ErrorNotice, Loading, Stepper } from '@/components/ui';
import { dateTimeOf, taka } from '@/lib/format';

const PROVIDERS = [
  { id: 'BKASH', name: 'bKash', note: 'Mobile wallet', color: '#E2136E' },
  { id: 'NAGAD', name: 'Nagad', note: 'Mobile wallet', color: '#EE7623' },
  { id: 'CARD', name: 'Card', note: 'Visa / Mastercard', color: '#1A1F71' },
  { id: 'BANK', name: 'Bank', note: 'Internet banking', color: '#0B6E4F' },
];

function Payment({ bookingId }: { bookingId: string }) {
  const params = useSearchParams();
  const router = useRouter();
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
          <h1 style={{ fontSize: '1.2rem' }}>This booking is already {booking.status.toLowerCase().replace(/_/g, ' ')}</h1>
          <a className="btn btn-brand" href={`/tickets/${booking.pnr}`}>View ticket</a>
        </div>
      </div>
    );
  }

  return (
    <div className="page container-narrow">
      <Stepper current="Payment" />

      <div className="card" style={{ marginBottom: '1rem' }}>
        <div className="card-head">Pay for booking {pnr && <span className="mono">{pnr}</span>}</div>
        <div className="card-pad stack">
          {booking && (
            <>
              <div className="row-between">
                <div>
                  <strong>{booking.brand}</strong>
                  <div className="small muted">
                    {booking.origin} → {booking.destination} · {dateTimeOf(booking.depart_at)}
                  </div>
                  <div className="small muted">
                    Seats {booking.seats.join(', ')}
                  </div>
                </div>
                <div className="trip-price tnum">{taka(booking.total_poisha)}</div>
              </div>
              <hr style={{ border: 0, borderTop: '1px solid var(--line)', margin: '.2rem 0' }} />
            </>
          )}

          <fieldset style={{ border: 0, padding: 0, margin: 0 }}>
            <legend className="label" style={{ marginBottom: '.5rem' }}>Choose how to pay</legend>
            <div className="stack-sm">
              {PROVIDERS.map((p) => (
                <label key={p.id} className="card card-pad row"
                       style={{
                         cursor: 'pointer', gap: '.7rem', padding: '.7rem .85rem',
                         borderColor: provider === p.id ? 'var(--brand)' : 'var(--line)',
                         background: provider === p.id ? 'var(--brand-tint)' : 'var(--surface)',
                       }}>
                  <input type="radio" name="provider" value={p.id}
                         checked={provider === p.id} onChange={() => setProvider(p.id)} />
                  <span aria-hidden="true" style={{
                    width: 30, height: 30, borderRadius: 6, background: p.color,
                    display: 'grid', placeItems: 'center', color: '#fff', fontWeight: 700, fontSize: '.72rem',
                  }}>{p.name[0]}</span>
                  <span>
                    <strong>{p.name}</strong>
                    <span className="small muted" style={{ display: 'block' }}>{p.note}</span>
                  </span>
                </label>
              ))}
            </div>
          </fieldset>

          {error && <ErrorNotice message={error} />}

          <button className="btn btn-primary btn-lg btn-block" onClick={pay} disabled={busy}>
            {busy ? 'Opening payment…' : booking ? `Pay ${taka(booking.total_poisha)}` : 'Continue to pay'}
          </button>

          <p className="small muted" style={{ margin: 0 }}>
            Your booking is only confirmed once your provider tells us the payment
            succeeded — not when this page loads. If anything goes wrong, your seats
            are released and you are not charged.
          </p>
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
