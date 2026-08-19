'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { ApiError } from '@/lib/api';
import { sget } from '@/lib/staff';
import { ErrorNotice, Loading } from '@/components/ui';
import { PageHead, Money, Tile, Bar } from '@/components/staff-ui';
import { taka, channelLabel } from '@/lib/format';

interface Overview {
  operators: number; upcoming_trips: number; bookings: number; tickets: number;
  staff: number; agencies: number; gmv_poisha: number; refunds_poisha: number;
  trial_balance_variance_poisha: number;
  by_channel: { channel: string; bookings: number; revenue_poisha: number }[];
}

export default function AdminOverview() {
  const [d, setD] = useState<Overview | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    sget<Overview>('/admin/overview').then(setD).catch((e: ApiError) => setError(e.message));
  }, []);

  if (error) return <ErrorNotice message={error} />;
  if (!d) return <Loading rows={3} />;

  const balanced = Number(d.trial_balance_variance_poisha) === 0;
  const maxChannel = Math.max(1, ...d.by_channel.map((c) => c.revenue_poisha));

  return (
    <div className="stack">
      <PageHead title="Platform overview" sub="Every operator, every channel, one set of books" />

      <div className={`notice ${balanced ? 'notice-info' : 'notice-danger'}`}>
        {balanced ? (
          <>
            <strong>The books balance.</strong> Total debits equal total credits to
            the poisha across every booking, refund, cash drawer, agent wallet and
            settlement payout recorded so far.
          </>
        ) : (
          <>
            <strong>The trial balance does not net to zero.</strong> Variance{' '}
            {taka(Number(d.trial_balance_variance_poisha), { decimals: true })}. Stop
            and find it before anything else.
          </>
        )}
      </div>

      <div className="tiles">
        <Tile k="Gross bookings" n={taka(d.gmv_poisha)} hint={`${d.bookings} bookings`} />
        <Tile k="Refunded" n={taka(d.refunds_poisha)} />
        <Tile k="Tickets issued" n={d.tickets} />
        <Tile k="Operators" n={d.operators} />
        <Tile k="Agencies" n={d.agencies} />
        <Tile k="Upcoming trips" n={d.upcoming_trips} />
        <Tile k="Staff accounts" n={d.staff} />
      </div>

      <div className="card card-pad stack-sm">
        <h3 style={{ marginBottom: '.2rem' }}>Sales by channel</h3>
        <p className="small muted" style={{ marginBottom: '.4rem' }}>
          Six front doors, one seat inventory. Nothing in this table is a separate
          pool of seats.
        </p>
        <table className="data">
          <tbody>
            {d.by_channel.map((c) => (
              <tr key={c.channel}>
                <td>{channelLabel(c.channel)}</td>
                <td style={{ width: '45%' }}><Bar value={c.revenue_poisha} max={maxChannel} /></td>
                <td className="num">{c.bookings}</td>
                <td className="num"><Money poisha={c.revenue_poisha} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="row">
        <Link className="btn btn-brand" href="/admin/ledger">Open the ledger</Link>
        <Link className="btn btn-ghost" href="/admin/settlements">Settlements</Link>
        <Link className="btn btn-ghost" href="/admin/health">System health</Link>
      </div>
    </div>
  );
}
