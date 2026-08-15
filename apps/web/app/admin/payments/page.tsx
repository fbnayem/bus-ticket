'use client';

import { useEffect, useState } from 'react';
import { ApiError } from '@/lib/api';
import { sget } from '@/lib/staff';
import { ErrorNotice, Loading } from '@/components/ui';
import { PageHead, Money } from '@/components/staff-ui';
import { dateTimeOf } from '@/lib/format';

interface Payment {
  provider: string; provider_txn_id: string; amount_poisha: number;
  currency: string; status: string; created_at: string; pnr: string;
}
interface Hook {
  provider: string; provider_txn_id: string; signature_ok: boolean;
  accepted: boolean; reject_reason: string; received_at: string;
}

const REJECT_LABEL: Record<string, string> = {
  bad_signature: 'Signature did not verify',
  bad_currency: 'Wrong currency',
  amount_mismatch: 'Amount did not match the booking',
  unknown_booking: 'No such booking',
  duplicate: 'Already processed — replay',
};

export default function PaymentsPage() {
  const [payments, setPayments] = useState<Payment[]>([]);
  const [hooks, setHooks] = useState<Hook[]>([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    sget<{ payments: Payment[]; webhooks: Hook[] }>('/admin/payments')
      .then((r) => { setPayments(r.payments); setHooks(r.webhooks); })
      .catch((e: ApiError) => setError(e.message))
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <Loading rows={3} />;
  if (error) return <ErrorNotice message={error} />;

  return (
    <div className="stack">
      <PageHead title="Payments" sub="Money in, and every notification the providers sent us" />

      <div className="table-wrap">
        <table className="data">
          <thead>
            <tr><th>When</th><th>PNR</th><th>Provider</th><th>Transaction</th><th className="num">Amount</th><th>Status</th></tr>
          </thead>
          <tbody>
            {payments.map((p) => (
              <tr key={p.provider + p.provider_txn_id}>
                <td className="muted small">{dateTimeOf(p.created_at)}</td>
                <td className="mono">{p.pnr}</td>
                <td>{p.provider}</td>
                <td className="mono small">{p.provider_txn_id.slice(0, 20)}</td>
                <td className="num"><Money poisha={p.amount_poisha} decimals /></td>
                <td><span className="pill pill-ok">{p.status.toLowerCase()}</span></td>
              </tr>
            ))}
            {payments.length === 0 && <tr><td colSpan={6} className="muted center">No payments.</td></tr>}
          </tbody>
        </table>
      </div>

      <div>
        <h3 style={{ marginBottom: '.35rem' }}>Provider notifications</h3>
        <p className="small muted" style={{ marginBottom: '.5rem' }}>
          Rejections are the interesting rows: each one is a defence doing its
          job. A duplicate is not an error — it is the same notification arriving
          twice and being collapsed to a single payment by a database constraint.
        </p>
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr><th>Received</th><th>Provider</th><th>Transaction</th><th>Signature</th><th>Outcome</th></tr>
            </thead>
            <tbody>
              {hooks.map((h, i) => (
                <tr key={i}>
                  <td className="muted small">{dateTimeOf(h.received_at)}</td>
                  <td>{h.provider}</td>
                  <td className="mono small">{h.provider_txn_id.slice(0, 20)}</td>
                  <td>
                    <span className={`pill ${h.signature_ok ? 'pill-ok' : 'pill-danger'}`}>
                      {h.signature_ok ? 'valid' : 'invalid'}
                    </span>
                  </td>
                  <td>
                    {h.accepted
                      ? <span className="pill pill-ok">accepted</span>
                      : <span className="pill pill-warn">{REJECT_LABEL[h.reject_reason] ?? h.reject_reason}</span>}
                  </td>
                </tr>
              ))}
              {hooks.length === 0 && <tr><td colSpan={5} className="muted center">No notifications yet.</td></tr>}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
