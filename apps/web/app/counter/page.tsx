'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { api, ApiError, type Seat, type SearchResult } from '@/lib/api';
import { sget, spost } from '@/lib/staff';
import { queue, quotaCache, terminalId, type QuotaSeat } from '@/lib/offline';
import { SeatMap } from '@/components/SeatMap';
import { ErrorNotice, Loading } from '@/components/ui';
import { PageHead, Money } from '@/components/staff-ui';
import { isoDate, taka, timeOf, dateOf } from '@/lib/format';

// The counter sale.
//
// Two paths through this screen, and the difference is deliberate and visible:
//
//   Online  — search → the live seat map from inventory-service → hold → sell.
//             The clerk can sell any free seat on any bus.
//   Offline — the cached quota only. Seats this counter already owns, which
//             the website cannot see. Everything else is refused, because an
//             offline terminal cannot know whether a seat is still free.
//
// The offline restriction is not politeness. Selling shared inventory with no
// authoritative check is how two passengers end up holding the same seat at the
// bus door, and no reconciliation recovers from that.

interface CounterContext {
  counter_id: string;
  name: string;
  operator: string;
  operator_id: string;
  quota_seats: number;
  shift?: {
    shift_id: string;
    opened_at: string;
    opening_float_poisha: number;
    expected_cash_poisha: number;
    sale_count: number;
  };
}

const SERVICE_FEE = 5000;

export default function CounterSellPage() {
  const [ctx, setCtx] = useState<CounterContext | null>(null);
  const [offline, setOffline] = useState(false);
  const [pending, setPending] = useState(0);
  const [error, setError] = useState('');
  const [flash, setFlash] = useState('');

  const refresh = useCallback(() => {
    sget<CounterContext>('/counter/context').then(setCtx).catch((e: ApiError) => setError(e.message));
  }, []);

  useEffect(() => {
    refresh();
    setOffline(typeof navigator !== 'undefined' && !navigator.onLine);
    setPending(queue.all().length);
    const on = () => setOffline(false);
    const off = () => setOffline(true);
    window.addEventListener('online', on);
    window.addEventListener('offline', off);
    return () => { window.removeEventListener('online', on); window.removeEventListener('offline', off); };
  }, [refresh]);

  const flush = useCallback(async () => {
    const sales = queue.all();
    if (sales.length === 0) return;
    try {
      const res = await spost<{ results: { client_ref: string; outcome: string; pnr?: string; reason?: string }[] }>(
        '/counter/offline-sales', { sales: sales.map(({ label, ...s }) => s) });
      const settled = res.results.filter((r) => r.outcome !== 'error').map((r) => r.client_ref);
      queue.remove(settled);
      setPending(queue.all().length);
      const booked = res.results.filter((r) => r.outcome === 'booked').length;
      const rejected = res.results.filter((r) => r.outcome === 'rejected');
      setFlash(
        `Synced ${booked} sale${booked === 1 ? '' : 's'}` +
        (rejected.length ? ` · ${rejected.length} refused: ${rejected[0].reason}` : ''),
      );
      refresh();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'The queue could not be synced.');
    }
  }, [refresh]);

  // Flush automatically the moment the line comes back.
  useEffect(() => { if (!offline) void flush(); }, [offline, flush]);

  if (!ctx && !error) return <div><Loading rows={2} /></div>;

  return (
    <div className="stack">
      <PageHead
        title="Sell a ticket"
        sub={ctx ? `${ctx.name} · ${ctx.operator} · terminal ${typeof window !== 'undefined' ? terminalId() : ''}` : ''}
        actions={
          <>
            <button className="btn btn-ghost btn-sm" onClick={() => setOffline((v) => !v)}>
              {offline ? 'Simulate reconnect' : 'Simulate line drop'}
            </button>
            <Link className="btn btn-ghost btn-sm" href="/counter/shift">Drawer</Link>
          </>
        }
      />

      {error && <ErrorNotice message={error} onRetry={refresh} />}
      {flash && <div className="notice notice-info">{flash}</div>}

      {offline && (
        <div className="offline-bar">
          <span>
            <strong>Offline.</strong> You can only sell seats this counter already
            reserved. Everything else needs the line back — an offline terminal
            cannot tell whether a seat is still free.
          </span>
          <span>{pending} sale{pending === 1 ? '' : 's'} waiting to sync</span>
        </div>
      )}
      {!offline && pending > 0 && (
        <div className="offline-bar">
          <span>{pending} offline sale{pending === 1 ? '' : 's'} not yet synced.</span>
          <button className="btn btn-sm btn-primary" onClick={flush}>Sync now</button>
        </div>
      )}

      {!ctx?.shift && (
        <div className="notice notice-warn">
          No shift is open on this counter. <Link href="/counter/shift">Open the drawer</Link> before
          taking cash — a cash sale with no open shift has nowhere to be counted at close.
        </div>
      )}

      {offline
        ? <OfflineSale ctx={ctx} onQueued={() => setPending(queue.all().length)} />
        : <OnlineSale ctx={ctx} onSold={refresh} />}
    </div>
  );
}

/* ------------------------------------------------------------------ online -- */

function OnlineSale({ ctx, onSold }: { ctx: CounterContext | null; onSold: () => void }) {
  const [from, setFrom] = useState('Dhaka');
  const [to, setTo] = useState('Chattogram');
  const [date, setDate] = useState(isoDate(new Date()));
  const [results, setResults] = useState<SearchResult[] | null>(null);
  const [searching, setSearching] = useState(false);

  const [trip, setTrip] = useState<SearchResult | null>(null);
  const [seats, setSeats] = useState<Seat[]>([]);
  const [picked, setPicked] = useState<string[]>([]);
  const [names, setNames] = useState<Record<string, string>>({});
  const [phone, setPhone] = useState('');
  const [method, setMethod] = useState('CASH');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [receipt, setReceipt] = useState<SaleReceipt | null>(null);

  const search = async (e: React.FormEvent) => {
    e.preventDefault();
    setSearching(true); setError(''); setTrip(null); setResults(null);
    try {
      const r = await api.search(from, to, date);
      setResults(r.results);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Search failed.');
    } finally {
      setSearching(false);
    }
  };

  const openTrip = async (t: SearchResult) => {
    setTrip(t); setPicked([]); setNames({}); setError(''); setReceipt(null);
    const map = await api.seatmap(t.trip_id, t.board_seq, t.drop_seq);
    setSeats(map.seats);
  };

  const reloadSeats = async () => {
    if (!trip) return;
    const map = await api.seatmap(trip.trip_id, trip.board_seq, trip.drop_seq);
    setSeats(map.seats);
  };

  const toggle = (seatNo: string) =>
    setPicked((cur) => (cur.includes(seatNo) ? cur.filter((s) => s !== seatNo) : [...cur, seatNo]));

  const total = trip ? trip.fare_poisha * picked.length + SERVICE_FEE : 0;

  const sell = async () => {
    if (!trip) return;
    setBusy(true); setError('');
    try {
      const res = await spost<SaleReceipt>('/counter/sales', {
        shift_id: ctx?.shift?.shift_id ?? '',
        trip_id: trip.trip_id,
        seats: picked,
        board_seq: trip.board_seq,
        drop_seq: trip.drop_seq,
        passengers: picked.map((s) => ({ seat_no: s, full_name: names[s] || 'Passenger' })),
        phone,
        method,
      });
      setReceipt({ ...res, trip });
      setPicked([]); setNames({}); setPhone('');
      onSold();
      void reloadSeats();
    } catch (err) {
      const e = err as ApiError;
      setError(e.message);
      // A 409 means somebody else took the seat between drawing this map and
      // pressing sell. Redraw rather than let the clerk try the same seat again.
      if (e.status === 409) { setPicked([]); void reloadSeats(); }
    } finally {
      setBusy(false);
    }
  };

  if (receipt) return <Receipt receipt={receipt} onNew={() => { setReceipt(null); setTrip(null); setResults(null); }} />;

  return (
    <div className="stack">
      <form className="card card-pad" onSubmit={search}>
        <div className="row" style={{ gap: '.6rem', alignItems: 'flex-end' }}>
          <div className="field" style={{ flex: '1 1 160px' }}>
            <label className="label" htmlFor="c-from">From</label>
            <input id="c-from" className="input" value={from} onChange={(e) => setFrom(e.target.value)} />
          </div>
          <div className="field" style={{ flex: '1 1 160px' }}>
            <label className="label" htmlFor="c-to">To</label>
            <input id="c-to" className="input" value={to} onChange={(e) => setTo(e.target.value)} />
          </div>
          <div className="field" style={{ flex: '0 1 170px' }}>
            <label className="label" htmlFor="c-date">Date</label>
            <input id="c-date" className="input" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          </div>
          <button className="btn btn-primary" type="submit" disabled={searching}>
            {searching ? 'Searching…' : 'Find departures'}
          </button>
        </div>
      </form>

      {error && <ErrorNotice message={error} />}

      {results && !trip && (
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>Departs</th><th>Operator</th><th>Bus</th>
                <th className="num">Free</th><th className="num">Fare</th><th />
              </tr>
            </thead>
            <tbody>
              {results.map((t) => (
                <tr key={t.trip_id}>
                  <td><strong>{timeOf(t.depart_at)}</strong> <span className="muted small">{dateOf(t.depart_at)}</span></td>
                  <td>{t.brand}</td>
                  <td className="muted">{t.bus_type}</td>
                  <td className="num">{t.available_seats}</td>
                  <td className="num"><Money poisha={t.fare_poisha} /></td>
                  <td><button className="btn btn-sm btn-brand" onClick={() => openTrip(t)}>Seats</button></td>
                </tr>
              ))}
              {results.length === 0 && (
                <tr><td colSpan={6} className="muted center">No departures on that day.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      {trip && (
        <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr) 320px', gap: '1rem', alignItems: 'start' }}>
          <div className="card card-pad stack">
            <div className="row-between">
              <div>
                <strong>{trip.brand}</strong> · {timeOf(trip.depart_at)} · {trip.origin} → {trip.destination}
                <div className="small muted">{trip.bus_type} · {trip.registration}</div>
              </div>
              <button className="btn btn-ghost btn-sm" onClick={() => setTrip(null)}>Change departure</button>
            </div>
            <p className="small muted" style={{ marginBottom: 0 }}>
              This is the live map from inventory-service — the same one the
              website is drawing right now.
            </p>
            <SeatMap seats={seats} selected={picked} onToggle={toggle} maxSeats={6} />
          </div>

          <div className="card card-pad stack">
            <h3>Passengers</h3>
            {picked.length === 0 && <p className="muted small">Pick seats on the map.</p>}
            {picked.map((s) => (
              <div className="field" key={s}>
                <label className="label" htmlFor={`pax-${s}`}>Seat {s}</label>
                <input
                  id={`pax-${s}`} className="input" placeholder="Passenger name"
                  value={names[s] ?? ''} onChange={(e) => setNames({ ...names, [s]: e.target.value })}
                />
              </div>
            ))}
            <div className="field">
              <label className="label" htmlFor="c-phone">Mobile number</label>
              <input id="c-phone" className="input" placeholder="+8801…" value={phone}
                     onChange={(e) => setPhone(e.target.value)} />
            </div>
            <div className="field">
              <label className="label" htmlFor="c-method">Payment</label>
              <select id="c-method" className="select" value={method} onChange={(e) => setMethod(e.target.value)}>
                <option value="CASH">Cash</option>
                <option value="BKASH">bKash</option>
                <option value="NAGAD">Nagad</option>
                <option value="CARD">Card</option>
              </select>
            </div>

            <dl className="kv">
              <dt>{picked.length} × fare</dt><dd><Money poisha={trip.fare_poisha * picked.length} /></dd>
              <dt>Service fee</dt><dd><Money poisha={SERVICE_FEE} /></dd>
              <dt><strong>Total</strong></dt><dd><strong><Money poisha={total} decimals /></strong></dd>
            </dl>

            <button
              className="btn btn-primary btn-block btn-lg"
              disabled={busy || picked.length === 0 || !phone || (method === 'CASH' && !ctx?.shift)}
              onClick={sell}
            >
              {busy ? 'Taking payment…' : `Take ${method === 'CASH' ? 'cash' : method} · ${taka(total)}`}
            </button>
            {method === 'CASH' && !ctx?.shift && (
              <p className="small muted" style={{ marginBottom: 0 }}>Open a shift to take cash.</p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/* ----------------------------------------------------------------- offline -- */

function OfflineSale({ ctx, onQueued }: { ctx: CounterContext | null; onQueued: () => void }) {
  const [quota, setQuota] = useState<QuotaSeat[]>([]);
  const [picked, setPicked] = useState<QuotaSeat[]>([]);
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [done, setDone] = useState('');

  useEffect(() => { setQuota(quotaCache.get()); }, []);

  const byTrip = quota.reduce<Record<string, QuotaSeat[]>>((acc, q) => {
    (acc[q.trip_id] ||= []).push(q);
    return acc;
  }, {});

  const sell = () => {
    if (picked.length === 0) return;
    const trip = picked[0];
    const fare = trip.fare_poisha ?? 0;
    const entry = queue.add({
      trip_id: trip.trip_id,
      seats: picked.map((p) => p.seat_no),
      board_seq: trip.board_seq,
      drop_seq: trip.drop_seq,
      passengers: picked.map((p) => ({ seat_no: p.seat_no, full_name: name || 'Passenger' })),
      phone,
      total_poisha: fare * picked.length + SERVICE_FEE,
      sold_at: new Date().toISOString(),
      shift_id: ctx?.shift?.shift_id ?? '',
      label: `${trip.from ?? ''} → ${trip.to ?? ''}`,
    });
    quotaCache.consume(trip.trip_id, picked.map((p) => p.seat_no));
    setQuota(quotaCache.get());
    setPicked([]); setName(''); setPhone('');
    setDone(`Queued ${entry.seats.join(', ')} — reference ${entry.client_ref.slice(-8)}. ` +
            'Write the seat and reference on the paper ticket. It books when the line returns.');
    onQueued();
  };

  if (quota.length === 0) {
    return (
      <div className="card card-pad">
        <h3 style={{ marginBottom: '.3rem' }}>No reserved seats to sell</h3>
        <p className="muted" style={{ marginBottom: '.6rem' }}>
          This counter holds no quota, so there is nothing it can sell without the
          line. Reserve seats while you still have a connection.
        </p>
        <Link className="btn btn-primary" href="/counter/quota">Reserve seats</Link>
      </div>
    );
  }

  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr) 320px', gap: '1rem', alignItems: 'start' }}>
      <div className="card card-pad stack">
        <h3>Seats this counter owns</h3>
        <p className="small muted">
          These are reserved in the central inventory and invisible to the
          website, so selling them offline cannot double-book anyone.
        </p>
        {Object.entries(byTrip).map(([tripId, list]) => (
          <div key={tripId} className="stack-sm">
            <strong className="small">
              {list[0].from} → {list[0].to} · {list[0].depart_at ? timeOf(list[0].depart_at) : ''}{' '}
              <span className="muted">{list[0].operator}</span>
            </strong>
            <div className="row" style={{ gap: '.4rem' }}>
              {list.map((q) => {
                const on = picked.some((p) => p.trip_id === q.trip_id && p.seat_no === q.seat_no);
                return (
                  <button
                    key={q.seat_no}
                    type="button"
                    className="seat"
                    data-state={on ? 'selected' : 'free'}
                    onClick={() =>
                      setPicked((cur) =>
                        on ? cur.filter((p) => !(p.trip_id === q.trip_id && p.seat_no === q.seat_no))
                           : [...cur.filter((p) => p.trip_id === q.trip_id), q])}
                  >
                    {q.seat_no}
                  </button>
                );
              })}
            </div>
          </div>
        ))}
      </div>

      <div className="card card-pad stack">
        <h3>Offline sale</h3>
        {done && <div className="notice notice-info small">{done}</div>}
        <div className="field">
          <label className="label" htmlFor="off-name">Passenger name</label>
          <input id="off-name" className="input" value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <div className="field">
          <label className="label" htmlFor="off-phone">Mobile number</label>
          <input id="off-phone" className="input" value={phone} onChange={(e) => setPhone(e.target.value)} />
        </div>
        <dl className="kv">
          <dt>Seats</dt><dd>{picked.map((p) => p.seat_no).join(', ') || '—'}</dd>
          <dt>Payment</dt><dd>Cash only</dd>
        </dl>
        <button className="btn btn-primary btn-block" disabled={picked.length === 0} onClick={sell}>
          Record cash sale
        </button>
        <p className="small muted" style={{ marginBottom: 0 }}>
          No PNR is issued offline. The passenger gets a paper ticket now and the
          real ticket when the terminal reconnects.
        </p>
      </div>
    </div>
  );
}

/* ----------------------------------------------------------------- receipt -- */

interface SaleReceipt {
  pnr: string;
  seats: string[];
  total_poisha: number;
  method: string;
  tickets: { seat_no: string; passenger?: string }[];
  trip?: SearchResult;
}

function Receipt({ receipt, onNew }: { receipt: SaleReceipt; onNew: () => void }) {
  return (
    <div className="card card-pad stack" style={{ maxWidth: 460 }}>
      <div className="row-between">
        <h2 style={{ marginBottom: 0 }}>Sold</h2>
        <span className="pill pill-ok">{receipt.method}</span>
      </div>
      <div className="pnr">{receipt.pnr}</div>
      {receipt.trip && (
        <div className="small muted">
          {receipt.trip.brand} · {receipt.trip.origin} → {receipt.trip.destination} ·{' '}
          {dateOf(receipt.trip.depart_at)} {timeOf(receipt.trip.depart_at)}
        </div>
      )}
      <table className="data">
        <thead><tr><th>Seat</th><th>Passenger</th></tr></thead>
        <tbody>
          {receipt.tickets.map((t) => (
            <tr key={t.seat_no}><td className="mono">{t.seat_no}</td><td>{t.passenger || '—'}</td></tr>
          ))}
        </tbody>
      </table>
      <dl className="kv">
        <dt>Collected</dt><dd><strong><Money poisha={receipt.total_poisha} decimals /></strong></dd>
      </dl>
      <div className="row no-print">
        <button className="btn btn-primary" onClick={() => window.print()}>Print ticket</button>
        <button className="btn btn-ghost" onClick={onNew}>Next sale</button>
        <Link className="btn btn-ghost" href={`/tickets/${receipt.pnr}`}>Open ticket</Link>
      </div>
    </div>
  );
}
