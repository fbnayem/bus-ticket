'use client';

import { useEffect, useState } from 'react';
import { ApiError } from '@/lib/api';
import { sget } from '@/lib/staff';
import { ErrorNotice, Loading } from '@/components/ui';
import { PageHead, Money } from '@/components/staff-ui';
import { SettlementStatus, SettlementDetail, type Settlement } from '@/components/Settlements';

export default function OperatorSettlementsPage() {
  const [rows, setRows] = useState<Settlement[]>([]);
  const [open, setOpen] = useState<Settlement | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    sget<{ settlements: Settlement[] }>('/operator/settlements')
      .then((r) => setRows(r.settlements))
      .catch((e: ApiError) => setError(e.message))
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <Loading rows={2} />;

  return (
    <div className="stack">
      <PageHead
        title="Settlements"
        sub="What the platform owes you for each period, and where each statement has got to"
      />
      {error && <ErrorNotice message={error} />}

      <div className="table-wrap">
        <table className="data">
          <thead>
            <tr>
              <th>Period</th><th className="num">Bookings</th><th className="num">Gross</th>
              <th className="num">Platform fee</th><th className="num">Refunds</th>
              <th className="num">Payable to you</th><th>Status</th><th />
            </tr>
          </thead>
          <tbody>
            {rows.map((s) => (
              <tr key={s.settlement_id}>
                <td>{s.period_start} → {s.period_end}</td>
                <td className="num">{s.booking_count}</td>
                <td className="num"><Money poisha={s.gross_poisha} /></td>
                <td className="num muted">−<Money poisha={s.commission_poisha} /></td>
                <td className="num muted">{s.refund_poisha ? <>−<Money poisha={s.refund_poisha} /></> : '—'}</td>
                <td className="num"><strong><Money poisha={s.net_payable_poisha} /></strong></td>
                <td><SettlementStatus status={s.status} /></td>
                <td><button className="btn btn-sm btn-ghost" onClick={() => setOpen(s)}>Statement</button></td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr><td colSpan={8} className="muted center">No settlements calculated yet.</td></tr>
            )}
          </tbody>
        </table>
      </div>

      {open && <SettlementDetail settlement={open} onClose={() => setOpen(null)} />}

      <p className="small muted">
        A statement cannot be approved while any transaction in the period fails
        to reconcile, and the person who reviews it can never be the person who
        approves it.
      </p>
    </div>
  );
}
