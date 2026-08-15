'use client';

import { Suspense, useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { api, ApiError, type Hold, type Passenger, type SavedPassenger, type Trip } from '@/lib/api';
import { ErrorNotice, HoldCountdown, Loading, Stepper } from '@/components/ui';
import { dateTimeOf, taka } from '@/lib/format';

function Checkout() {
  const params = useSearchParams();
  const router = useRouter();
  const holdId = params.get('hold') ?? '';

  const [hold, setHold] = useState<Hold | null>(null);
  const [trip, setTrip] = useState<Trip | null>(null);
  const [saved, setSaved] = useState<SavedPassenger[]>([]);
  const [passengers, setPassengers] = useState<Passenger[]>([]);
  const [phone, setPhone] = useState('+8801700000000');
  const [email, setEmail] = useState('');
  const [coupon, setCoupon] = useState('');
  const [expired, setExpired] = useState(false);
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const cached = sessionStorage.getItem('jatra.hold');
    if (cached) {
      try {
        const { hold: h, trip: t } = JSON.parse(cached) as { hold: Hold; trip: Trip };
        if (h.hold_id === holdId) {
          setHold(h);
          setTrip(t);
          setPassengers(h.seats.map((s) => ({ seat_no: s, full_name: '', gender: '', age: undefined })));
          setLoading(false);
        }
      } catch { /* fall through to the API */ }
    }
    // Always confirm against the server — sessionStorage is a convenience,
    // never the authority on whether the hold is still alive.
    api.getHold(holdId)
      .then((h) => {
        if (h.status !== 'HELD' || h.expired) setExpired(true);
        setPassengers((prev) => prev.length ? prev : h.seats.map((s) => ({ seat_no: s, full_name: '' })));
      })
      .catch((e: ApiError) => setError(e.message))
      .finally(() => setLoading(false));

    api.savedPassengers().then((r) => setSaved(r.passengers)).catch(() => {});
  }, [holdId]);

  const update = (i: number, patch: Partial<Passenger>) =>
    setPassengers((prev) => prev.map((p, idx) => (idx === i ? { ...p, ...patch } : p)));

  const usesSaved = (i: number, id: string) => {
    const s = saved.find((x) => x.id === id);
    if (s) update(i, { full_name: s.full_name, gender: s.gender, age: s.age });
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (passengers.some((p) => !p.full_name.trim())) {
      setError('Enter a name for every passenger.');
      return;
    }
    setSubmitting(true);
    setError('');
    try {
      const booking = await api.createBooking({
        hold_id: holdId,
        passengers,
        phone,
        email: email || undefined,
        coupon_code: coupon.trim().toUpperCase() || undefined,
      });
      sessionStorage.removeItem('jatra.hold');
      router.push(`/payment/${booking.booking_id}?pnr=${booking.pnr}`);
    } catch (err) {
      const e2 = err as ApiError;
      setError(e2.message);
      if (e2.code === 'hold_expired' || e2.code === 'hold_not_found') setExpired(true);
      setSubmitting(false);
    }
  };

  if (loading) return <div className="page container"><Loading rows={3} /></div>;

  if (expired) {
    return (
      <div className="page container-narrow">
        <Stepper current="Passengers" />
        <div className="card card-pad stack">
          <h1 style={{ fontSize: '1.2rem' }}>Your seat hold expired</h1>
          <p className="muted" style={{ marginBottom: 0 }}>
            Seats are only held for 10 minutes so they do not sit idle while someone else wants them.
            Nothing was charged.
          </p>
          <Link className="btn btn-primary" href={trip ? `/trips/${trip.trip_id}?board=${trip.board_seq}&drop=${trip.drop_seq}` : '/search'}>
            Choose seats again
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="page">
      <div className="container">
        <Stepper current="Passengers" />

        <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr) 340px', gap: '1.25rem', alignItems: 'start' }}
             className="checkout-layout">
          <form className="stack" onSubmit={submit}>
            <div className="card">
              <div className="card-head row-between">
                <span>Passenger details</span>
                {hold && (
                  <span className="small">
                    Held for <HoldCountdown expiresAt={hold.expires_at} onExpire={() => setExpired(true)} />
                  </span>
                )}
              </div>
              <div className="card-pad stack">
                {passengers.map((p, i) => (
                  <fieldset key={p.seat_no} style={{ border: '1px solid var(--line)', borderRadius: 'var(--radius-sm)', padding: '.85rem' }}>
                    <legend className="small" style={{ padding: '0 .4rem', color: 'var(--muted)' }}>
                      Seat <strong className="mono">{p.seat_no}</strong>
                    </legend>

                    {saved.length > 0 && (
                      <div className="field" style={{ marginBottom: '.6rem' }}>
                        <label className="label" htmlFor={`saved-${i}`}>Use a saved passenger</label>
                        <select id={`saved-${i}`} className="select" defaultValue=""
                                onChange={(e) => usesSaved(i, e.target.value)}>
                          <option value="">Enter details manually</option>
                          {saved.map((s) => <option key={s.id} value={s.id}>{s.full_name}</option>)}
                        </select>
                      </div>
                    )}

                    <div className="grid-2">
                      <div className="field">
                        <label className="label" htmlFor={`name-${i}`}>Full name</label>
                        <input id={`name-${i}`} className="input" required value={p.full_name}
                               onChange={(e) => update(i, { full_name: e.target.value })}
                               placeholder="As printed on your NID" />
                      </div>
                      <div className="grid-2">
                        <div className="field">
                          <label className="label" htmlFor={`gender-${i}`}>Gender</label>
                          <select id={`gender-${i}`} className="select" value={p.gender ?? ''}
                                  onChange={(e) => update(i, { gender: e.target.value })}>
                            <option value="">—</option>
                            <option value="M">Male</option>
                            <option value="F">Female</option>
                            <option value="X">Other</option>
                          </select>
                        </div>
                        <div className="field">
                          <label className="label" htmlFor={`age-${i}`}>Age</label>
                          <input id={`age-${i}`} className="input" type="number" min={0} max={120}
                                 value={p.age ?? ''} onChange={(e) => update(i, { age: Number(e.target.value) || undefined })} />
                        </div>
                      </div>
                    </div>
                  </fieldset>
                ))}
              </div>
            </div>

            <div className="card">
              <div className="card-head">Contact</div>
              <div className="card-pad grid-2">
                <div className="field">
                  <label className="label" htmlFor="phone">Mobile number</label>
                  <input id="phone" className="input" required value={phone}
                         onChange={(e) => setPhone(e.target.value)} placeholder="+8801XXXXXXXXX" />
                  <span className="hint">We send your ticket and any trip updates here.</span>
                </div>
                <div className="field">
                  <label className="label" htmlFor="email">Email (optional)</label>
                  <input id="email" className="input" type="email" value={email}
                         onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" />
                </div>
              </div>
            </div>

            {error && <ErrorNotice message={error} />}

            <button className="btn btn-primary btn-lg" type="submit" disabled={submitting}>
              {submitting ? 'Creating booking…' : 'Continue to payment'}
            </button>
          </form>

          <aside className="card" style={{ position: 'sticky', top: 'calc(var(--header-h) + 1rem)' }}>
            <div className="card-head">Trip summary</div>
            <div className="card-pad stack">
              {trip && (
                <div>
                  <strong>{trip.brand}</strong>
                  <div className="small muted">{trip.bus_type} · {dateTimeOf(trip.depart_at)}</div>
                </div>
              )}
              {hold && (
                <>
                  <div className="row" style={{ gap: '.3rem' }}>
                    {hold.seats.map((s) => <span key={s} className="pill pill-brand mono">{s}</span>)}
                  </div>
                  <dl className="kv">
                    <dt>{hold.price.seat_count} × {taka(hold.price.fare_poisha)}</dt>
                    <dd className="tnum">{taka(hold.price.base_poisha)}</dd>
                    <dt>Service fee</dt>
                    <dd className="tnum">{taka(hold.price.service_fee_poisha)}</dd>
                    <dt style={{ fontWeight: 700, color: 'var(--ink)' }}>Total</dt>
                    <dd className="tnum" style={{ fontWeight: 700 }}>{taka(hold.price.total_poisha)}</dd>
                  </dl>
                </>
              )}

              <div className="field">
                <label className="label" htmlFor="coupon">Promo code</label>
                <input id="coupon" className="input mono" value={coupon} placeholder="EIDSAFAR"
                       onChange={(e) => setCoupon(e.target.value.toUpperCase())} />
                <span className="hint">Applied when your booking is created. <Link href="/offers">See offers</Link></span>
              </div>
            </div>
          </aside>
        </div>
      </div>

      <style>{`
        @media (max-width: 900px) {
          .checkout-layout { grid-template-columns: 1fr !important; }
          .checkout-layout aside { position: static !important; }
        }
      `}</style>
    </div>
  );
}

export default function CheckoutPage() {
  return (
    <Suspense fallback={<div className="page container"><Loading rows={3} /></div>}>
      <Checkout />
    </Suspense>
  );
}
