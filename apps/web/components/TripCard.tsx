'use client';

import Link from 'next/link';
import type { SearchResult } from '@/lib/api';
import { useLang, useT } from './LangProvider';
import type { Key } from '@/lib/i18n';

const AMENITY_KEY: Record<string, Key> = {
  WIFI: 'amenity.WIFI',
  CHARGING: 'amenity.CHARGING',
  WATER: 'amenity.WATER',
  BLANKET: 'amenity.BLANKET',
  SNACK: 'amenity.SNACK',
};

/**
 * A departure-board row.
 *
 * The left gutter holds the time in condensed board type and never moves — that
 * fixed column is what lets a passenger scan seven departures vertically
 * instead of reading seven cards. Money is right-aligned on its own tabular
 * column for the same reason. The route line between them shows the journey as
 * a line rather than as the words "Dhaka → Chattogram" repeated on every row.
 */
export function TripCard({ trip }: { trip: SearchResult }) {
  const t = useT();
  const { fmt } = useLang();
  const href = `/trips/${trip.trip_id}?board=${trip.board_seq}&drop=${trip.drop_seq}`;
  const soldOut = trip.available_seats === 0;
  const scarce = !soldOut && trip.available_seats <= 5;

  return (
    // data-trip is the stable hook the browser suites select on. They used to
    // match `article.card.trip`, which tied them to a presentational class —
    // so renaming the card broke the tests without anything being wrong.
    //
    // It carries the trip id rather than being a bare flag, because "one
    // inventory, every channel" can only be checked by looking at the SAME
    // trip from two channels. The staff suite used to approximate that with
    // "the first Green Line card", which is a different departure whenever the
    // operator runs more than one that day — and Green Line runs two.
    <article className={`board-row${soldOut ? ' is-gone' : ''}`}
             data-trip={trip.trip_id} data-sold-out={soldOut}>
      {/* The fixed left gutter: when this bus leaves. */}
      <div className="br-when">
        <time className="br-depart" dateTime={trip.depart_at}>{fmt.time(trip.depart_at)}</time>
        <span className="br-dur">{fmt.duration(trip.duration_min)}</span>
      </div>

      <div className="br-body">
        <div className="row" style={{ gap: '.45rem' }}>
          <strong className="br-brand">{trip.brand}</strong>
          <span className="pill">{trip.bus_type}</span>
          {trip.is_ac && <span className="pill pill-brand">{t('trip.ac')}</span>}
        </div>

        {/* The route as a drawn line — arrival sits at the far stop. */}
        <div className="br-rail" aria-hidden="true">
          <span className="route-dot" />
          <span className="route-track" />
          <span className="route-dot hollow" />
        </div>
        <div className="br-stops">
          <span>{trip.origin}</span>
          <span className="br-arrive">{fmt.time(trip.arrive_at)} · {trip.destination}</span>
        </div>

        {trip.amenities.length > 0 && (
          <div className="row" style={{ gap: '.3rem' }}>
            {trip.amenities.map((a) => (
              <span className="amenity" key={a}>{AMENITY_KEY[a] ? t(AMENITY_KEY[a]) : a}</span>
            ))}
          </div>
        )}
      </div>

      <div className="br-money">
        <div className="br-fare">{fmt.taka(trip.fare_poisha)}</div>
        <div className="br-perseat">{t('trip.perSeat')}</div>

        {soldOut ? (
          <span className="pill pill-danger">{t('trip.soldOut')}</span>
        ) : (
          <span className={`pill ${scarce ? 'pill-warn' : ''}`}>
            {scarce
              ? t('trip.onlyLeft', { free: trip.available_seats })
              : t('trip.freeOf', { free: trip.available_seats, total: trip.total_seats })}
          </span>
        )}

        <Link
          className={`btn ${soldOut ? 'btn-ghost' : 'btn-primary'} br-cta`}
          href={href}
          aria-disabled={soldOut}
          tabIndex={soldOut ? -1 : undefined}
          style={soldOut ? { pointerEvents: 'none', opacity: .5 } : undefined}
        >
          {soldOut ? t('trip.soldOut') : t('trip.selectSeats')}
        </Link>
      </div>
    </article>
  );
}
