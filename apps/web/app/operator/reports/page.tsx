'use client';

import { useCallback, useEffect, useState } from 'react';
import { ApiError } from '@/lib/api';
import { sget } from '@/lib/staff';
import { ErrorNotice, Loading } from '@/components/ui';
import { PageHead, Money, Tile, Bar } from '@/components/staff-ui';
import { taka, isoDate, dateOf } from '@/lib/format';

interface Report {
  from: string; to: string;
  days: {
    date: string; revenue_poisha: number; bookings: number;
    web_poisha: number; counter_poisha: number; agent_poisha: number;
  }[];
  routes: { route: string; bookings: number; revenue_poisha: number }[];
}

export default function ReportsPage() {
  const [from, setFrom] = useState(isoDate(new Date(Date.now() - 13 * 864e5)));
  const [to, setTo] = useState(isoDate(new Date()));
  const [r, setR] = useState<Report | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  const load = useCallback(() => {
    setLoading(true);
    sget<Report>(`/operator/reports/sales?from=${from}&to=${to}`)
      .then(setR)
      .catch((e: ApiError) => setError(e.message))
      .finally(() => setLoading(false));
  }, [from, to]);

  useEffect(() => { load(); }, [load]);

  const totals = r?.days.reduce(
    (a, d) => ({
      revenue: a.revenue + d.revenue_poisha,
      bookings: a.bookings + d.bookings,
      web: a.web + d.web_poisha,
      counter: a.counter + d.counter_poisha,
      agent: a.agent + d.agent_poisha,
    }),
    { revenue: 0, bookings: 0, web: 0, counter: 0, agent: 0 },
  );
  const maxDay = Math.max(1, ...(r?.days.map((d) => d.revenue_poisha) ?? [1]));
  const maxRoute = Math.max(1, ...(r?.routes.map((x) => x.revenue_poisha) ?? [1]));

  return (
    <div className="stack">
      <PageHead
        title="Sales report"
        sub="Split by the channel the ticket was actually sold through"
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
      {loading || !r || !totals ? <Loading rows={2} /> : (
        <>
          <div className="tiles">
            <Tile k="Revenue" n={taka(totals.revenue)} />
            <Tile k="Bookings" n={totals.bookings} />
            <Tile k="Website" n={taka(totals.web)} />
            <Tile k="Counter" n={taka(totals.counter)} />
            <Tile k="Agent" n={taka(totals.agent)} />
          </div>

          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>Day</th><th>Revenue</th><th className="num">Bookings</th>
                  <th className="num">Website</th><th className="num">Counter</th><th className="num">Agent</th>
                </tr>
              </thead>
              <tbody>
                {r.days.map((d) => (
                  <tr key={d.date}>
                    <td>{dateOf(d.date)}</td>
                    <td style={{ width: '30%' }}>
                      <div className="row" style={{ gap: '.5rem', flexWrap: 'nowrap' }}>
                        <Bar value={d.revenue_poisha} max={maxDay} />
                        <span className="tnum small">{taka(d.revenue_poisha)}</span>
                      </div>
                    </td>
                    <td className="num">{d.bookings}</td>
                    <td className="num muted"><Money poisha={d.web_poisha} /></td>
                    <td className="num muted"><Money poisha={d.counter_poisha} /></td>
                    <td className="num muted"><Money poisha={d.agent_poisha} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div>
            <h3 style={{ marginBottom: '.5rem' }}>Route performance</h3>
            <div className="table-wrap">
              <table className="data">
                <thead><tr><th>Route</th><th>Revenue</th><th className="num">Bookings</th><th className="num">Total</th></tr></thead>
                <tbody>
                  {r.routes.map((x) => (
                    <tr key={x.route}>
                      <td>{x.route}</td>
                      <td style={{ width: '40%' }}><Bar value={x.revenue_poisha} max={maxRoute} /></td>
                      <td className="num">{x.bookings}</td>
                      <td className="num"><Money poisha={x.revenue_poisha} /></td>
                    </tr>
                  ))}
                  {r.routes.length === 0 && (
                    <tr><td colSpan={4} className="muted center">No sales in this window.</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>

          <p className="small muted">
            These figures are read straight from the transactional database. At
            real volume that is the wrong place to read them from — the plan puts
            reporting on a separate analytics store for exactly this reason, and
            that store does not exist in this build.
          </p>
        </>
      )}
    </div>
  );
}
