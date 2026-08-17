'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { ApiError } from '@/lib/api';
import { sget } from '@/lib/staff';
import { queue, type QueuedSale } from '@/lib/offline';
import { ErrorNotice, Loading, StatusPill } from '@/components/ui';
import { PageHead, Money } from '@/components/staff-ui';
import { useLang } from '@/components/LangProvider';
import { Ref } from '@/components/Ref';
import { errorText } from '@/lib/i18n';

interface Sale {
  pnr: string; status: string; total_poisha: number; created_at: string;
  depart_at: string; operator: string; seats: string; provider: string;
}

export default function CounterSalesPage() {
  const { t, fmt } = useLang();
  const [sales, setSales] = useState<Sale[]>([]);
  const [pending, setPending] = useState<QueuedSale[]>([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    sget<{ sales: Sale[] }>('/counter/sales')
      .then((r) => setSales(r.sales))
      .catch((e: ApiError) => setError(errorText(t, e)))
      .finally(() => setLoading(false));
    setPending(queue.all());
  }, []);

  if (loading) return <Loading rows={2} />;

  return (
    <div className="stack">
      <PageHead title={t('co.nav.sales')} sub={t('co.s.sub')} />
      {error && <ErrorNotice message={error} />}

      {/* Sales made without the line come FIRST, above the confirmed ones.
          They are the only rows on this page that still need something from
          the clerk, and burying them under a day's takings is how a shift
          reaches closing time with cash it cannot account for. */}
      {pending.length > 0 && (
        <div className="card card-pad stack-sm">
          <h3 style={{ marginBottom: 0 }}>{t('co.s.pending', { count: pending.length })}</h3>
          <p className="small muted" style={{ marginBottom: '.3rem' }}>{t('co.s.pendingNote')}</p>
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>{t('co.s.ref')}</th><th>{t('co.seats')}</th>
                  <th>{t('co.s.soldAt')}</th><th className="num">{t('co.s.amount')}</th>
                </tr>
              </thead>
              <tbody>
                {pending.map((p) => (
                  <tr key={p.client_ref}>
                    <td className="mono small">{p.client_ref.slice(-8)}</td>
                    <td className="mono">{p.seats.join(', ')}</td>
                    <td>{fmt.dateTime(p.sold_at)}</td>
                    <td className="num"><Money poisha={p.total_poisha} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <div className="table-wrap">
        <table className="data">
          <thead>
            <tr>
              <th>{t('co.s.pnr')}</th><th>{t('co.s.departure')}</th>
              <th>{t('co.seats')}</th><th>{t('co.s.paidWith')}</th>
              <th className="num">{t('co.s.amount')}</th><th>{t('co.s.status')}</th>
              <th>{t('co.s.soldAt')}</th><th />
            </tr>
          </thead>
          <tbody>
            {sales.map((s) => (
              <tr key={s.pnr}>
                <td><Ref value={s.pnr} /></td>
                <td>{s.operator} · {fmt.time(s.depart_at)}</td>
                <td className="mono">{s.seats}</td>
                <td>{s.provider === 'CASH' ? t('co.cash') : s.provider || '—'}</td>
                <td className="num"><Money poisha={s.total_poisha} /></td>
                <td><StatusPill status={s.status} /></td>
                <td className="muted small">{fmt.dateTime(s.created_at)}</td>
                <td><Link className="btn btn-sm btn-ghost" href={`/tickets/${s.pnr}`}>{t('co.s.reprint')}</Link></td>
              </tr>
            ))}
            {sales.length === 0 && (
              <tr><td colSpan={8} className="muted center">{t('co.s.empty')}</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
