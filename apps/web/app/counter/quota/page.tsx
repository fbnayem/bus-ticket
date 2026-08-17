'use client';

import { useCallback, useEffect, useState } from 'react';
import { api, ApiError, type Seat, type SearchResult } from '@/lib/api';
import { sget, spost } from '@/lib/staff';
import { quotaCache, queue, type QuotaSeat } from '@/lib/offline';
import { SeatMap } from '@/components/SeatMap';
import { LocationPicker } from '@/components/LocationPicker';
import { ErrorNotice } from '@/components/ui';
import { PageHead, Money } from '@/components/staff-ui';
import { useLang } from '@/components/LangProvider';
import { isoDate } from '@/lib/format';
import { errorText } from '@/lib/i18n';

// Seats held back for this counter.
//
// Holding a seat here takes it out of general sale platform-wide — it is
// blocked in the central inventory, so the website stops offering it. That is
// what makes selling it without a connection safe, and it is also why the
// number is capped: a counter that could block a whole bus would.

export default function QuotaPage() {
  const { t, fmt } = useLang();
  const [quota, setQuota] = useState<QuotaSeat[]>([]);
  const [error, setError] = useState('');
  const [flash, setFlash] = useState('');
  const [pendingQueue, setPendingQueue] = useState(0);

  const [from, setFrom] = useState('Dhaka');
  const [to, setTo] = useState('Chattogram');
  const [date, setDate] = useState(isoDate(new Date()));
  const [results, setResults] = useState<SearchResult[] | null>(null);
  const [trip, setTrip] = useState<SearchResult | null>(null);
  const [seats, setSeats] = useState<Seat[]>([]);
  const [picked, setPicked] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const r = await sget<{ quota: QuotaSeat[] }>('/counter/quota');
      setQuota(r.quota);
      // Cached so the seats are visible with no connection at all.
      quotaCache.set(r.quota);
    } catch (e) {
      setError(errorText(t, e, 'co.q.failLoad'));
    }
  }, [t]);

  useEffect(() => { void load(); setPendingQueue(queue.all().length); }, [load]);

  const search = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(''); setTrip(null);
    try {
      setResults((await api.search(from, to, date)).results);
    } catch (err) {
      setError(errorText(t, err, 'co.q.failSearch'));
    }
  };

  const openTrip = async (tr: SearchResult) => {
    setTrip(tr); setPicked([]);
    setSeats((await api.seatmap(tr.trip_id, tr.board_seq, tr.drop_seq)).seats);
  };

  const reserve = async () => {
    if (!trip) return;
    setBusy(true); setError('');
    try {
      await spost('/counter/quota', {
        trip_id: trip.trip_id, seats: picked,
        board_seq: trip.board_seq, drop_seq: trip.drop_seq,
      });
      setFlash(t('co.q.reserved', { seats: picked.join(', ') }));
      setPicked([]);
      setSeats((await api.seatmap(trip.trip_id, trip.board_seq, trip.drop_seq)).seats);
      await load();
    } catch (err) {
      setError(errorText(t, err, 'co.q.failReserve'));
    } finally {
      setBusy(false);
    }
  };

  const release = async (q: QuotaSeat) => {
    try {
      await spost('/counter/quota/release', {
        trip_id: q.trip_id, seats: [q.seat_no],
        board_seq: q.board_seq, drop_seq: q.drop_seq,
      });
      setFlash(t('co.q.released', { seat: q.seat_no }));
      await load();
    } catch (err) {
      setError(errorText(t, err, 'co.q.failRelease'));
    }
  };

  return (
    <div className="stack">
      <PageHead title={t('co.nav.quota')} sub={t('co.q.sub')} />

      {error && <ErrorNotice message={error} />}
      {flash && <div className="notice notice-info">{flash}</div>}
      {pendingQueue > 0 && (
        <div className="notice notice-warn">
          {pendingQueue === 1 ? t('co.q.pending1') : t('co.q.pending', { count: pendingQueue })}
        </div>
      )}

      <div className="card card-pad stack">
        <h3 style={{ marginBottom: 0 }}>{t('co.q.heldNow', { count: quota.length })}</h3>
        {quota.length === 0 ? (
          <p className="muted small" style={{ marginBottom: 0 }}>{t('co.q.none')}</p>
        ) : (
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>{t('co.seats')}</th><th>{t('co.q.journey')}</th>
                  <th>{t('co.departs')}</th><th />
                </tr>
              </thead>
              <tbody>
                {quota.map((q) => (
                  <tr key={q.trip_id + q.seat_no}>
                    <td className="mono"><strong>{q.seat_no}</strong></td>
                    <td>{q.from} → {q.to} <span className="muted small">{q.operator}</span></td>
                    <td>{q.depart_at ? fmt.dateTime(q.depart_at) : '—'}</td>
                    <td>
                      <button className="btn btn-sm btn-ghost" onClick={() => release(q)}>
                        {t('co.q.release')}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <form className="card card-pad" onSubmit={search}>
        <div className="row" style={{ gap: '.6rem', alignItems: 'flex-end' }}>
          <div style={{ flex: '1 1 150px' }}>
            <LocationPicker id="q-from" label={t('co.from')} value={from} onChange={setFrom} />
          </div>
          <div style={{ flex: '1 1 150px' }}>
            <LocationPicker id="q-to" label={t('co.to')} value={to} onChange={setTo} />
          </div>
          <div className="field" style={{ flex: '0 1 170px' }}>
            <label className="label" htmlFor="q-date">{t('co.date')}</label>
            <input id="q-date" className="input" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          </div>
          <button className="btn btn-brand" type="submit">{t('co.find')}</button>
        </div>
      </form>

      {results && !trip && (
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>{t('co.departs')}</th><th>{t('co.app')}</th>
                <th className="num">{t('co.free')}</th>
                <th className="num">{t('co.fare')}</th><th />
              </tr>
            </thead>
            <tbody>
              {results.map((tr) => (
                // The same stable hooks the sell screen carries, so a test reads
                // the free-seat count by name rather than by column position.
                <tr key={tr.trip_id} data-trip={tr.trip_id} data-free={tr.available_seats}>
                  <td><strong>{fmt.time(tr.depart_at)}</strong></td>
                  <td>{tr.brand} <span className="muted small">{tr.bus_type}</span></td>
                  <td className="num">{tr.available_seats}</td>
                  <td className="num"><Money poisha={tr.fare_poisha} /></td>
                  <td>
                    <button className="btn btn-sm btn-brand" onClick={() => openTrip(tr)}>
                      {t('co.q.chooseSeats')}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {trip && (
        <div className="card card-pad stack">
          <div className="row-between">
            <strong>{trip.brand} · {fmt.time(trip.depart_at)} · {trip.origin} → {trip.destination}</strong>
            <button className="btn btn-ghost btn-sm" onClick={() => setTrip(null)}>{t('co.confirmNo')}</button>
          </div>
          <SeatMap
            seats={seats}
            selected={picked}
            maxSeats={8}
            onToggle={(s) => setPicked((cur) => (cur.includes(s) ? cur.filter((x) => x !== s) : [...cur, s]))}
          />
          <div className="row-between">
            <span className="small muted">{t('co.q.cap')}</span>
            <button className="btn btn-primary" disabled={busy || picked.length === 0}
                    onClick={reserve} data-act="reserve-quota">
              {busy
                ? t('co.q.reserving')
                : picked.length === 1 ? t('co.q.reserve1') : t('co.q.reserveN', { count: picked.length })}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
