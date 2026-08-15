'use client';

import { useEffect, useState } from 'react';
import { sget } from '@/lib/staff';
import { Money } from '@/components/staff-ui';
import { dateTimeOf } from '@/lib/format';

// Shared between the operator ERP (read-only) and the admin console (which can
// move a settlement through its lifecycle). The seven states are the plan's,
// unabridged — a settlement that jumps from calculated to paid is a settlement
// nobody checked.

export interface Settlement {
  settlement_id: string; operator: string; operator_id: string;
  period_start: string; period_end: string; status: string;
  gross_poisha: number; commission_poisha: number; refund_poisha: number;
  net_payable_poisha: number; booking_count: number;
  reviewed_by: string; approved_by: string; paid_at: string | null;
  reviewed_by_id?: string; approved_by_id?: string;
}

export interface SettlementItem {
  pnr: string; channel: string; status: string;
  gross_poisha: number; commission_poisha: number;
  refund_poisha: number; net_poisha: number; created_at: string;
}

const FLOW = ['OPEN', 'CALCULATED', 'REVIEWED', 'APPROVED', 'PAYMENT_INITIATED', 'PAID', 'RECONCILED'];

export function SettlementStatus({ status }: { status: string }) {
  const tone =
    status === 'PAID' || status === 'RECONCILED' ? 'pill-ok'
    : status === 'APPROVED' ? 'pill-brand'
    : status === 'OPEN' ? '' : 'pill-warn';
  return <span className={`pill ${tone}`}>{status.replace(/_/g, ' ').toLowerCase()}</span>;
}

export function SettlementFlow({ status }: { status: string }) {
  const idx = FLOW.indexOf(status);
  return (
    <ol className="stepper" aria-label="Settlement progress">
      {FLOW.map((s, i) => (
        <li key={s} className={`step ${i < idx ? 'done' : ''} ${i === idx ? 'active' : ''}`}>
          <span className="step-dot" aria-hidden="true">{i < idx ? '✓' : i + 1}</span>
          <span style={{ fontSize: '.78rem' }}>{s.replace(/_/g, ' ').toLowerCase()}</span>
          {i < FLOW.length - 1 && <span className="step-line" aria-hidden="true" />}
        </li>
      ))}
    </ol>
  );
}

export function SettlementDetail({
  settlement, onClose, children,
}: { settlement: Settlement; onClose: () => void; children?: React.ReactNode }) {
  const [items, setItems] = useState<SettlementItem[]>([]);
  const [exceptions, setExceptions] = useState(0);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    sget<{ items: SettlementItem[]; open_exceptions: number }>(
      `/admin/settlements/${settlement.settlement_id}`)
      .then((r) => { setItems(r.items); setExceptions(r.open_exceptions); })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [settlement.settlement_id]);

  return (
    <div className="card card-pad stack">
      <div className="row-between">
        <div>
          <h3 style={{ marginBottom: '.15rem' }}>
            {settlement.operator} · {settlement.period_start} → {settlement.period_end}
          </h3>
          <span className="muted small">{settlement.booking_count} bookings</span>
        </div>
        <button className="btn btn-ghost btn-sm" onClick={onClose}>Close</button>
      </div>

      <SettlementFlow status={settlement.status} />

      <dl className="kv">
        <dt>Gross sales</dt><dd><Money poisha={settlement.gross_poisha} decimals /></dd>
        <dt>Platform commission and fees</dt><dd>−<Money poisha={settlement.commission_poisha} decimals /></dd>
        <dt>Refunds</dt><dd>−<Money poisha={settlement.refund_poisha} decimals /></dd>
        <dt><strong>Net payable</strong></dt>
        <dd><strong><Money poisha={settlement.net_payable_poisha} decimals /></strong></dd>
        {settlement.reviewed_by && <><dt>Reviewed by</dt><dd>{settlement.reviewed_by}</dd></>}
        {settlement.approved_by && <><dt>Approved by</dt><dd>{settlement.approved_by}</dd></>}
        {settlement.paid_at && <><dt>Paid</dt><dd>{dateTimeOf(settlement.paid_at)}</dd></>}
      </dl>

      {exceptions > 0 ? (
        <div className="notice notice-danger">
          <strong>{exceptions} unresolved exception{exceptions === 1 ? '' : 's'} in this period.</strong>{' '}
          Approval is blocked until every one is explained. There are no exceptions
          to the exception rule.
        </div>
      ) : (
        <div className="notice notice-info small">
          Every transaction in this period reconciles.
        </div>
      )}

      {children}

      <div>
        <h4 style={{ marginBottom: '.4rem' }}>Statement lines</h4>
        {loading ? <div className="skeleton" style={{ height: 80 }} /> : (
          <div className="table-wrap" style={{ maxHeight: 340, overflowY: 'auto' }}>
            <table className="data">
              <thead>
                <tr>
                  <th>PNR</th><th>Channel</th><th>Status</th>
                  <th className="num">Gross</th><th className="num">Fee</th>
                  <th className="num">Refund</th><th className="num">Net</th>
                </tr>
              </thead>
              <tbody>
                {items.map((i) => (
                  <tr key={i.pnr}>
                    <td className="mono small">{i.pnr}</td>
                    <td className="small muted">{i.channel.replace(/_/g, ' ').toLowerCase()}</td>
                    <td className="small">{i.status.toLowerCase()}</td>
                    <td className="num"><Money poisha={i.gross_poisha} /></td>
                    <td className="num muted"><Money poisha={i.commission_poisha} /></td>
                    <td className="num muted">{i.refund_poisha ? <Money poisha={i.refund_poisha} /> : '—'}</td>
                    <td className="num"><Money poisha={i.net_poisha} /></td>
                  </tr>
                ))}
                {items.length === 0 && (
                  <tr><td colSpan={7} className="muted center">No lines in this period.</td></tr>
                )}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
