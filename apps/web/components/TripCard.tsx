'use client';

import Link from 'next/link';
import type { SearchResult } from '@/lib/api';
import { AMENITY_LABEL, duration, taka, timeOf } from '@/lib/format';

export function TripCard({ trip }: { trip: SearchResult }) {
  const href = `/trips/${trip.trip_id}?board=${trip.board_seq}&drop=${trip.drop_seq}`;
  const scarce = trip.available_seats > 0 && trip.available_seats <= 5;

  return (
    <article className="card trip">
      <div className="stack-sm">
        <div className="row" style={{ gap: '.5rem' }}>
          <strong style={{ fontSize: '1rem' }}>{trip.brand}</strong>
          <span className="pill">{trip.bus_type}</span>
          {trip.is_ac && <span className="pill pill-brand">AC</span>}
        </div>

        <div className="row" style={{ gap: '.7rem' }}>
          <span className="trip-time tnum">{timeOf(trip.depart_at)}</span>
          <span className="trip-arrow" aria-hidden="true">→</span>
          <span className="trip-time tnum">{timeOf(trip.arrive_at)}</span>
          <span className="muted small">{duration(trip.duration_min)}</span>
        </div>

        <div className="muted small">
          {trip.origin} → {trip.destination} · {trip.registration}
        </div>

        {trip.amenities.length > 0 && (
          <div className="row" style={{ gap: '.3rem' }}>
            {trip.amenities.map((a) => (
              <span className="amenity" key={a}>{AMENITY_LABEL[a] ?? a}</span>
            ))}
          </div>
        )}
      </div>

      <div className="trip-right">
        <div>
          <div className="trip-price tnum">{taka(trip.fare_poisha)}</div>
          <div className="small muted" style={{ textAlign: 'right' }}>per seat</div>
        </div>

        <div className="stack-sm" style={{ alignItems: 'flex-end' }}>
          {trip.available_seats === 0 ? (
            <span className="pill pill-danger">Sold out</span>
          ) : (
            <span className={`pill ${scarce ? 'pill-warn' : ''}`}>
              {trip.available_seats} of {trip.total_seats} free
            </span>
          )}
          <Link
            className={`btn ${trip.available_seats === 0 ? 'btn-ghost' : 'btn-primary'}`}
            href={href}
            aria-disabled={trip.available_seats === 0}
            tabIndex={trip.available_seats === 0 ? -1 : undefined}
            style={trip.available_seats === 0 ? { pointerEvents: 'none', opacity: .5 } : undefined}
          >
            {trip.available_seats === 0 ? 'Sold out' : 'Select seats'}
          </Link>
        </div>
      </div>
    </article>
  );
}
