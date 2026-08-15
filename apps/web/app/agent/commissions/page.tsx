'use client';

import { useEffect, useState } from 'react';
import { ApiError } from '@/lib/api';
import { sget } from '@/lib/staff';
import { ErrorNotice, Loading } from '@/components/ui';
import { PageHead, Money, Tile } from '@/components/staff-ui';
import { taka, dateTimeOf } from '@/lib/format';

interface Commission {
  pnr: string; amount_poisha: number; created_at: string;
  rule_kind: string; rule_bp: number;
}

export default function CommissionsPage() {
  const [total, setTotal] = useState(0);
  const [count, setCount] = useState(0);
  const [rows, setRows] = useState<Commission[]>([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    sget<{ total_poisha: number; count: number; commissions: Commission[] }>('/agent/commissions')
      .then((r) => { setTotal(r.total_poisha); setCount(r.count); setRows(r.commissions); })
      .catch((e: ApiError) => setError(e.message))
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <Loading rows={2} />;

  return (
    <div className="stack">
      <PageHead
        title="Commission"
        sub="Credited to your wallet as each ticket is issued, never as a lump adjustment"
      />
      {error && <ErrorNotice message={error} />}

      <div className="tiles">
        <Tile k="Earned to date" n={taka(total)} />
        <Tile k="Tickets" n={count} />
        <Tile k="Average per ticket" n={count ? taka(Math.round(total / count)) : '—'} />
      </div>

      <div className="table-wrap">
        <table className="data">
          <thead>
            <tr><th>PNR</th><th>Rule applied</th><th>Earned</th><th className="num">Amount</th></tr>
          </thead>
          <tbody>
            {rows.map((c) => (
              <tr key={c.pnr}>
                <td className="mono">{c.pnr}</td>
                <td className="muted small">
                  {c.rule_kind === 'PCT' ? `${(c.rule_bp / 100).toFixed(2)}% of fare` : 'Flat rate'}
                </td>
                <td className="muted small">{dateTimeOf(c.created_at)}</td>
                <td className="num" style={{ color: 'var(--ok)' }}>
                  <Money poisha={c.amount_poisha} decimals />
                </td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr><td colSpan={4} className="muted center">No commission yet.</td></tr>
            )}
          </tbody>
        </table>
      </div>

      <p className="small muted">
        The rule that applies to a sale is the most specific one configured: a
        rule naming both your agency and the operator beats one naming the
        operator alone.
      </p>
    </div>
  );
}
