'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { api, ApiError, type Seat, type SearchResult } from '@/lib/api';
import { sget, spost } from '@/lib/staff';
import { SeatMap } from '@/components/SeatMap';
import { ErrorNotice } from '@/components/ui';
import { PageHead, Money } from '@/components/staff-ui';
import { useLang } from '@/components/LangProvider';
import { Ref } from '@/components/Ref';
import { isoDate } from '@/lib/format';
import { errorText } from '@/lib/i18n';

// An agent sale commits two things atomically and in this order: the seat, then
// the money. If the wallet has nothing left, the seat is handed straight back —
// so a passenger standing at the desk never watches a seat disappear into a sale
// that could not be paid for.

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
  const { t, fmt } = useLang();
  const [wallet, setWallet] = useState<Wallet | null>(null);
  // The platform's fee, as the platform states it. This file used to keep its
  // own `const SERVICE_FEE = 5000` and quote the agent a total built from it —
  // and an agent sells against a credit limit off that number.
  const [fee, setFee] = useState(0);
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
    sget<{ wallet: Wallet; service_fee_poisha: number }>('/agent/wallet')
      .then((r) => { setWallet(r.wallet); setFee(r.service_fee_poisha ?? 0); })
      .catch(() => {});

  useEffect(() => { void loadWallet(); }, []);

  const search = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(''); setTrip(null); setSold(null);
    try {
      setResults((await api.search(from, to, date)).results);
    } catch (err) {
      setError(errorText(t, err, 'err.search_failed'));
    }
  };

  const openTrip = async (tr: SearchResult) => {
    setTrip(tr); setPicked([]); setNames({});
    setSeats((await api.seatmap(tr.trip_id, tr.board_seq, tr.drop_seq)).seats);
  };

  const total = trip ? trip.fare_poisha * picked.length + fee : 0;
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
      setError(errorText(t, e));
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
        <PageHead title={t('co.sold')} />
        <div className="card card-pad stack" style={{ maxWidth: 460 }}>
          <div className="pnr">{sold.pnr}</div>
          {/* What the agent earned, at full size. It is the reason they sell. */}
          <div className="moneyline is-back" data-fig="commission">
            <span className="m-what">{t('ag.commissionEarned')}</span>
            <span className="m-amount">{fmt.taka(sold.commission_poisha)}</span>
          </div>
          <dl className="kv">
            <dt>{t('co.seats')}</dt><dd><Ref value={sold.seats.join(', ')} /></dd>
            <dt>{t('ag.chargedToWallet')}</dt><dd><Money poisha={sold.total_poisha} decimals /></dd>
            <dt>{t('ag.spendNow')}</dt>
            <dd><strong><Money poisha={sold.wallet.spendable_poisha} /></strong></dd>
          </dl>
          <div className="row">
            <Link className="btn btn-primary" href={`/tickets/${sold.pnr}`}>{t('co.openTicket')}</Link>
            <button className="btn btn-ghost" onClick={() => { setSold(null); setTrip(null); setResults(null); }}>
              {t('co.next')}
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="stack">
      <PageHead
        title={t('ag.nav.sell')}
        sub={wallet
          ? `${wallet.agency_name} · ${t('ag.spendNow')} ${fmt.taka(wallet.spendable_poisha)}`
          : ''}
      />

      {error && <ErrorNotice message={error} />}

      {wallet && wallet.spendable_poisha <= 0 && (
        <div className="notice notice-warn">
          {t('ag.walletEmpty')} <Link href="/agent/recharge">{t('ag.addMoney')}</Link>
        </div>
      )}

      <form className="card card-pad" onSubmit={search}>
        <div className="row" style={{ gap: '.6rem', alignItems: 'flex-end' }}>
          <div className="field" style={{ flex: '1 1 150px' }}>
            <label className="label" htmlFor="a-from">{t('co.from')}</label>
            <input id="a-from" className="input" value={from} onChange={(e) => setFrom(e.target.value)} />
          </div>
          <div className="field" style={{ flex: '1 1 150px' }}>
            <label className="label" htmlFor="a-to">{t('co.to')}</label>
            <input id="a-to" className="input" value={to} onChange={(e) => setTo(e.target.value)} />
          </div>
          <div className="field" style={{ flex: '0 1 170px' }}>
            <label className="label" htmlFor="a-date">{t('co.date')}</label>
            <input id="a-date" className="input" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          </div>
          <button className="btn btn-brand" type="submit">{t('co.find')}</button>
        </div>
      </form>

      {results && !trip && (
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>{t('co.departs')}</th><th>{t('trip.operator')}</th>
                <th className="num">{t('co.free')}</th><th className="num">{t('co.fare')}</th><th />
              </tr>
            </thead>
            <tbody>
              {results.map((tr) => (
                <tr key={tr.trip_id} data-trip={tr.trip_id} data-free={tr.available_seats}>
                  <td>
                    <strong>{fmt.time(tr.depart_at)}</strong>{' '}
                    <span className="muted small">{fmt.date(tr.depart_at)}</span>
                  </td>
                  <td>{tr.brand} <span className="muted small">{tr.bus_type}</span></td>
                  <td className="num">{tr.available_seats}</td>
                  <td className="num"><Money poisha={tr.fare_poisha} /></td>
                  <td>
                    <button className="btn btn-sm btn-brand" onClick={() => openTrip(tr)}>
                      {t('co.seats')}
                    </button>
                  </td>
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
              <strong>
                {trip.brand} · {fmt.time(trip.depart_at)} · {trip.origin} → {trip.destination}
              </strong>
              <button className="btn btn-ghost btn-sm" onClick={() => setTrip(null)}>
                {t('co.change')}
              </button>
            </div>
            <SeatMap
              seats={seats} selected={picked} maxSeats={6}
              onToggle={(s) => setPicked((c) => (c.includes(s) ? c.filter((x) => x !== s) : [...c, s]))}
            />
          </div>

          <div className="card card-pad stack">
            <h3>{t('co.passengers')}</h3>
            {picked.length === 0 && <p className="muted small">{t('co.pickSeats')}</p>}
            {picked.map((seatNo) => (
              <div className="field" key={seatNo}>
                <label className="label" htmlFor={`ap-${seatNo}`}>
                  {t('co.seatNo', { seat: seatNo })}
                </label>
                <input id={`ap-${seatNo}`} className="input" placeholder={t('co.paxName')}
                       value={names[seatNo] ?? ''}
                       onChange={(e) => setNames({ ...names, [seatNo]: e.target.value })} />
              </div>
            ))}
            <div className="field">
              <label className="label" htmlFor="a-phone">{t('co.mobile')}</label>
              <input id="a-phone" className="input" inputMode="tel" placeholder="01XXXXXXXXX"
                     value={phone} onChange={(e) => setPhone(e.target.value)} />
            </div>

            <dl className="kv">
              <dt>{t('co.fareLine', { count: picked.length })}</dt>
              <dd><Money poisha={trip.fare_poisha * picked.length} /></dd>
              <dt>{t('co.serviceFee')}</dt><dd><Money poisha={fee} /></dd>
              <dt><strong>{t('ag.chargedToWallet')}</strong></dt>
              <dd><strong><Money poisha={total} decimals /></strong></dd>
              {wallet && (
                <>
                  <dt>{t('ag.leftAfter')}</dt>
                  <dd className={affordable ? '' : 'muted'}>
                    <Money poisha={Math.max(0, wallet.spendable_poisha - total)} />
                  </dd>
                </>
              )}
            </dl>

            {!affordable && (
              <div className="notice notice-warn small">
                <strong>{t('ag.cannotAfford')}</strong>{' '}
                {wallet && t('ag.shortBy', { amount: fmt.taka(total - wallet.spendable_poisha) })}
              </div>
            )}

            <button className="btn btn-primary btn-block btn-lg"
                    data-act="agent-sell"
                    disabled={busy || picked.length === 0 || !phone || !affordable}
                    onClick={sell}>
              {busy ? t('ag.selling') : t('ag.sellFor', { amount: fmt.taka(total) })}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
