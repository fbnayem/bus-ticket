'use client';

import { useCallback, useEffect, useState } from 'react';
import { ApiError } from '@/lib/api';
import { sget } from '@/lib/staff';
import { ErrorNotice, Loading } from '@/components/ui';
import { PageHead, Money, Tile } from '@/components/staff-ui';
import { taka, isoDate } from '@/lib/format';

interface BusPnl {
  bus_id: string;
  registration: string;
  bookings: number;
  gross_poisha: number;
  platform_commission_poisha: number;
  staff_commission_poisha: number;
  net_fare_poisha: number;
  fuel_poisha: number;
  maintenance_poisha: number;
  wages_poisha: number;
  other_poisha: number;
  costs_poisha: number;
  profit_poisha: number;
}

interface Pnl {
  from: string; to: string;
  buses: BusPnl[];
  overhead: { fuel_poisha: number; maintenance_poisha: number; wages_poisha: number; other_poisha: number; costs_poisha: number };
  totals: {
    bookings: number; gross_poisha: number;
    platform_commission_poisha: number; staff_commission_poisha: number;
    net_fare_poisha: number; costs_poisha: number; profit_poisha: number;
  };
}

// A profit or loss shown in its own colour: black is a profit, red is a loss.
// The word "loss" is never implied by a minus sign alone — a tired owner at
// midnight should not have to hunt for the sign.
function PL({ poisha }: { poisha: number }) {
  const loss = poisha < 0;
  return (
    <strong style={{ color: loss ? 'var(--danger, #b3261e)' : 'var(--ok, #0B6E4F)' }}>
      {loss ? '−' : ''}{taka(Math.abs(poisha))}
    </strong>
  );
}

export default function PnlPage() {
  const [from, setFrom] = useState(isoDate(new Date(Date.now() - 29 * 864e5)));
  const [to, setTo] = useState(isoDate(new Date()));
  const [p, setP] = useState<Pnl | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  const load = useCallback(() => {
    setLoading(true);
    setError('');
    sget<Pnl>(`/owner/pnl?from=${from}&to=${to}`)
      .then(setP)
      .catch((e: ApiError) => setError(e.message))
      .finally(() => setLoading(false));
  }, [from, to]);

  useEffect(() => { load(); }, [load]);

  return (
    <div className="stack">
      <PageHead
        title="Profit & loss"
        sub="What each bus earned, and what it cost to run"
        actions={
          <div className="row" style={{ gap: '.4rem' }}>
            <input className="input" type="date" value={from} style={{ width: 150 }}
                   onChange={(e) => setFrom(e.target.value)} aria-label="From" />
            <input className="input" type="date" value={to} style={{ width: 150 }}
                   onChange={(e) => setTo(e.target.value)} aria-label="To" />
          </div>
        }
      />
      {error && <ErrorNotice message={error} />}
      {loading || !p ? <Loading rows={3} /> : (
        <>
          <div className="tiles">
            <Tile k="Ticket sales" n={taka(p.totals.gross_poisha)} hint={`${p.totals.bookings} bookings`} />
            <Tile k="Net fare to you" n={taka(p.totals.net_fare_poisha)} hint="after platform & staff" />
            <Tile k="Running costs" n={taka(p.totals.costs_poisha)} hint="fuel, wages, upkeep" />
            <Tile k={p.totals.profit_poisha < 0 ? 'Loss' : 'Profit'} n={<PL poisha={p.totals.profit_poisha} />} />
          </div>

          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>Bus</th>
                  <th className="num">Bookings</th>
                  <th className="num">Ticket sales</th>
                  <th className="num">Platform</th>
                  <th className="num">Staff comm.</th>
                  <th className="num">Net fare</th>
                  <th className="num">Costs</th>
                  <th className="num">Profit / loss</th>
                </tr>
              </thead>
              <tbody>
                {p.buses.map((b) => (
                  <tr key={b.bus_id}>
                    <td>{b.registration}</td>
                    <td className="num">{b.bookings}</td>
                    <td className="num"><Money poisha={b.gross_poisha} /></td>
                    <td className="num muted">−<Money poisha={b.platform_commission_poisha} /></td>
                    <td className="num muted">−<Money poisha={b.staff_commission_poisha} /></td>
                    <td className="num"><Money poisha={b.net_fare_poisha} /></td>
                    <td className="num muted">−<Money poisha={b.costs_poisha} /></td>
                    <td className="num"><PL poisha={b.profit_poisha} /></td>
                  </tr>
                ))}
                {p.buses.length === 0 && (
                  <tr><td colSpan={8} className="muted center">No buses in this operator.</td></tr>
                )}
                {p.overhead.costs_poisha > 0 && (
                  <tr>
                    <td className="muted">Operator overhead</td>
                    <td className="num muted">—</td>
                    <td className="num muted">—</td>
                    <td className="num muted">—</td>
                    <td className="num muted">—</td>
                    <td className="num muted">—</td>
                    <td className="num muted">−<Money poisha={p.overhead.costs_poisha} /></td>
                    <td className="num"><PL poisha={-p.overhead.costs_poisha} /></td>
                  </tr>
                )}
              </tbody>
              <tfoot>
                <tr>
                  <td><strong>All buses</strong></td>
                  <td className="num"><strong>{p.totals.bookings}</strong></td>
                  <td className="num"><strong>{taka(p.totals.gross_poisha)}</strong></td>
                  <td className="num muted">−{taka(p.totals.platform_commission_poisha)}</td>
                  <td className="num muted">−{taka(p.totals.staff_commission_poisha)}</td>
                  <td className="num"><strong>{taka(p.totals.net_fare_poisha)}</strong></td>
                  <td className="num muted">−{taka(p.totals.costs_poisha)}</td>
                  <td className="num"><PL poisha={p.totals.profit_poisha} /></td>
                </tr>
              </tfoot>
            </table>
          </div>

          <p className="small muted">
            Ticket sales is what passengers paid. The platform&apos;s commission
            (10% plus the ৳50 service fee) and any staff commission are taken out
            to leave the net fare that is yours; your running costs come off that
            to leave profit or loss. Record costs on the{' '}
            <a href="/operator/costs">Costs</a> page — a bus with no costs entered
            shows its full net fare as profit.
          </p>
        </>
      )}
    </div>
  );
}
