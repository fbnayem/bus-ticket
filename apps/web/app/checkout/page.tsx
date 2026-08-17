'use client';

import { Suspense, useEffect, useMemo, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { api, ApiError, type Hold, type Passenger, type Price, type SavedPassenger, type Trip } from '@/lib/api';
import { ErrorNotice, Fascia, Loading, Stepper } from '@/components/ui';
import { useLang, useT } from '@/components/LangProvider';

function Checkout() {
  const params = useSearchParams();
  const router = useRouter();
  const t = useT();
  const { fmt } = useLang();
  const holdId = params.get('hold') ?? '';

  const [hold, setHold] = useState<Hold | null>(null);
  const [trip, setTrip] = useState<Trip | null>(null);
  const [price, setPrice] = useState<Price | null>(null);
  const [expiresAt, setExpiresAt] = useState('');
  const [holdSeconds, setHoldSeconds] = useState<number | undefined>();
  const [saved, setSaved] = useState<SavedPassenger[]>([]);
  const [passengers, setPassengers] = useState<Passenger[]>([]);
  // Empty, not a developer's number. This field used to arrive pre-filled with
  // +8801700000000, so an inattentive passenger sent their ticket — and every
  // later trip update — to a placeholder that belongs to nobody.
  const [phone, setPhone] = useState('');
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
        const { hold: h, trip: tr } = JSON.parse(cached) as { hold: Hold; trip: Trip };
        if (h.hold_id === holdId) {
          setHold(h); setTrip(tr); setPrice(h.price); setExpiresAt(h.expires_at);
          setPassengers(h.seats.map((s) => ({ seat_no: s, full_name: '', gender: '', age: undefined })));
          setLoading(false);
        }
      } catch { /* fall through to the API */ }
    }

    // Always confirm against the server — sessionStorage is a convenience,
    // never the authority on whether the hold is still alive. The response is
    // now APPLIED rather than merely inspected: previously only `expired` was
    // read, so a reload left the summary with no price, no seats and no clock.
    api.getHold(holdId)
      .then((h) => {
        if (h.status !== 'HELD' || h.expired) setExpired(true);
        setExpiresAt(h.expires_at);
        if (h.price) setPrice(h.price);
        setPassengers((prev) => prev.length ? prev : h.seats.map((s) => ({ seat_no: s, full_name: '' })));
        if (!trip) {
          api.trip(h.trip_id).then(setTrip).catch(() => {});
        }
      })
      .catch((e: ApiError) => setError(e.message))
      .finally(() => setLoading(false));

    api.savedPassengers().then((r) => setSaved(r.passengers)).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [holdId]);

  // The hold window belongs to the server. Measuring it from the first
  // observation, rather than assuming ten minutes, means the draining rule
  // stays truthful even if the service grants five.
  useEffect(() => {
    if (!expiresAt || holdSeconds) return;
    const left = (new Date(expiresAt).getTime() - Date.now()) / 1000;
    if (left > 0) setHoldSeconds(Math.ceil(left));
  }, [expiresAt, holdSeconds]);

  const seats = useMemo(
    () => hold?.seats ?? passengers.map((p) => p.seat_no),
    [hold, passengers]);

  const update = (i: number, patch: Partial<Passenger>) =>
    setPassengers((prev) => prev.map((p, idx) => (idx === i ? { ...p, ...patch } : p)));

  const usesSaved = (i: number, id: string) => {
    const s = saved.find((x) => x.id === id);
    if (s) update(i, { full_name: s.full_name, gender: s.gender, age: s.age });
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (passengers.some((p) => !p.full_name.trim())) {
      setError(t('pax.nameRequired'));
      return;
    }
    setSubmitting(true);
    setError('');
    try {
      const booking = await api.createBooking({
        hold_id: holdId, passengers, phone,
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
          <h1 style={{ fontSize: '1.2rem' }}>{t('hold.expired')}</h1>
          <p className="muted" style={{ marginBottom: 0 }}>{t('hold.whyExpire')}</p>
          <Link
            className="btn btn-primary"
            href={trip ? `/trips/${trip.trip_id}?board=${trip.board_seq}&drop=${trip.drop_seq}` : '/search'}
          >
            {t('hold.chooseAgain')}
          </Link>
        </div>
      </div>
    );
  }

  const cta = (
    <button className="btn btn-primary btn-lg" type="submit" form="checkout-form" disabled={submitting}>
      {submitting ? t('pax.creating') : t('pax.toPayment')}
    </button>
  );

  return (
    <div className="page">
      <div className="container">
        <Stepper current="Passengers" />

        <div className="checkout-layout">
          <form id="checkout-form" className="stack" onSubmit={submit}>
            <div className="card">
              <div className="card-head">{t('pax.details')}</div>
              <div className="card-pad stack">
                {passengers.map((p, i) => (
                  <fieldset key={p.seat_no} className="pax-set">
                    <legend className="small">
                      {t('ticket.seat')} <strong className="mono">{p.seat_no}</strong>
                    </legend>

                    {saved.length > 0 && (
                      <div className="field" style={{ marginBottom: '.6rem' }}>
                        <label className="label" htmlFor={`saved-${i}`}>{t('pax.useSaved')}</label>
                        <select id={`saved-${i}`} className="select" defaultValue=""
                                onChange={(e) => usesSaved(i, e.target.value)}>
                          <option value="">{t('pax.enterManually')}</option>
                          {saved.map((s) => <option key={s.id} value={s.id}>{s.full_name}</option>)}
                        </select>
                      </div>
                    )}

                    <div className="grid-2">
                      <div className="field">
                        <label className="label" htmlFor={`name-${i}`}>{t('pax.name')}</label>
                        <input id={`name-${i}`} className="input" required value={p.full_name}
                               autoComplete="name"
                               onChange={(e) => update(i, { full_name: e.target.value })}
                               placeholder={t('pax.nameHint')} />
                      </div>
                      <div className="grid-2">
                        <div className="field">
                          <label className="label" htmlFor={`gender-${i}`}>{t('pax.gender')}</label>
                          <select id={`gender-${i}`} className="select" value={p.gender ?? ''}
                                  onChange={(e) => update(i, { gender: e.target.value })}>
                            <option value="">—</option>
                            <option value="M">{t('pax.male')}</option>
                            <option value="F">{t('pax.female')}</option>
                            <option value="X">{t('pax.other')}</option>
                          </select>
                        </div>
                        <div className="field">
                          <label className="label" htmlFor={`age-${i}`}>{t('pax.age')}</label>
                          <input id={`age-${i}`} className="input" type="number" min={0} max={120}
                                 inputMode="numeric"
                                 value={p.age ?? ''}
                                 onChange={(e) => update(i, { age: Number(e.target.value) || undefined })} />
                        </div>
                      </div>
                    </div>
                  </fieldset>
                ))}
              </div>
            </div>

            <div className="card">
              <div className="card-head">{t('pax.contact')}</div>
              <div className="card-pad grid-2">
                <div className="field">
                  <label className="label" htmlFor="phone">{t('pax.phone')}</label>
                  {/* inputMode brings up the numeric keypad — the field used to
                      open an alphabetic keyboard for an eleven-digit number. */}
                  <input id="phone" className="input" required value={phone}
                         type="tel" inputMode="tel" autoComplete="tel"
                         onChange={(e) => setPhone(e.target.value)} placeholder="01XXXXXXXXX" />
                  <span className="hint">{t('pax.contactNote')}</span>
                </div>
                <div className="field">
                  <label className="label" htmlFor="email">{t('pax.email')}</label>
                  <input id="email" className="input" type="email" value={email}
                         autoComplete="email" inputMode="email"
                         onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" />
                </div>
              </div>
            </div>

            {error && <ErrorNotice message={error} />}
          </form>

          <aside className="card checkout-aside">
            <div className="card-head">{t('pax.summary')}</div>
            <div className="card-pad stack">
              {trip && (
                <div>
                  <strong>{trip.brand}</strong>
                  <div className="small muted">{trip.bus_type} · {fmt.dateTime(trip.depart_at)}</div>
                </div>
              )}

              {seats.length > 0 && (
                <div className="row" style={{ gap: '.3rem' }}>
                  {seats.map((s) => <span key={s} className="pill pill-brand mono">{s}</span>)}
                </div>
              )}

              {price && (
                <dl className="kv">
                  <dt>{price.seat_count} × {fmt.taka(price.fare_poisha)}</dt>
                  <dd className="tnum">{fmt.taka(price.base_poisha)}</dd>
                  {price.service_fee_poisha > 0 && (
                    <>
                      <dt>{t('money.serviceFee')}</dt>
                      <dd className="tnum">{fmt.taka(price.service_fee_poisha)}</dd>
                    </>
                  )}
                  {price.discount_poisha > 0 && (
                    <>
                      <dt>{t('money.discount')}</dt>
                      <dd className="tnum">−{fmt.taka(price.discount_poisha)}</dd>
                    </>
                  )}
                  <dt style={{ fontWeight: 700, color: 'var(--ink)' }}>{t('money.total')}</dt>
                  <dd className="tnum" style={{ fontWeight: 700 }}>{fmt.taka(price.total_poisha)}</dd>
                </dl>
              )}

              <div className="field">
                <label className="label" htmlFor="coupon">{t('money.coupon')}</label>
                <input id="coupon" className="input mono" value={coupon} placeholder={t('money.couponPlaceholder')}
                       autoCapitalize="characters"
                       onChange={(e) => setCoupon(e.target.value.toUpperCase())} />
                <span className="hint">
                  {t('money.promoHint')} <Link href="/offers">{t('money.seeOffers')}</Link>
                </span>
              </div>

              {/* One fascia. On a phone it fixes to the bottom of the viewport,
                  so the deadline follows the passenger down a form that runs
                  400px per seat instead of sitting in a header they scrolled
                  past ten minutes ago. */}
              <Fascia
                total={price ? fmt.taka(price.total_poisha) : '—'}
                note={seats.join(', ')}
                action={cta}
                holdExpiresAt={expiresAt || undefined}
                holdSeconds={holdSeconds}
              />
            </div>
          </aside>
        </div>
      </div>
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
