'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { api, ApiError, type Seat, type SearchResult } from '@/lib/api';
import { sget, spost } from '@/lib/staff';
import { queue, quotaCache, terminalId, type QuotaSeat } from '@/lib/offline';
import { SeatMap } from '@/components/SeatMap';
import { ErrorNotice, Loading } from '@/components/ui';
import { PageHead, Money } from '@/components/staff-ui';
import { useLang } from '@/components/LangProvider';
import { isoDate } from '@/lib/format';

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
//
// ---------------------------------------------------------------------------
// This screen is worked by a trained clerk with a queue in front of them, so it
// is keyboard-first: Enter searches, 1–9 opens a departure, Ctrl+Enter takes
// payment, Esc steps back. Speed wins ties — but not on money. Taking cash
// raises a confirm that names the amount and the seats, because the one thing
// worse than a slow sale is a sale on the wrong bus with the notes already in
// the drawer.
//
// The total is the SERVER'S. This file used to carry `const SERVICE_FEE = 5000`
// and add it to the fare in the browser, and the clerk then took that many taka
// in cash across the counter. It comes from /counter/context now.

interface CounterContext {
  counter_id: string;
  name: string;
  operator: string;
  operator_id: string;
  quota_seats: number;
  service_fee_poisha: number;
  shift?: {
    shift_id: string;
    opened_at: string;
    opening_float_poisha: number;
    expected_cash_poisha: number;
    sale_count: number;
  };
}

export default function CounterSellPage() {
  const { t } = useLang();
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
        (booked === 1 ? t('co.synced1') : t('co.synced', { count: booked })) +
        (rejected.length
          ? ' · ' + t('co.refused', { count: rejected.length, reason: rejected[0].reason ?? '' })
          : ''),
      );
      refresh();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'The queue could not be synced.');
    }
  }, [refresh, t]);

  // Flush automatically the moment the line comes back.
  useEffect(() => { if (!offline) void flush(); }, [offline, flush]);

  if (!ctx && !error) return <div><Loading rows={2} /></div>;

  return (
    <div className="stack">
      <PageHead
        title={t('co.title')}
        sub={ctx
          ? `${ctx.name} · ${ctx.operator} · ${t('co.terminal')} ${typeof window !== 'undefined' ? terminalId() : ''}`
          : ''}
        actions={
          <>
            <button className="btn btn-ghost btn-sm" onClick={() => setOffline((v) => !v)}>
              {offline ? t('co.simBack') : t('co.simDrop')}
            </button>
            <Link className="btn btn-ghost btn-sm" href="/counter/shift">{t('co.nav.shift')}</Link>
          </>
        }
      />

      {error && <ErrorNotice message={error} onRetry={refresh} />}
      {flash && <div className="notice notice-info" role="status">{flash}</div>}

      {offline && (
        <div className="offline-bar">
          <span><strong>{t('co.offline')}.</strong> {t('co.offlineBody')}</span>
          <span>{t('co.waiting', { count: pending })}</span>
        </div>
      )}
      {!offline && pending > 0 && (
        <div className="offline-bar">
          <span>{t('co.waiting', { count: pending })}</span>
          <button className="btn btn-sm btn-primary" onClick={flush}>{t('co.syncNow')}</button>
        </div>
      )}

      {!ctx?.shift && (
        <div className="notice notice-warn">
          {t('co.noShift')}{' '}
          <Link href="/counter/shift">{t('co.openDrawer')}</Link>
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
  const { t, fmt } = useLang();
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
  const [tendered, setTendered] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [receipt, setReceipt] = useState<SaleReceipt | null>(null);

  const fromRef = useRef<HTMLInputElement>(null);

  const search = useCallback(async (e?: React.FormEvent) => {
    e?.preventDefault();
    setSearching(true); setError(''); setTrip(null); setResults(null);
    try {
      const r = await api.search(from, to, date);
      setResults(r.results);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Search failed.');
    } finally {
      setSearching(false);
    }
  }, [from, to, date]);

  const openTrip = useCallback(async (tr: SearchResult) => {
    setTrip(tr); setPicked([]); setNames({}); setError(''); setReceipt(null);
    const map = await api.seatmap(tr.trip_id, tr.board_seq, tr.drop_seq);
    setSeats(map.seats);
  }, []);

  const reloadSeats = async () => {
    if (!trip) return;
    const map = await api.seatmap(trip.trip_id, trip.board_seq, trip.drop_seq);
    setSeats(map.seats);
  };

  const toggle = (seatNo: string) =>
    setPicked((cur) => (cur.includes(seatNo) ? cur.filter((s) => s !== seatNo) : [...cur, seatNo]));

  // The server's fee, not a copy of it.
  const fee = ctx?.service_fee_poisha ?? 0;
  const total = trip ? trip.fare_poisha * picked.length + fee : 0;
  const sellable = !!trip && picked.length > 0 && !!phone && !(method === 'CASH' && !ctx?.shift);

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
      setReceipt({ ...res, trip, tendered_poisha: Math.round(Number(tendered || 0) * 100) });
      setPicked([]); setNames({}); setPhone(''); setTendered(''); setConfirming(false);
      onSold();
      void reloadSeats();
    } catch (err) {
      const e = err as ApiError;
      setError(e.message);
      setConfirming(false);
      // A 409 means somebody else took the seat between drawing this map and
      // pressing sell. Redraw rather than let the clerk try the same seat again.
      if (e.status === 409) { setPicked([]); void reloadSeats(); }
    } finally {
      setBusy(false);
    }
  };

  /*
   * The keyboard. A clerk facing a queue works this screen without a mouse, so
   * the three moves that repeat hundreds of times a day each have a key:
   * Ctrl+Enter takes payment, 1–9 opens a departure from the results, Esc
   * steps back one level. Digits are ignored while a field has focus, or the
   * clerk could not type a phone number.
   */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const inField = /^(INPUT|SELECT|TEXTAREA)$/.test((e.target as HTMLElement)?.tagName ?? '');

      if (e.key === 'Escape') {
        if (confirming) { setConfirming(false); return; }
        if (trip) { setTrip(null); return; }
        if (results) { setResults(null); fromRef.current?.focus(); }
        return;
      }
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        if (confirming) void sell();
        else if (sellable) setConfirming(true);
        return;
      }
      if (!inField && !trip && results && /^[1-9]$/.test(e.key)) {
        const pick = results[Number(e.key) - 1];
        if (pick) { e.preventDefault(); void openTrip(pick); }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  if (receipt) {
    return <Receipt receipt={receipt} onNew={() => {
      setReceipt(null); setTrip(null); setResults(null); fromRef.current?.focus();
    }} />;
  }

  const methodLabel = method === 'CASH' ? t('co.cash') : method === 'CARD' ? t('co.card') : method;

  return (
    <div className="stack">
      <form className="card card-pad" onSubmit={search}>
        <div className="row" style={{ gap: '.6rem', alignItems: 'flex-end' }}>
          <div className="field" style={{ flex: '1 1 160px' }}>
            <label className="label" htmlFor="c-from">{t('co.from')}</label>
            <input ref={fromRef} id="c-from" className="input" value={from}
                   onChange={(e) => setFrom(e.target.value)} />
          </div>
          <div className="field" style={{ flex: '1 1 160px' }}>
            <label className="label" htmlFor="c-to">{t('co.to')}</label>
            <input id="c-to" className="input" value={to} onChange={(e) => setTo(e.target.value)} />
          </div>
          <div className="field" style={{ flex: '0 1 170px' }}>
            <label className="label" htmlFor="c-date">{t('co.date')}</label>
            <input id="c-date" className="input" type="date" value={date}
                   onChange={(e) => setDate(e.target.value)} />
          </div>
          <button className="btn btn-primary" type="submit" disabled={searching}>
            {searching ? t('co.finding') : t('co.find')}
          </button>
        </div>
        <KeyHints hints={['co.kbd.search', 'co.kbd.pick', 'co.kbd.sell', 'co.kbd.back']} />
      </form>

      {error && <ErrorNotice message={error} />}

      {results && !trip && (
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th style={{ width: 34 }} />
                <th>{t('co.departs')}</th><th>{t('trip.operator')}</th><th>{t('mb.bus')}</th>
                <th className="num">{t('co.free')}</th><th className="num">{t('co.fare')}</th><th />
              </tr>
            </thead>
            <tbody>
              {results.map((tr, i) => (
                // data-free is a stable hook for the free-seat count. The staff
                // suite used to read it as "the fourth cell", which quietly
                // became the wrong cell the moment this table grew a column for
                // the keyboard numbers — position is not an identity.
                <tr key={tr.trip_id} data-trip={tr.trip_id} data-free={tr.available_seats}>
                  {/* The number the clerk presses. Only the first nine get one —
                      claiming a tenth key that does nothing would be worse. */}
                  <td>{i < 9 && <kbd className="keycap">{i + 1}</kbd>}</td>
                  <td>
                    <strong>{fmt.time(tr.depart_at)}</strong>{' '}
                    <span className="muted small">{fmt.date(tr.depart_at)}</span>
                  </td>
                  <td>{tr.brand}</td>
                  <td className="muted">{tr.bus_type}</td>
                  <td className="num">{tr.available_seats}</td>
                  <td className="num"><Money poisha={tr.fare_poisha} /></td>
                  <td>
                    <button className="btn btn-sm btn-brand" onClick={() => openTrip(tr)}>
                      {t('co.seats')}
                    </button>
                  </td>
                </tr>
              ))}
              {results.length === 0 && (
                <tr><td colSpan={7} className="muted center">{t('co.noDepartures')}</td></tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      {trip && (
        <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr) 340px', gap: '1rem', alignItems: 'start' }}>
          {/* data-trip names the departure this terminal is selling, so a test
              can compare this exact trip against the public site rather than
              guessing which of the operator's departures it landed on. */}
          <div className="card card-pad stack" data-trip={trip.trip_id}>
            <div className="row-between">
              <div>
                <strong>{trip.brand}</strong> · {fmt.time(trip.depart_at)} ·{' '}
                {trip.origin} → {trip.destination}
                <div className="small muted">{trip.bus_type} · {trip.registration}</div>
              </div>
              <button className="btn btn-ghost btn-sm" onClick={() => setTrip(null)}>
                {t('co.change')}
              </button>
            </div>
            <p className="small muted" style={{ marginBottom: 0 }}>{t('co.liveMap')}</p>
            <SeatMap seats={seats} selected={picked} onToggle={toggle} maxSeats={6} />
          </div>

          <div className="card card-pad stack">
            <h3>{t('co.passengers')}</h3>
            {picked.length === 0 && <p className="muted small">{t('co.pickSeats')}</p>}
            {picked.map((s) => (
              <div className="field" key={s}>
                <label className="label" htmlFor={`pax-${s}`}>{t('co.seatNo', { seat: s })}</label>
                <input
                  id={`pax-${s}`} className="input" placeholder={t('co.paxName')}
                  value={names[s] ?? ''} onChange={(e) => setNames({ ...names, [s]: e.target.value })}
                />
              </div>
            ))}
            <div className="field">
              <label className="label" htmlFor="c-phone">{t('co.mobile')}</label>
              <input id="c-phone" className="input" inputMode="tel" placeholder="01XXXXXXXXX"
                     value={phone} onChange={(e) => setPhone(e.target.value)} />
            </div>
            <div className="field">
              <label className="label" htmlFor="c-method">{t('co.payment')}</label>
              <select id="c-method" className="select" value={method}
                      onChange={(e) => setMethod(e.target.value)}>
                <option value="CASH">{t('co.cash')}</option>
                <option value="BKASH">bKash</option>
                <option value="NAGAD">Nagad</option>
                <option value="CARD">{t('co.card')}</option>
              </select>
            </div>

            <dl className="kv">
              <dt>{t('co.fareLine', { count: picked.length })}</dt>
              <dd><Money poisha={trip.fare_poisha * picked.length} /></dd>
              <dt>{t('co.serviceFee')}</dt><dd><Money poisha={fee} /></dd>
              <dt><strong>{t('co.total')}</strong></dt>
              <dd><strong><Money poisha={total} decimals /></strong></dd>
            </dl>

            {/*
              Cash gets a change calculator. Not decoration: the clerk is doing
              this arithmetic in their head against a queue, and a wrong subtraction
              is a drawer that does not balance at close and an argument at the
              window. Optional — leave it blank and it stays out of the way.
            */}
            {method === 'CASH' && picked.length > 0 && (
              <div className="field">
                <label className="label" htmlFor="c-tendered">{t('co.tendered')}</label>
                <input
                  id="c-tendered" className="input tnum" inputMode="numeric"
                  value={tendered} onChange={(e) => setTendered(e.target.value.replace(/[^\d]/g, ''))}
                />
                {Number(tendered) * 100 >= total && total > 0 && (
                  <div className="changeline">
                    <span>{t('co.changeDue')}</span>
                    <strong className="tnum">{fmt.taka(Number(tendered) * 100 - total)}</strong>
                  </div>
                )}
              </div>
            )}

            {!confirming ? (
              <button
                className="btn btn-primary btn-block btn-lg"
                data-act="take-payment"
                disabled={!sellable}
                onClick={() => setConfirming(true)}
              >
                {t('co.take', { amount: fmt.taka(total) })}
              </button>
            ) : (
              /*
                The one place speed does not win. Everything above is one
                keystroke away from taking money for a seat on a bus; this names
                the amount, the seats and the departure before the notes cross
                the counter.
              */
              <div className="notice notice-warn stack-sm" role="alertdialog">
                <strong>{t('co.confirmTitle', { amount: fmt.taka(total), method: methodLabel })}</strong>
                <span className="small">
                  {t('co.confirmSeats', {
                    seats: picked.join(', '),
                    time: fmt.time(trip.depart_at),
                    dest: trip.destination,
                  })}
                </span>
                <div className="row" style={{ gap: '.5rem' }}>
                  <button className="btn btn-primary" data-act="confirm-payment"
                          onClick={sell} disabled={busy}>
                    {busy ? t('co.taking') : t('co.confirmYes')}
                  </button>
                  <button className="btn btn-ghost" onClick={() => setConfirming(false)} disabled={busy}>
                    {t('co.confirmNo')}
                  </button>
                </div>
              </div>
            )}

            {method === 'CASH' && !ctx?.shift && (
              <p className="small muted" style={{ marginBottom: 0 }}>{t('co.needShift')}</p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/** The keys this screen answers to, stated rather than left to be discovered. */
function KeyHints({ hints }: { hints: ('co.kbd.search' | 'co.kbd.pick' | 'co.kbd.sell' | 'co.kbd.back')[] }) {
  const { t } = useLang();
  return (
    <div className="keyhints">
      <span className="k-label">{t('co.kbd.title')}</span>
      {hints.map((h) => <span key={h}>{t(h)}</span>)}
    </div>
  );
}

/* ----------------------------------------------------------------- offline -- */

function OfflineSale({ ctx, onQueued }: { ctx: CounterContext | null; onQueued: () => void }) {
  const { t, fmt } = useLang();
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
      total_poisha: fare * picked.length + (ctx?.service_fee_poisha ?? 0),
      sold_at: new Date().toISOString(),
      shift_id: ctx?.shift?.shift_id ?? '',
      label: `${trip.from ?? ''} → ${trip.to ?? ''}`,
    });
    quotaCache.consume(trip.trip_id, picked.map((p) => p.seat_no));
    setQuota(quotaCache.get());
    setPicked([]); setName(''); setPhone('');
    setDone(t('co.queued', { seats: entry.seats.join(', '), ref: entry.client_ref.slice(-8) }));
    onQueued();
  };

  if (quota.length === 0) {
    return (
      <div className="card card-pad">
        <h3 style={{ marginBottom: '.3rem' }}>{t('co.noQuota')}</h3>
        <p className="muted" style={{ marginBottom: '.6rem' }}>{t('co.noQuotaBody')}</p>
        <Link className="btn btn-primary" href="/counter/quota">{t('co.reserveSeats')}</Link>
      </div>
    );
  }

  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr) 320px', gap: '1rem', alignItems: 'start' }}>
      <div className="card card-pad stack">
        <h3>{t('co.ownedSeats')}</h3>
        <p className="small muted">{t('co.ownedBody')}</p>
        {Object.entries(byTrip).map(([tripId, list]) => (
          <div key={tripId} className="stack-sm">
            <strong className="small">
              {list[0].from} → {list[0].to}
              {list[0].depart_at ? ` · ${fmt.time(list[0].depart_at)}` : ''}{' '}
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
        <h3>{t('co.offlineSale')}</h3>
        {done && <div className="notice notice-info small" role="status">{done}</div>}
        <div className="field">
          <label className="label" htmlFor="off-name">{t('co.paxName')}</label>
          <input id="off-name" className="input" value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <div className="field">
          <label className="label" htmlFor="off-phone">{t('co.mobile')}</label>
          <input id="off-phone" className="input" inputMode="tel" value={phone}
                 onChange={(e) => setPhone(e.target.value)} />
        </div>
        <dl className="kv">
          <dt>{t('co.seats')}</dt><dd>{picked.map((p) => p.seat_no).join(', ') || '—'}</dd>
          <dt>{t('co.payment')}</dt><dd>{t('co.cashOnly')}</dd>
        </dl>
        <button className="btn btn-primary btn-block" disabled={picked.length === 0} onClick={sell}>
          {t('co.recordSale')}
        </button>
        <p className="small muted" style={{ marginBottom: 0 }}>{t('co.noPnrOffline')}</p>
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
  tendered_poisha?: number;
}

function Receipt({ receipt, onNew }: { receipt: SaleReceipt; onNew: () => void }) {
  const { t, fmt } = useLang();
  const change = (receipt.tendered_poisha ?? 0) - receipt.total_poisha;

  return (
    <div className="card card-pad stack" style={{ maxWidth: 460 }}>
      <div className="row-between">
        <h2 style={{ marginBottom: 0 }}>{t('co.sold')}</h2>
        <span className="pill pill-ok">{receipt.method}</span>
      </div>
      <div className="pnr">{receipt.pnr}</div>
      {receipt.trip && (
        <div className="small muted">
          {receipt.trip.brand} · {receipt.trip.origin} → {receipt.trip.destination} ·{' '}
          {fmt.dateTime(receipt.trip.depart_at)}
        </div>
      )}
      <table className="data">
        <thead><tr><th>{t('co.seats')}</th><th>{t('co.paxName')}</th></tr></thead>
        <tbody>
          {receipt.tickets.map((tk) => (
            <tr key={tk.seat_no}><td className="mono">{tk.seat_no}</td><td>{tk.passenger || '—'}</td></tr>
          ))}
        </tbody>
      </table>
      <dl className="kv">
        <dt>{t('co.collected')}</dt>
        <dd><strong><Money poisha={receipt.total_poisha} decimals /></strong></dd>
        {/* Carried onto the receipt so the clerk can check what they handed back
            after the drawer is already shut. */}
        {change > 0 && (
          <>
            <dt>{t('co.changeDue')}</dt>
            <dd className="tnum"><strong>{fmt.taka(change)}</strong></dd>
          </>
        )}
      </dl>
      <div className="row no-print">
        <button className="btn btn-primary" onClick={() => window.print()}>{t('co.print')}</button>
        <button className="btn btn-ghost" onClick={onNew}>{t('co.next')}</button>
        <Link className="btn btn-ghost" href={`/tickets/${receipt.pnr}`}>{t('co.openTicket')}</Link>
      </div>
    </div>
  );
}
