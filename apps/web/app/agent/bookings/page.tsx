'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { ApiError } from '@/lib/api';
import { sget } from '@/lib/staff';
import { ErrorNotice, Loading, StatusPill } from '@/components/ui';
import { PageHead, Money } from '@/components/staff-ui';
import { useLang } from '@/components/LangProvider';
import { Ref } from '@/components/Ref';

interface Booking {
  pnr: string; status: string; total_poisha: number; created_at: string;
  depart_at: string; operator: string; seats: string;
  commission_poisha: number; passenger: string;
}

export default function AgentBookingsPage() {
  const { t, fmt } = useLang();
  const [rows, setRows] = useState<Booking[]>([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    sget<{ bookings: Booking[] }>('/agent/bookings')
      .then((r) => setRows(r.bookings))
      .catch((e: ApiError) => setError(e.message))
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <Loading rows={2} />;

  return (
    <div className="stack">
      <PageHead title={t('ag.bk.title')} sub={t('ag.bk.sub')} />
      {error && <ErrorNotice message={error} />}

      <div className="table-wrap">
        <table className="data">
          <thead>
            <tr>
              <th>{t('co.s.pnr')}</th><th>{t('ag.bk.passenger')}</th>
              <th>{t('ag.bk.departure')}</th><th>{t('co.seats')}</th>
              <th className="num">{t('ag.bk.fare')}</th>
              <th className="num">{t('ag.nav.commissions')}</th>
              <th>{t('co.s.status')}</th><th>{t('ag.bk.sold')}</th><th />
            </tr>
          </thead>
          <tbody>
            {rows.map((b) => (
              <tr key={b.pnr}>
                <td><Ref value={b.pnr} /></td>
                <td>{b.passenger || '—'}</td>
                <td>{b.operator} · {fmt.time(b.depart_at)}</td>
                <td className="mono">{b.seats}</td>
                <td className="num"><Money poisha={b.total_poisha} /></td>
                {/* The agent's own earnings, in the same green the wallet uses
                    for money coming in — so the column that matters to them is
                    the one their eye lands on. */}
                <td className="num" style={{ color: b.commission_poisha ? 'var(--ok)' : undefined }}>
                  {b.commission_poisha ? <Money poisha={b.commission_poisha} decimals /> : '—'}
                </td>
                <td><StatusPill status={b.status} /></td>
                <td className="muted small">{fmt.dateTime(b.created_at)}</td>
                <td><Link className="btn btn-sm btn-ghost" href={`/manage/${b.pnr}`}>{t('ag.bk.manage')}</Link></td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr><td colSpan={9} className="muted center">{t('ag.bk.empty')}</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
