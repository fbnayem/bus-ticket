'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { ApiError } from '@/lib/api';
import { sget } from '@/lib/staff';
import { ErrorNotice, Loading } from '@/components/ui';
import { PageHead, Money, Tile, Bar } from '@/components/staff-ui';
import { taka, timeOf, channelLabel } from '@/lib/format';

interface Dashboard {
  operator: string;
  trips_today: number;
  seats_sold_today: number;
  buses: number;
  counters: number;
  revenue_today_poisha: number;
  revenue_7d_poisha: number;
  by_channel: { channel: string; bookings: number; revenue_poisha: number }[];
  today: { trip_id: string; depart_at: string; seats: number; sold: number; occupancy_pct: number }[];
}

export default function OperatorDashboard() {
  const [d, setD] = useState<Dashboard | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    sget<Dashboard>('/operator/dashboard').then(setD).catch((e: ApiError) => setError(e.message));
  }, []);

  if (error) return <ErrorNotice message={error} />;
  if (!d) return <Loading rows={3} />;

  const maxChannel = Math.max(1, ...d.by_channel.map((c) => c.revenue_poisha));

  return (
    <div className="stack">
      <PageHead
        title={d.operator || 'Operator'}
        sub="Today at a glance"
        actions={<Link className="btn btn-brand" href="/operator/trips">Today&apos;s trips</Link>}
      />

      <div className="tiles">
        <Tile k="Trips today" n={d.trips_today} />
        <Tile k="Seats sold today" n={d.seats_sold_today} />
        <Tile k="Revenue today" n={taka(d.revenue_today_poisha)} />
        <Tile k="Revenue, 7 days" n={taka(d.revenue_7d_poisha)} />
        <Tile k="Buses" n={d.buses} />
        <Tile k="Counters" n={d.counters} />
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr) minmax(0,1fr)', gap: '1rem' }}
           className="grid-2">
        <div className="card card-pad stack-sm">
          <h3 style={{ marginBottom: '.2rem' }}>Where sales come from</h3>
          <p className="small muted" style={{ marginBottom: '.4rem' }}>Last 30 days.</p>
          <table className="data">
            <tbody>
              {d.by_channel.map((c) => (
                <tr key={c.channel}>
                  <td>{channelLabel(c.channel)}</td>
                  <td style={{ width: '40%' }}><Bar value={c.revenue_poisha} max={maxChannel} /></td>
                  <td className="num">{c.bookings}</td>
                  <td className="num"><Money poisha={c.revenue_poisha} /></td>
                </tr>
              ))}
              {d.by_channel.length === 0 && (
                <tr><td className="muted center">Nothing sold yet.</td></tr>
              )}
            </tbody>
          </table>
        </div>

        <div className="card card-pad stack-sm">
          <h3 style={{ marginBottom: '.2rem' }}>Occupancy today</h3>
          <p className="small muted" style={{ marginBottom: '.4rem' }}>
            Read directly from the seat inventory, not from a cached count.
          </p>
          <table className="data">
            <tbody>
              {d.today.map((t) => (
                <tr key={t.trip_id}>
                  <td><strong>{timeOf(t.depart_at)}</strong></td>
                  <td style={{ width: '45%' }}><Bar value={t.sold} max={t.seats} /></td>
                  <td className="num">{t.sold}/{t.seats}</td>
                  <td className="num">{t.occupancy_pct}%</td>
                </tr>
              ))}
              {d.today.length === 0 && (
                <tr><td className="muted center">No departures today.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
