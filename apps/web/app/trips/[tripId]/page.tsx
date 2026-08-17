'use client';

import { Suspense, use, useCallback, useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { api, ApiError, type SeatMap as SeatMapData, type Trip } from '@/lib/api';
import { SeatMap } from '@/components/SeatMap';
import { RouteRail } from '@/components/RouteRail';
import { ErrorNotice, Fascia, Loading, Stepper } from '@/components/ui';
import { useLang, useT } from '@/components/LangProvider';
import type { Key } from '@/lib/i18n';

const MAX_SEATS = 6;

const AMENITY_KEY: Record<string, Key> = {
  WIFI: 'amenity.WIFI', CHARGING: 'amenity.CHARGING', WATER: 'amenity.WATER',
  BLANKET: 'amenity.BLANKET', SNACK: 'amenity.SNACK',
};

function TripDetail({ tripId }: { tripId: string }) {
  const params = useSearchParams();
  const router = useRouter();
  const t = useT();
  const { fmt } = useLang();

  const board = Number(params.get('board') ?? 0);
  const drop = Number(params.get('drop') ?? 0);

  const [trip, setTrip] = useState<Trip | null>(null);
  const [map, setMap] = useState<SeatMapData | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [holding, setHolding] = useState(false);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    setLoading(true);
    Promise.all([api.trip(tripId, board, drop), api.seatmap(tripId, board, drop)])
      .then(([tr, m]) => { setTrip(tr); setMap(m); setError(''); })
      .catch((e: ApiError) => setError(e.message))
      .finally(() => setLoading(false));
  }, [tripId, board, drop, nonce]);

  // Someone else's hold can land while this page is open, so refresh the map
  // periodically rather than letting the passenger pick a seat that is gone.
  useEffect(() => {
    const timer = setInterval(() => {
      api.seatmap(tripId, board, drop).then(setMap).catch(() => {});
    }, 15000);
    return () => clearInterval(timer);
  }, [tripId, board, drop]);

  const toggle = (seatNo: string) =>
    setSelected((prev) =>
      prev.includes(seatNo) ? prev.filter((s) => s !== seatNo)
        : prev.length >= MAX_SEATS ? prev
        : [...prev, seatNo]);

  // When the poll reports a chosen seat as gone, drop it from the selection.
  // The map names it in a banner; this keeps the summary and the total honest.
  const dropLost = useCallback((lost: string[]) => {
    setSelected((prev) => prev.filter((s) => !lost.includes(s)));
  }, []);

  const proceed = async () => {
    if (!trip || selected.length === 0) return;
    setHolding(true);
    setError('');
    try {
      const hold = await api.createHold({
        trip_id: tripId, seats: selected,
        board_seq: trip.board_seq, drop_seq: trip.drop_seq,
      });
      sessionStorage.setItem('jatra.hold', JSON.stringify({ hold, trip }));
      router.push(`/checkout?hold=${hold.hold_id}`);
    } catch (e) {
      const err = e as ApiError;
      setError(err.message);
      // The map is stale if we lost the race — pull a fresh one.
      if (err.code === 'seat_taken') {
        setSelected([]);
        setNonce((n) => n + 1);
      }
      setHolding(false);
    }
  };

  if (loading) return <div className="page container"><Loading rows={3} /></div>;
  if (error && !trip) return <div className="page container"><ErrorNotice message={error} onRetry={() => setNonce((n) => n + 1)} /></div>;
  if (!trip || !map) return null;

  const subtotal = trip.fare_poisha * selected.length;
  const multiLeg = trip.stops.length > 2;

  const cta = (
    <button
      className="btn btn-primary btn-lg"
      disabled={selected.length === 0 || holding}
      onClick={proceed}
    >
      {holding ? t('trip.holding') : t('common.continue')}
    </button>
  );

  return (
    <div className="page">
      <div className="container">
        <Stepper current="Seats" />

        <div className="row-between" style={{ marginBottom: '1rem' }}>
          <div>
            <h1 style={{ fontSize: '1.35rem' }}>{trip.brand}</h1>
            <p className="muted small" style={{ margin: 0 }}>
              {trip.bus_type} · {trip.registration} · {fmt.dateTime(trip.depart_at)}
            </p>
          </div>
          <div style={{ textAlign: 'right' }}>
            <div className="br-fare">{fmt.taka(trip.fare_poisha)}</div>
            <div className="small muted">{t('trip.perSeat')} · {fmt.duration(trip.duration_min)}</div>
          </div>
        </div>

        {/* The leg being bought, painted over the whole route. */}
        {multiLeg && (
          <div className="card card-pad" style={{ marginBottom: '1rem' }}>
            <RouteRail stops={trip.stops} board={board} drop={drop} />
          </div>
        )}

        <div className="trip-layout">
          <div className="stack">
            <div className="card">
              <div className="card-head">{t('seat.title')}</div>
              <div className="card-pad">
                {error && <div style={{ marginBottom: '.8rem' }}><ErrorNotice message={error} /></div>}
                <SeatMap
                  seats={map.seats}
                  selected={selected}
                  onToggle={toggle}
                  maxSeats={MAX_SEATS}
                  disabled={holding}
                  multiLeg={multiLeg}
                  onSeatsLost={dropLost}
                />
              </div>
            </div>

            <div className="card">
              <div className="card-head">{t('trip.route')}</div>
              <div className="card-pad">
                <RouteRail stops={trip.stops} board={board} drop={drop} vertical />
              </div>
            </div>

            {trip.amenities.length > 0 && (
              <div className="card">
                <div className="card-head">{t('trip.amenities')}</div>
                <div className="card-pad row" style={{ gap: '.4rem' }}>
                  {trip.amenities.map((a) => (
                    <span className="amenity" key={a}>{AMENITY_KEY[a] ? t(AMENITY_KEY[a]) : a}</span>
                  ))}
                </div>
              </div>
            )}
          </div>

          <aside className="card trip-aside">
            <div className="card-head">{t('trip.yourSelection')}</div>
            <div className="card-pad stack">
              {selected.length === 0 ? (
                <p className="muted small" style={{ margin: 0 }}>
                  {t('trip.pickUpTo', { n: MAX_SEATS })}
                </p>
              ) : (
                <>
                  <div className="row" style={{ gap: '.35rem' }}>
                    {selected.map((s) => (
                      <span key={s} className="pill pill-brand mono">{s}</span>
                    ))}
                  </div>
                  <dl className="kv">
                    <dt>{selected.length} × {fmt.taka(trip.fare_poisha)}</dt>
                    <dd className="tnum">{fmt.taka(subtotal)}</dd>
                  </dl>
                  {/* No invented service fee. The server sets it when the hold
                      is created, and the old code's hardcoded ৳50 could and did
                      disagree with the total shown on the very next screen. */}
                  <p className="small muted" style={{ margin: 0 }}>{t('money.feeAtNext')}</p>
                </>
              )}

              {/* ONE fascia, two placements. In the aside on a wide screen, and
                  fixed to the bottom of the viewport on a phone — the same DOM
                  node moved by CSS, so the primary action never exists twice on
                  the page for a passenger (or a test) to pick the wrong one. */}
              <Fascia
                total={selected.length ? fmt.taka(subtotal) : '—'}
                note={selected.length ? selected.join(', ') : t('seat.none')}
                action={cta}
              />
              <p className="small muted trip-holdnote">{t('trip.holdNote')}</p>
            </div>
          </aside>
        </div>
      </div>
    </div>
  );
}

export default function TripPage({ params }: { params: Promise<{ tripId: string }> }) {
  const { tripId } = use(params);
  return (
    <Suspense fallback={<div className="page container"><Loading rows={3} /></div>}>
      <TripDetail tripId={tripId} />
    </Suspense>
  );
}
