'use client';

import { useEffect, useRef } from 'react';
import type { Seat } from '@/lib/api';
import { useT } from './LangProvider';
import type { Key } from '@/lib/i18n';

/**
 * The seat map is the one screen where a passenger forms an opinion about
 * whether this system knows what it is doing, so state is encoded twice — in
 * colour and in an accessible label — and unavailable seats are never merely
 * greyed: they say why.
 *
 * Availability is computed by the inventory service for the SPECIFIC leg being
 * booked. A seat sold Dhaka→Cumilla is genuinely free Cumilla→Chattogram, and
 * that is what this map shows. That is worth stating on the screen rather than
 * only in the code: a passenger who has been told elsewhere that a bus is full
 * has no other way to know why seats are free here.
 */

const SEAT_TYPE_KEY: Record<string, Key> = {
  NORMAL: 'seatType.NORMAL',
  BUSINESS: 'seatType.BUSINESS',
  SLEEPER: 'seatType.SLEEPER',
  PREMIUM: 'seatType.PREMIUM',
  FEMALE_RESERVED: 'seatType.FEMALE_RESERVED',
  ACCESSIBLE: 'seatType.ACCESSIBLE',
  BLOCKED: 'seatType.BLOCKED',
  CREW: 'seatType.CREW',
};

export function SeatMap({
  seats,
  selected,
  onToggle,
  maxSeats = 6,
  disabled = false,
  multiLeg = false,
  onSeatsLost,
}: {
  seats: Seat[];
  selected: string[];
  onToggle: (seatNo: string) => void;
  maxSeats?: number;
  disabled?: boolean;
  /** True when this trip has intermediate stops, so leg-exact availability is worth explaining. */
  multiLeg?: boolean;
  /** Called when a seat the passenger had chosen was taken by someone else. */
  onSeatsLost?: (seatNos: string[]) => void;
}) {
  const t = useT();
  const decks = Array.from(new Set(seats.map((s) => s.deck))).sort();

  // Losing a seat silently is worse than losing it. When the poll returns a
  // chosen seat as taken, say so by name and hand it back to the parent to drop
  // from the selection, rather than letting the plate quietly change colour
  // somewhere further down a scrolled page.
  const lastReported = useRef<string>('');
  const lost = selected.filter((no) => {
    const s = seats.find((x) => x.seat_no === no);
    return s && (s.sold || s.held || s.blocked);
  });

  useEffect(() => {
    const key = lost.slice().sort().join(',');
    if (key && key !== lastReported.current) {
      lastReported.current = key;
      onSeatsLost?.(lost);
    }
    if (!key) lastReported.current = '';
  }, [lost, onSeatsLost]);

  return (
    <div className="stack">
      {lost.length > 0 && (
        <div className="notice notice-danger" role="alert">
          {t(lost.length === 1 ? 'seat.lostOne' : 'seat.lostMany', { seats: lost.join(', ') })}
        </div>
      )}
      {decks.map((deck) => (
        <Deck
          key={deck}
          label={decks.length > 1 ? t(deck === 1 ? 'seat.lowerDeck' : 'seat.upperDeck') : undefined}
          seats={seats.filter((s) => s.deck === deck)}
          selected={selected}
          onToggle={onToggle}
          maxSeats={maxSeats}
          disabled={disabled}
        />
      ))}

      <ul className="seat-legend">
        <li><i className="legend-swatch" style={{ background: 'var(--surface-2)' }} />{t('seat.available')}</li>
        <li><i className="legend-swatch" style={{ background: 'var(--accent)', borderColor: 'var(--accent-600)' }} />{t('seat.selected')}</li>
        <li><i className="legend-swatch" style={{ background: 'var(--sunken)' }} />{t('seat.sold')}</li>
        <li><i className="legend-swatch" style={{ background: 'var(--warn-tint)', borderColor: 'var(--warn)' }} />{t('seat.held')}</li>
        <li><i className="legend-swatch" style={{ borderColor: '#C2478E', borderWidth: 2 }} />{t('seatType.FEMALE_RESERVED')}</li>
      </ul>

      {multiLeg && (
        <p className="small muted" style={{ marginBottom: 0 }}>
          <strong style={{ color: 'var(--ink-2)' }}>{t('seat.legOnly')}.</strong>{' '}
          {t('seat.legExplain')}
        </p>
      )}
    </div>
  );
}

function Deck({
  label, seats, selected, onToggle, maxSeats, disabled,
}: {
  label?: string; seats: Seat[]; selected: string[];
  onToggle: (s: string) => void; maxSeats: number; disabled: boolean;
}) {
  const t = useT();
  const rows = Array.from(new Set(seats.map((s) => s.row))).sort((a, b) => a - b);
  const atLimit = selected.length >= maxSeats;

  return (
    <div>
      {label && <div className="small muted" style={{ marginBottom: '.4rem' }}>{label}</div>}
      <div className="bus">
        <div className="bus-front">
          <span>{t('seat.front')}</span>
          <div className="wheel" aria-hidden="true" />
        </div>

        {rows.map((row) => {
          const inRow = seats.filter((s) => s.row === row).sort((a, b) => a.col - b.col);
          return (
            <div className="seat-row" key={row}>
              {[1, 2, 0, 3, 4].map((col, i) =>
                col === 0 ? (
                  <div className="seat-aisle" key={`aisle-${i}`} aria-hidden="true" />
                ) : (
                  <SeatButton
                    key={col}
                    seat={inRow.find((s) => s.col === col)}
                    selected={selected}
                    onToggle={onToggle}
                    atLimit={atLimit}
                    disabled={disabled}
                  />
                )
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function SeatButton({
  seat, selected, onToggle, atLimit, disabled,
}: {
  seat?: Seat; selected: string[]; onToggle: (s: string) => void;
  atLimit: boolean; disabled: boolean;
}) {
  const t = useT();
  if (!seat) return <div aria-hidden="true" />;

  const isSelected = selected.includes(seat.seat_no);

  // REALITY OUTRANKS SELECTION. This used to read `isSelected ? 'selected' : …`,
  // so a seat the 15s poll had just reported sold to someone else stayed lit up
  // in the passenger's chosen colour, and they discovered the loss only when
  // createHold refused — which is precisely the "find out after you commit"
  // failure the homepage promises does not happen here.
  const state = seat.sold ? 'sold'
    : seat.held ? 'held'
    : seat.blocked ? 'blocked'
    : isSelected ? 'selected'
    : 'free';

  const typeLabel = SEAT_TYPE_KEY[seat.seat_type] ? t(SEAT_TYPE_KEY[seat.seat_type]) : '';

  const reason =
    state === 'sold' ? t('seat.sold')
    : state === 'held' ? t('seat.held')
    : state === 'blocked' ? (typeLabel || t('seat.blocked'))
    : state === 'selected' ? t('seat.selected')
    : (typeLabel || t('seat.available'));

  const blocked = state === 'sold' || state === 'held' || state === 'blocked';
  const isDisabled = disabled || blocked || (atLimit && !isSelected);

  return (
    <button
      type="button"
      className="seat"
      data-state={state}
      data-type={seat.seat_type}
      disabled={isDisabled}
      aria-pressed={isSelected}
      aria-label={`${t('ticket.seat')} ${seat.seat_no} — ${reason}`}
      title={`${seat.seat_no} — ${reason}`}
      onClick={() => onToggle(seat.seat_no)}
    >
      {seat.seat_no}
    </button>
  );
}
