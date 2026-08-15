'use client';

import { useCallback, useEffect, useState } from 'react';
import { api, ApiError, type Seat, type SearchResult } from '@/lib/api';
import { sget, spost } from '@/lib/staff';
import { quotaCache, queue, type QuotaSeat } from '@/lib/offline';
import { SeatMap } from '@/components/SeatMap';
import { ErrorNotice } from '@/components/ui';
import { PageHead, Money } from '@/components/staff-ui';
import { isoDate, timeOf, dateOf } from '@/lib/format';

// Offline quota.
//
// Reserving seats here takes them out of general sale platform-wide — they are
// blocked in the central inventory, so the website stops offering them. That is
// what makes selling them without a connection safe, and it is also why the
// quota is capped: a counter that could block a whole bus would.

export default function QuotaPage() {
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
      // Cache it so the seats are visible with no connection at all.
      quotaCache.set(r.quota);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not load the quota.');
    }
  }, []);

  useEffect(() => { void load(); setPendingQueue(queue.all().length); }, [load]);

  const search = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(''); setTrip(null);
    try {
      setResults((await api.search(from, to, date)).results);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Search failed.');
    }
  };

  const openTrip = async (t: SearchResult) => {
    setTrip(t); setPicked([]);
    setSeats((await api.seatmap(t.trip_id, t.board_seq, t.drop_seq)).seats);
  };

  const reserve = async () => {
    if (!trip) return;
    setBusy(true); setError('');
    try {
      await spost('/counter/quota', {
        trip_id: trip.trip_id, seats: picked,
        board_seq: trip.board_seq, drop_seq: trip.drop_seq,
      });
      setFlash(`Reserved ${picked.join(', ')}. They are now off sale everywhere else.`);
      setPicked([]);
      setSeats((await api.seatmap(trip.trip_id, trip.board_seq, trip.drop_seq)).seats);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Those seats could not be reserved.');
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
      setFlash(`Seat ${q.seat_no} is back on general sale.`);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'That seat could not be released.');
    }
  };

  return (
    <div className="stack">
      <PageHead
        title="Offline quota"
        sub="Seats this counter owns outright, so it can keep selling when the line drops"
      />

      {error && <ErrorNotice message={error} />}
      {flash && <div className="notice notice-info">{flash}</div>}
      {pendingQueue > 0 && (
        <div className="notice notice-warn">
          {pendingQueue} offline sale{pendingQueue === 1 ? '' : 's'} still waiting to sync.
          Releasing quota now will not affect them — they were sold from seats already owned.
        </div>
      )}

      <div className="card card-pad stack">
        <h3 style={{ marginBottom: 0 }}>Reserved now ({quota.length})</h3>
        {quota.length === 0 ? (
          <p className="muted small" style={{ marginBottom: 0 }}>
            Nothing reserved. With no quota, this counter cannot sell anything at
            all when the connection drops.
          </p>
        ) : (
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr><th>Seat</th><th>Journey</th><th>Departs</th><th /></tr>
              </thead>
              <tbody>
                {quota.map((q) => (
                  <tr key={q.trip_id + q.seat_no}>
                    <td className="mono"><strong>{q.seat_no}</strong></td>
                    <td>{q.from} → {q.to} <span className="muted small">{q.operator}</span></td>
                    <td>{q.depart_at ? `${dateOf(q.depart_at)} ${timeOf(q.depart_at)}` : '—'}</td>
                    <td><button className="btn btn-sm btn-ghost" onClick={() => release(q)}>Release</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <form className="card card-pad" onSubmit={search}>
        <div className="row" style={{ gap: '.6rem', alignItems: 'flex-end' }}>
          <div className="field" style={{ flex: '1 1 150px' }}>
            <label className="label" htmlFor="q-from">From</label>
            <input id="q-from" className="input" value={from} onChange={(e) => setFrom(e.target.value)} />
          </div>
          <div className="field" style={{ flex: '1 1 150px' }}>
            <label className="label" htmlFor="q-to">To</label>
            <input id="q-to" className="input" value={to} onChange={(e) => setTo(e.target.value)} />
          </div>
          <div className="field" style={{ flex: '0 1 170px' }}>
            <label className="label" htmlFor="q-date">Date</label>
            <input id="q-date" className="input" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          </div>
          <button className="btn btn-brand" type="submit">Find departures</button>
        </div>
      </form>

      {results && !trip && (
        <div className="table-wrap">
          <table className="data">
            <thead><tr><th>Departs</th><th>Operator</th><th className="num">Free</th><th className="num">Fare</th><th /></tr></thead>
            <tbody>
              {results.map((t) => (
                <tr key={t.trip_id}>
                  <td><strong>{timeOf(t.depart_at)}</strong></td>
                  <td>{t.brand} <span className="muted small">{t.bus_type}</span></td>
                  <td className="num">{t.available_seats}</td>
                  <td className="num"><Money poisha={t.fare_poisha} /></td>
                  <td><button className="btn btn-sm btn-brand" onClick={() => openTrip(t)}>Choose seats</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {trip && (
        <div className="card card-pad stack">
          <div className="row-between">
            <strong>{trip.brand} · {timeOf(trip.depart_at)} · {trip.origin} → {trip.destination}</strong>
            <button className="btn btn-ghost btn-sm" onClick={() => setTrip(null)}>Back</button>
          </div>
          <SeatMap
            seats={seats}
            selected={picked}
            maxSeats={8}
            onToggle={(s) => setPicked((cur) => (cur.includes(s) ? cur.filter((x) => x !== s) : [...cur, s]))}
          />
          <div className="row-between">
            <span className="small muted">
              Up to 8 seats per counter per trip. Reserved seats leave the public
              seat map immediately.
            </span>
            <button className="btn btn-primary" disabled={busy || picked.length === 0} onClick={reserve}>
              {busy ? 'Reserving…' : `Reserve ${picked.length} seat${picked.length === 1 ? '' : 's'}`}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
