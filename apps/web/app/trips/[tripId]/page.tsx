'use client';

import { Suspense, use, useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { api, ApiError, type SeatMap as SeatMapData, type Trip } from '@/lib/api';
import { SeatMap } from '@/components/SeatMap';
import { ErrorNotice, Loading, Stepper } from '@/components/ui';
import { AMENITY_LABEL, dateTimeOf, duration, taka, timeOf } from '@/lib/format';

const MAX_SEATS = 6;

function TripDetail({ tripId }: { tripId: string }) {
  const params = useSearchParams();
  const router = useRouter();
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
      .then(([t, m]) => { setTrip(t); setMap(m); setError(''); })
      .catch((e: ApiError) => setError(e.message))
      .finally(() => setLoading(false));
  }, [tripId, board, drop, nonce]);

  // Someone else's hold can land while this page is open, so refresh the map
  // periodically rather than letting the passenger pick a seat that is gone.
  useEffect(() => {
    const t = setInterval(() => {
      api.seatmap(tripId, board, drop).then(setMap).catch(() => {});
    }, 15000);
    return () => clearInterval(t);
  }, [tripId, board, drop]);

  const toggle = (seatNo: string) =>
    setSelected((prev) =>
      prev.includes(seatNo) ? prev.filter((s) => s !== seatNo)
        : prev.length >= MAX_SEATS ? prev
        : [...prev, seatNo]);

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

  return (
    <div className="page">
      <div className="container">
        <Stepper current="Seats" />

        <div className="row-between" style={{ marginBottom: '1rem' }}>
          <div>
            <h1 style={{ fontSize: '1.35rem' }}>{trip.brand}</h1>
            <p className="muted small" style={{ margin: 0 }}>
              {trip.bus_type} · {trip.registration} · {dateTimeOf(trip.depart_at)}
            </p>
          </div>
          <div style={{ textAlign: 'right' }}>
            <div className="trip-price tnum">{taka(trip.fare_poisha)}</div>
            <div className="small muted">per seat · {duration(trip.duration_min)}</div>
          </div>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr) 360px', gap: '1.25rem', alignItems: 'start' }}
             className="trip-layout">
          <div className="stack">
            <div className="card">
              <div className="card-head">Choose your seats</div>
              <div className="card-pad">
                {error && <div style={{ marginBottom: '.8rem' }}><ErrorNotice message={error} /></div>}
                <SeatMap seats={map.seats} selected={selected} onToggle={toggle} maxSeats={MAX_SEATS} disabled={holding} />
                <p className="small muted" style={{ marginTop: '.9rem', marginBottom: 0 }}>
                  Availability shown is for {trip.stops[board]?.name} → {trip.stops[drop]?.name} only.
                  A seat booked on another part of this route can still be yours for this leg.
                </p>
              </div>
            </div>

            <div className="card">
              <div className="card-head">Route</div>
              <div className="card-pad">
                <ol style={{ listStyle: 'none', padding: 0, margin: 0 }}>
                  {trip.stops.map((s) => {
                    const inLeg = s.seq >= board && s.seq <= drop;
                    return (
                      <li key={s.seq} className="row" style={{ gap: '.6rem', padding: '.3rem 0', opacity: inLeg ? 1 : .45 }}>
                        <span className={`route-dot ${inLeg ? '' : 'hollow'}`} />
                        <span className="tnum mono small">{timeOf(s.at)}</span>
                        <span style={{ fontWeight: inLeg ? 600 : 400 }}>{s.name}</span>
                        {s.seq === board && <span className="pill pill-brand">Board</span>}
                        {s.seq === drop && <span className="pill pill-ok">Drop</span>}
                      </li>
                    );
                  })}
                </ol>
              </div>
            </div>

            {trip.amenities.length > 0 && (
              <div className="card">
                <div className="card-head">On board</div>
                <div className="card-pad row" style={{ gap: '.4rem' }}>
                  {trip.amenities.map((a) => (
                    <span className="amenity" key={a}>{AMENITY_LABEL[a] ?? a}</span>
                  ))}
                </div>
              </div>
            )}
          </div>

          <aside className="card" style={{ position: 'sticky', top: 'calc(var(--header-h) + 1rem)' }}>
            <div className="card-head">Your selection</div>
            <div className="card-pad stack">
              {selected.length === 0 ? (
                <p className="muted small" style={{ margin: 0 }}>
                  Pick up to {MAX_SEATS} seats from the map.
                </p>
              ) : (
                <>
                  <div className="row" style={{ gap: '.35rem' }}>
                    {selected.map((s) => (
                      <span key={s} className="pill pill-brand mono">{s}</span>
                    ))}
                  </div>
                  <dl className="kv">
                    <dt>{selected.length} × {taka(trip.fare_poisha)}</dt>
                    <dd className="tnum">{taka(subtotal)}</dd>
                    <dt>Service fee</dt>
                    <dd className="tnum">{taka(5000)}</dd>
                    <dt style={{ fontWeight: 700, color: 'var(--ink)' }}>Total</dt>
                    <dd className="tnum" style={{ fontWeight: 700 }}>{taka(subtotal + 5000)}</dd>
                  </dl>
                </>
              )}

              <button
                className="btn btn-primary btn-block btn-lg"
                disabled={selected.length === 0 || holding}
                onClick={proceed}
              >
                {holding ? 'Holding seats…' : 'Continue'}
              </button>
              <p className="small muted" style={{ margin: 0 }}>
                Seats are held for 10 minutes once you continue.
              </p>
            </div>
          </aside>
        </div>
      </div>

      <style>{`
        @media (max-width: 900px) {
          .trip-layout { grid-template-columns: 1fr !important; }
          .trip-layout aside { position: static !important; }
        }
      `}</style>
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
