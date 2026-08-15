'use client';

import { use, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { api, ApiError, type Booking, type RescheduleOption, type SeatMap as SeatMapData } from '@/lib/api';
import { SeatMap } from '@/components/SeatMap';
import { ErrorNotice, Loading } from '@/components/ui';
import { dateOf, taka, timeOf } from '@/lib/format';

export default function ReschedulePage({ params }: { params: Promise<{ pnr: string }> }) {
  const { pnr } = use(params);
  const router = useRouter();

  const [booking, setBooking] = useState<Booking | null>(null);
  const [options, setOptions] = useState<RescheduleOption[]>([]);
  const [seatCount, setSeatCount] = useState(1);
  const [chosen, setChosen] = useState<RescheduleOption | null>(null);
  const [map, setMap] = useState<SeatMapData | null>(null);
  const [seats, setSeats] = useState<string[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    Promise.all([api.booking(pnr), api.rescheduleOptions(pnr)])
      .then(([b, o]) => { setBooking(b); setOptions(o.options); setSeatCount(o.seat_count); })
      .catch((e: ApiError) => setError(e.message))
      .finally(() => setLoading(false));
  }, [pnr]);

  const choose = async (o: RescheduleOption) => {
    setChosen(o);
    setSeats([]);
    setMap(null);
    try {
      setMap(await api.seatmap(o.trip_id, o.board_seq, o.drop_seq));
    } catch (e) {
      setError((e as ApiError).message);
    }
  };

  const toggle = (s: string) =>
    setSeats((prev) =>
      prev.includes(s) ? prev.filter((x) => x !== s)
        : prev.length >= seatCount ? prev
        : [...prev, s]);

  const confirm = async () => {
    if (!chosen || seats.length !== seatCount) return;
    setBusy(true);
    setError('');
    try {
      const res = await api.reschedule(pnr, {
        trip_id: chosen.trip_id, seats,
        board_seq: chosen.board_seq, drop_seq: chosen.drop_seq,
      });
      router.push(`/manage/${res.new_pnr}?moved=1`);
    } catch (e) {
      setError((e as ApiError).message);
      setBusy(false);
    }
  };

  if (loading) return <div className="page container"><Loading rows={3} /></div>;
  if (error && !booking) return <div className="page container-narrow"><ErrorNotice message={error} /></div>;
  if (!booking) return null;

  const diff = chosen ? chosen.fare_poisha * seatCount + 5000 - booking.total_poisha : 0;

  return (
    <div className="page container">
      <div style={{ marginBottom: '1rem' }}>
        <h1 style={{ fontSize: '1.3rem' }}>Change your departure</h1>
        <p className="muted small" style={{ margin: 0 }}>
          Booking <span className="mono">{booking.pnr}</span> · {booking.origin} → {booking.destination} ·
          {' '}{seatCount} seat{seatCount > 1 ? 's' : ''}
        </p>
      </div>

      <div className="notice notice-info" style={{ marginBottom: '1rem' }}>
        Your current seats stay yours until the new ones are confirmed. If anything
        fails part-way, the original ticket is left untouched.
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr) 360px', gap: '1.25rem', alignItems: 'start' }}
           className="resched-layout">
        <div className="stack">
          <div className="card">
            <div className="card-head">Later departures</div>
            <div className="card-pad stack-sm">
              {options.length === 0 && (
                <p className="muted" style={{ marginBottom: 0 }}>
                  No other departures are available on this route right now.
                </p>
              )}
              {options.map((o) => (
                <label
                  key={o.trip_id}
                  className="card card-pad row-between"
                  style={{
                    cursor: o.eligible ? 'pointer' : 'not-allowed',
                    opacity: o.eligible ? 1 : .5,
                    borderColor: chosen?.trip_id === o.trip_id ? 'var(--brand)' : 'var(--line)',
                    background: chosen?.trip_id === o.trip_id ? 'var(--brand-tint)' : 'var(--surface)',
                  }}
                >
                  <div className="row" style={{ gap: '.7rem' }}>
                    <input
                      type="radio" name="option" disabled={!o.eligible}
                      checked={chosen?.trip_id === o.trip_id}
                      onChange={() => choose(o)}
                    />
                    <div>
                      <strong>{o.brand}</strong> <span className="pill">{o.bus_type}</span>
                      <div className="small muted">
                        {dateOf(o.depart_at)} · {timeOf(o.depart_at)} · {o.available_seats} seats free
                      </div>
                    </div>
                  </div>
                  <div className="tnum" style={{ fontWeight: 700 }}>{taka(o.fare_poisha)}</div>
                </label>
              ))}
            </div>
          </div>

          {chosen && (
            <div className="card">
              <div className="card-head">
                Pick {seatCount} seat{seatCount > 1 ? 's' : ''} on the new bus
              </div>
              <div className="card-pad">
                {map
                  ? <SeatMap seats={map.seats} selected={seats} onToggle={toggle} maxSeats={seatCount} disabled={busy} />
                  : <Loading rows={2} />}
              </div>
            </div>
          )}
        </div>

        <aside className="card" style={{ position: 'sticky', top: 'calc(var(--header-h) + 1rem)' }}>
          <div className="card-head">Fare difference</div>
          <div className="card-pad stack">
            <dl className="kv">
              <dt>Originally paid</dt><dd className="tnum">{taka(booking.total_poisha)}</dd>
              <dt>New fare</dt>
              <dd className="tnum">{chosen ? taka(chosen.fare_poisha * seatCount + 5000) : '—'}</dd>
              <dt style={{ fontWeight: 700, color: 'var(--ink)' }}>
                {diff >= 0 ? 'To pay' : 'Back to you'}
              </dt>
              <dd className="tnum" style={{ fontWeight: 700 }}>{chosen ? taka(Math.abs(diff)) : '—'}</dd>
            </dl>

            {error && <ErrorNotice message={error} />}

            <button
              className="btn btn-primary btn-block"
              disabled={!chosen || seats.length !== seatCount || busy}
              onClick={confirm}
            >
              {busy ? 'Moving your booking…' : 'Confirm change'}
            </button>
            <Link className="btn btn-ghost btn-block" href={`/manage/${pnr}`}>Keep my current trip</Link>
          </div>
        </aside>
      </div>

      <style>{`
        @media (max-width: 900px) {
          .resched-layout { grid-template-columns: 1fr !important; }
          .resched-layout aside { position: static !important; }
        }
      `}</style>
    </div>
  );
}
