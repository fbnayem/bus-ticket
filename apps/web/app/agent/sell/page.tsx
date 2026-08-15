'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { api, ApiError, type Seat, type SearchResult } from '@/lib/api';
import { sget, spost } from '@/lib/staff';
import { SeatMap } from '@/components/SeatMap';
import { ErrorNotice } from '@/components/ui';
import { PageHead, Money } from '@/components/staff-ui';
import { isoDate, taka, timeOf, dateOf } from '@/lib/format';

// An agent sale commits two things atomically and in this order: the seat, then
// the money. If the wallet has nothing left, the seat is handed straight back —
// so a passenger standing at the desk never watches a seat disappear into a sale
// that could not be paid for.

const SERVICE_FEE = 5000;

interface Wallet {
  wallet_id: string; agency_name: string;
  available_poisha: number; held_poisha: number;
  credit_limit_poisha: number; spendable_poisha: number;
}

interface SaleResult {
  pnr: string; seats: string[]; total_poisha: number;
  commission_poisha: number; wallet: Wallet;
}

export default function AgentSellPage() {
  const [wallet, setWallet] = useState<Wallet | null>(null);
  const [from, setFrom] = useState('Dhaka');
  const [to, setTo] = useState('Chattogram');
  const [date, setDate] = useState(isoDate(new Date()));
  const [results, setResults] = useState<SearchResult[] | null>(null);
  const [trip, setTrip] = useState<SearchResult | null>(null);
  const [seats, setSeats] = useState<Seat[]>([]);
  const [picked, setPicked] = useState<string[]>([]);
  const [names, setNames] = useState<Record<string, string>>({});
  const [phone, setPhone] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [sold, setSold] = useState<SaleResult | null>(null);

  const loadWallet = () =>
    sget<{ wallet: Wallet }>('/agent/wallet').then((r) => setWallet(r.wallet)).catch(() => {});

  useEffect(() => { void loadWallet(); }, []);

  const search = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(''); setTrip(null); setSold(null);
    try {
      setResults((await api.search(from, to, date)).results);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Search failed.');
    }
  };

  const openTrip = async (t: SearchResult) => {
    setTrip(t); setPicked([]); setNames({});
    setSeats((await api.seatmap(t.trip_id, t.board_seq, t.drop_seq)).seats);
  };

  const total = trip ? trip.fare_poisha * picked.length + SERVICE_FEE : 0;
  const affordable = !wallet || total <= wallet.spendable_poisha;

  const sell = async () => {
    if (!trip) return;
    setBusy(true); setError('');
    try {
      const res = await spost<SaleResult>('/agent/sales', {
        trip_id: trip.trip_id, seats: picked,
        board_seq: trip.board_seq, drop_seq: trip.drop_seq,
        passengers: picked.map((s) => ({ seat_no: s, full_name: names[s] || 'Passenger' })),
        phone,
      });
      setSold(res);
      setWallet(res.wallet);
      setPicked([]); setNames({}); setPhone('');
    } catch (err) {
      const e = err as ApiError;
      setError(e.message);
      if (e.status === 409) {
        setPicked([]);
        setSeats((await api.seatmap(trip.trip_id, trip.board_seq, trip.drop_seq)).seats);
      }
      if (e.status === 402) void loadWallet();
    } finally {
      setBusy(false);
    }
  };

  if (sold) {
    return (
      <div className="stack">
        <PageHead title="Ticket issued" />
        <div className="card card-pad stack" style={{ maxWidth: 460 }}>
          <div className="pnr">{sold.pnr}</div>
          <dl className="kv">
            <dt>Seats</dt><dd className="mono">{sold.seats.join(', ')}</dd>
            <dt>Charged to wallet</dt><dd><Money poisha={sold.total_poisha} decimals /></dd>
            <dt>Your commission</dt>
            <dd style={{ color: 'var(--ok)' }}>+<Money poisha={sold.commission_poisha} decimals /></dd>
            <dt>Spendable now</dt><dd><strong><Money poisha={sold.wallet.spendable_poisha} /></strong></dd>
          </dl>
          <div className="row">
            <Link className="btn btn-primary" href={`/tickets/${sold.pnr}`}>Open ticket</Link>
            <button className="btn btn-ghost" onClick={() => { setSold(null); setTrip(null); setResults(null); }}>
              Next sale
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="stack">
      <PageHead
        title="Sell a ticket"
        sub={wallet ? `${wallet.agency_name} · ${taka(wallet.spendable_poisha)} spendable` : ''}
      />

      {error && <ErrorNotice message={error} />}

      {wallet && wallet.spendable_poisha <= 0 && (
        <div className="notice notice-warn">
          Your wallet has nothing left to spend. <Link href="/agent/recharge">Request a recharge</Link>{' '}
          — it takes effect once finance approves it.
        </div>
      )}

      <form className="card card-pad" onSubmit={search}>
        <div className="row" style={{ gap: '.6rem', alignItems: 'flex-end' }}>
          <div className="field" style={{ flex: '1 1 150px' }}>
            <label className="label" htmlFor="a-from">From</label>
            <input id="a-from" className="input" value={from} onChange={(e) => setFrom(e.target.value)} />
          </div>
          <div className="field" style={{ flex: '1 1 150px' }}>
            <label className="label" htmlFor="a-to">To</label>
            <input id="a-to" className="input" value={to} onChange={(e) => setTo(e.target.value)} />
          </div>
          <div className="field" style={{ flex: '0 1 170px' }}>
            <label className="label" htmlFor="a-date">Date</label>
            <input id="a-date" className="input" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
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
                  <td><strong>{timeOf(t.depart_at)}</strong> <span className="muted small">{dateOf(t.depart_at)}</span></td>
                  <td>{t.brand} <span className="muted small">{t.bus_type}</span></td>
                  <td className="num">{t.available_seats}</td>
                  <td className="num"><Money poisha={t.fare_poisha} /></td>
                  <td><button className="btn btn-sm btn-brand" onClick={() => openTrip(t)}>Seats</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {trip && (
        <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr) 320px', gap: '1rem', alignItems: 'start' }}>
          <div className="card card-pad stack">
            <div className="row-between">
              <strong>{trip.brand} · {timeOf(trip.depart_at)} · {trip.origin} → {trip.destination}</strong>
              <button className="btn btn-ghost btn-sm" onClick={() => setTrip(null)}>Change</button>
            </div>
            <SeatMap
              seats={seats} selected={picked} maxSeats={6}
              onToggle={(s) => setPicked((c) => (c.includes(s) ? c.filter((x) => x !== s) : [...c, s]))}
            />
          </div>

          <div className="card card-pad stack">
            <h3>Passengers</h3>
            {picked.length === 0 && <p className="muted small">Pick seats on the map.</p>}
            {picked.map((s) => (
              <div className="field" key={s}>
                <label className="label" htmlFor={`ap-${s}`}>Seat {s}</label>
                <input id={`ap-${s}`} className="input" placeholder="Passenger name"
                       value={names[s] ?? ''} onChange={(e) => setNames({ ...names, [s]: e.target.value })} />
              </div>
            ))}
            <div className="field">
              <label className="label" htmlFor="a-phone">Mobile number</label>
              <input id="a-phone" className="input" placeholder="+8801…" value={phone}
                     onChange={(e) => setPhone(e.target.value)} />
            </div>

            <dl className="kv">
              <dt>{picked.length} × fare</dt><dd><Money poisha={trip.fare_poisha * picked.length} /></dd>
              <dt>Service fee</dt><dd><Money poisha={SERVICE_FEE} /></dd>
              <dt><strong>From your wallet</strong></dt><dd><strong><Money poisha={total} decimals /></strong></dd>
              {wallet && (
                <>
                  <dt>Spendable after</dt>
                  <dd className={affordable ? '' : 'muted'}>
                    <Money poisha={Math.max(0, wallet.spendable_poisha - total)} />
                  </dd>
                </>
              )}
            </dl>

            {!affordable && (
              <div className="notice notice-warn small">
                This sale is more than your wallet can cover. Nothing will be held.
              </div>
            )}

            <button className="btn btn-primary btn-block btn-lg"
                    disabled={busy || picked.length === 0 || !phone || !affordable}
                    onClick={sell}>
              {busy ? 'Selling…' : `Charge wallet · ${taka(total)}`}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
