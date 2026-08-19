'use client';

import { useCallback, useEffect, useState } from 'react';
import { ApiError } from '@/lib/api';
import { sget } from '@/lib/staff';
import { ErrorNotice, Loading } from '@/components/ui';
import { PageHead, Money, Tile, TableWrap, Bar } from '@/components/staff-ui';

interface Insights {
  from: string; to: string;
  revenue_poisha: number; seats_sold: number; trips: number; capacity: number;
  load_factor_pct: number;
  top_routes: { route: string; revenue_poisha: number; seats_sold: number; trips: number }[];
}

function isoDaysAgo(n: number) {
  const d = new Date(); d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10);
}

export default function InsightsPage() {
  const [from, setFrom] = useState(isoDaysAgo(29));
  const [to, setTo] = useState(isoDaysAgo(0));
  const [data, setData] = useState<Insights | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  const load = useCallback(() => {
    setLoading(true);
    sget<Insights>(`/operator/insights?from=${from}&to=${to}`)
      .then(setData).catch((e: ApiError) => setError(e.message)).finally(() => setLoading(false));
  }, [from, to]);

  useEffect(() => { load(); }, [load]);

  return (
    <div className="stack">
      <PageHead
        title="Insights"
        sub="How the network performed over a period — revenue, seats sold, and how full the buses ran."
        actions={
          <div className="row" style={{ gap: '.4rem', alignItems: 'flex-end' }}>
            <div className="field"><label className="label" htmlFor="ins-from">From</label>
              <input id="ins-from" className="input" type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></div>
            <div className="field"><label className="label" htmlFor="ins-to">To</label>
              <input id="ins-to" className="input" type="date" value={to} onChange={(e) => setTo(e.target.value)} /></div>
          </div>
        }
      />

      {error && <ErrorNotice message={error} />}
      {loading || !data ? <Loading rows={2} /> : (
        <>
          <div className="tiles">
            <Tile k="Revenue" n={<Money poisha={data.revenue_poisha} />} />
            <Tile k="Seats sold" n={data.seats_sold.toLocaleString('en-IN')} />
            <Tile k="Trips run" n={data.trips.toLocaleString('en-IN')} />
            <Tile k="Load factor" n={`${data.load_factor_pct}%`} hint={`${data.seats_sold} of ${data.capacity} seats`} />
          </div>

          <div className="card card-pad">
            <h3 style={{ marginBottom: '.7rem' }}>Top routes by revenue</h3>
            {data.top_routes.length === 0
              ? <p className="muted">No sales in this period.</p>
              : (
                <TableWrap>
                  <table className="data">
                    <thead>
                      <tr>
                        <th>Route</th><th className="num">Revenue</th>
                        <th className="num">Seats</th><th className="num">Trips</th>
                        <th style={{ width: 140 }}>Share</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.top_routes.map((r) => (
                        <tr key={r.route}>
                          <td>{r.route}</td>
                          <td className="num"><Money poisha={r.revenue_poisha} /></td>
                          <td className="num">{r.seats_sold}</td>
                          <td className="num">{r.trips}</td>
                          <td><Bar value={r.revenue_poisha} max={data.top_routes[0].revenue_poisha} /></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </TableWrap>
              )}
          </div>
        </>
      )}
    </div>
  );
}
