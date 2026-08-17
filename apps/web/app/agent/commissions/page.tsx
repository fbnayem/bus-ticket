'use client';

import { useEffect, useState } from 'react';
import { ApiError } from '@/lib/api';
import { sget } from '@/lib/staff';
import { ErrorNotice, Loading } from '@/components/ui';
import { PageHead, Money, Tile } from '@/components/staff-ui';
import { useLang } from '@/components/LangProvider';
import { Ref } from '@/components/Ref';
import { errorText } from '@/lib/i18n';

interface Commission {
  pnr: string; amount_poisha: number; created_at: string;
  rule_kind: string; rule_bp: number;
}

export default function CommissionsPage() {
  const { t, fmt } = useLang();
  const [total, setTotal] = useState(0);
  const [count, setCount] = useState(0);
  const [rows, setRows] = useState<Commission[]>([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    sget<{ total_poisha: number; count: number; commissions: Commission[] }>('/agent/commissions')
      .then((r) => { setTotal(r.total_poisha); setCount(r.count); setRows(r.commissions); })
      .catch((e: ApiError) => setError(errorText(t, e)))
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <Loading rows={2} />;

  return (
    <div className="stack">
      <PageHead title={t('ag.nav.commissions')} sub={t('ag.cm.sub')} />
      {error && <ErrorNotice message={error} />}

      {/* The total is the hero, at the size of the number it actually is —
          an agent opens this page to answer "how much have I made", not to
          audit a table. */}
      <div className="card card-pad" data-fig="earned">
        <div className="moneyline">
          <span className="m-what">{t('ag.cm.earned')}</span>
          <span className="m-amount" style={{ fontSize: '2.4rem' }}>{fmt.taka(total)}</span>
        </div>
      </div>

      <div className="tiles">
        <Tile k={t('ag.cm.tickets')} n={count} />
        <Tile k={t('ag.cm.average')} n={count ? fmt.taka(Math.round(total / count)) : '—'} />
      </div>

      <div className="table-wrap">
        <table className="data">
          <thead>
            <tr>
              <th>{t('co.s.pnr')}</th><th>{t('ag.cm.rule')}</th>
              <th>{t('ag.when')}</th><th className="num">{t('ag.amount')}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((c) => (
              <tr key={c.pnr}>
                <td><Ref value={c.pnr} /></td>
                <td className="muted small">
                  {c.rule_kind === 'PCT'
                    ? t('ag.cm.pct', { pct: (c.rule_bp / 100).toFixed(2) })
                    : t('ag.cm.flat')}
                </td>
                <td className="muted small">{fmt.dateTime(c.created_at)}</td>
                <td className="num" style={{ color: 'var(--ok)' }}>
                  <Money poisha={c.amount_poisha} decimals />
                </td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr><td colSpan={4} className="muted center">{t('ag.cm.empty')}</td></tr>
            )}
          </tbody>
        </table>
      </div>

      <p className="small muted">{t('ag.cm.foot')}</p>
    </div>
  );
}
