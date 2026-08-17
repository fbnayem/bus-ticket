'use client';

import { use, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { api, ApiError, type Booking, type RescheduleOption, type SeatMap as SeatMapData } from '@/lib/api';
import { SeatMap } from '@/components/SeatMap';
import { ErrorNotice, Fascia, Loading } from '@/components/ui';
import { useLang } from '@/components/LangProvider';
import { Glyph } from '@/components/Glyph';

/**
 * Moving a booking to another departure.
 *
 * Two things were wrong here and only one of them was cosmetic.
 *
 * THE PRICE WAS INVENTED IN THE BROWSER. This page computed the new total as
 * `fare * seats + 5000`, a hardcoded copy of the platform's ৳50 service fee
 * that happened to match the server — until the day it did not. A passenger was
 * being quoted a figure by a program that has no authority to price anything.
 * The server now returns `total_poisha` and `difference_poisha` per option and
 * this page only renders them, so the number accepted is the number charged.
 *
 * THE DIFFERENCE WAS ARITHMETIC HOMEWORK. "Originally paid / New fare / To pay"
 * as three rows of a definition list asks the reader to subtract. They are
 * told the one figure that decides anything — what leaves or returns to their
 * pocket — in a sentence, with the workings underneath for anyone who wants it.
 */
export default function ReschedulePage({ params }: { params: Promise<{ pnr: string }> }) {
  const { pnr } = use(params);
  const router = useRouter();
  const { t, fmt } = useLang();

  const [booking, setBooking] = useState<Booking | null>(null);
  const [options, setOptions] = useState<RescheduleOption[]>([]);
  const [paid, setPaid] = useState(0);
  const [seatCount, setSeatCount] = useState(1);
  const [chosen, setChosen] = useState<RescheduleOption | null>(null);
  const [map, setMap] = useState<SeatMapData | null>(null);
  const [seats, setSeats] = useState<string[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    Promise.all([api.booking(pnr), api.rescheduleOptions(pnr)])
      .then(([b, o]) => {
        setBooking(b);
        setOptions(o.options);
        setSeatCount(o.seat_count);
        setPaid(o.paid_poisha);
      })
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

  // The server's figure, not ours.
  const diff = chosen?.difference_poisha ?? 0;
  const ready = !!chosen && seats.length === seatCount;

  // Departures grouped under a day heading, in the order the server sent them
  // (already ascending by departure), so the groups come out chronological
  // without a second sort.
  const byDay: [string, RescheduleOption[]][] = [];
  for (const o of options) {
    // fmt.day falls back to the date once a departure is further out than
    // tomorrow, so pairing the two unconditionally printed "Wed 19 Aug · Wed
    // 19 Aug". Only prefix it when it is actually saying something extra.
    const relative = fmt.day(o.depart_at);
    const dated = fmt.date(o.depart_at);
    const day = relative === dated ? dated : `${relative} · ${dated}`;
    const last = byDay[byDay.length - 1];
    if (last && last[0] === day) last[1].push(o);
    else byDay.push([day, [o]]);
  }

  return (
    <div className="page container">
      <div style={{ marginBottom: '.8rem' }}>
        <h1 style={{ fontSize: '1.35rem', marginBottom: '.2rem' }}>{t('rs.title')}</h1>
        <p className="muted small" style={{ margin: 0 }}>
          {booking.origin} → {booking.destination} · {seatCount === 1 ? t('ac.seat1') : t('ac.seatsN', { count: seatCount })}
        </p>
      </div>

      <div className="notice notice-info" style={{ marginBottom: '1rem' }}>
        {t('rs.safe')}
      </div>

      <div className="trip-layout">
        <div className="stack">
          <div className="card">
            <div className="card-head">{t('rs.step1')}</div>
            <div className="card-pad stack-sm">
              {options.length === 0 && (
                <p className="muted" style={{ marginBottom: 0 }}>{t('rs.none')}</p>
              )}
              {/*
                Grouped by day. The endpoint returns up to twenty departures,
                which arrived here as twenty identical rows carrying a date in
                grey sub-text — so choosing "the 22:00 one" meant reading every
                row to find out which day you were looking at. The date is the
                first thing a passenger changing their plans decides, so it is a
                heading, and the rows underneath only have to differ by time.
              */}
              {byDay.map(([day, rows]) => (
                <div key={day} className="stack-sm">
                  <div className="label" style={{ marginTop: '.35rem' }}>{day}</div>
                  {rows.map((o) => (
                    <button
                      key={o.trip_id}
                      type="button"
                      disabled={!o.eligible}
                      aria-pressed={chosen?.trip_id === o.trip_id}
                      className={`pick${chosen?.trip_id === o.trip_id ? ' is-chosen' : ''}`}
                      onClick={() => choose(o)}
                    >
                      <span className="pick-glyph"><Glyph name="clock" /></span>
                      <span className="pick-body">
                        <span className="pick-title">
                          {fmt.time(o.depart_at)} · {o.brand}
                        </span>
                        <span className="pick-note">
                          {o.bus_type} ·{' '}
                          {o.eligible
                            ? t('rs.seatsFree', { count: o.available_seats })
                            : t('rs.full')}
                        </span>
                      </span>
                      <span className="pick-end">
                        <span className="tnum" style={{ fontWeight: 700 }}>
                          {fmt.taka(o.total_poisha)}
                        </span>
                        <span className="pick-note" style={{ display: 'block' }}>
                          {o.difference_poisha > 0
                            ? `+${fmt.taka(o.difference_poisha)}`
                            : o.difference_poisha < 0
                              ? `−${fmt.taka(-o.difference_poisha)}`
                              : t('rs.samePrice')}
                        </span>
                      </span>
                    </button>
                  ))}
                </div>
              ))}
            </div>
          </div>

          {chosen && (
            <div className="card">
              <div className="card-head">{seatCount === 1 ? t('rs.step2one') : t('rs.step2', { count: seatCount })}</div>
              <div className="card-pad">
                {map
                  ? <SeatMap seats={map.seats} selected={seats} onToggle={toggle}
                             maxSeats={seatCount} disabled={busy} />
                  : <Loading rows={2} />}
              </div>
            </div>
          )}
        </div>

        <aside className="trip-aside stack">
          <div className="card card-pad stack">
            {/* The one figure that decides anything, said in words. */}
            {chosen ? (
              <div className={`moneyline ${diff < 0 ? 'is-back' : diff === 0 ? 'is-nil' : ''}`}>
                <span className="m-what">
                  {diff > 0 ? t('rs.toPay') : diff < 0 ? t('rs.backToYou') : ''}
                </span>
                <span className="m-amount">
                  {diff === 0 ? t('rs.noDifference') : fmt.taka(Math.abs(diff))}
                </span>
              </div>
            ) : (
              <p className="muted small" style={{ margin: 0 }}>{t('rs.pickFirst')}</p>
            )}

            {/* The workings, for anyone who wants to check them. */}
            <dl className="kv small">
              <dt>{t('rs.paid')}</dt><dd className="tnum">{fmt.taka(paid)}</dd>
              <dt>{t('rs.newFare')}</dt>
              <dd className="tnum">{chosen ? fmt.taka(chosen.total_poisha) : '—'}</dd>
            </dl>

            {error && <ErrorNotice message={error} />}

            <Link className="btn btn-ghost btn-block" href={`/manage/${pnr}`}>{t('rs.keep')}</Link>
          </div>
        </aside>
      </div>

      {/*
        One action, in the same fascia the funnel uses, so the last step of a
        change looks like the last step of a purchase. It carries the amount
        because a button that says "Confirm" beside a price the reader has
        scrolled past is how people pay for things they did not agree to.
      */}
      <Fascia
        total={chosen
          ? (diff === 0 ? t('rs.noDifference') : fmt.taka(Math.abs(diff)))
          : '—'}
        note={chosen
          ? (diff > 0 ? t('rs.toPay') : diff < 0 ? t('rs.backToYou') : undefined)
          : t('rs.pickFirst')}
        action={
          <button className="btn btn-primary btn-lg" disabled={!ready || busy} onClick={confirm}>
            {busy ? t('rs.working') : t('rs.confirm')}
          </button>
        }
      />
    </div>
  );
}
