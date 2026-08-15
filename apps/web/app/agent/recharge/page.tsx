'use client';

import { useCallback, useEffect, useState } from 'react';
import { ApiError } from '@/lib/api';
import { can, sget, spost } from '@/lib/staff';
import { useSession } from '@/components/StaffShell';
import { ErrorNotice, Loading } from '@/components/ui';
import { PageHead, Money } from '@/components/staff-ui';
import { dateTimeOf } from '@/lib/format';

// Money entering the platform walks maker → checker. The agent says what they
// sent; a different person in finance confirms it arrived. The database refuses
// a self-approval outright, so this is not merely a workflow convention.

interface Recharge {
  recharge_id: string; agency: string; amount_poisha: number;
  method: string; reference: string; status: string;
  created_at: string; requested_by: string; approved_by: string;
}

export default function RechargePage() {
  const session = useSession();
  const [rows, setRows] = useState<Recharge[]>([]);
  const [amount, setAmount] = useState('5000');
  const [method, setMethod] = useState('BKASH');
  const [reference, setReference] = useState('');
  const [error, setError] = useState('');
  const [flash, setFlash] = useState('');
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);

  const load = useCallback(() => {
    sget<{ recharges: Recharge[] }>('/agent/recharges')
      .then((r) => setRows(r.recharges))
      .catch((e: ApiError) => setError(e.message))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { load(); }, [load]);

  const request = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true); setError('');
    try {
      await spost('/agent/recharges', {
        amount_poisha: Math.round(Number(amount) * 100),
        method,
        reference,
      });
      setFlash('Recorded. Your balance moves when finance confirms the money arrived.');
      setReference('');
      load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'The recharge could not be recorded.');
    } finally { setBusy(false); }
  };


  // Approval happens in the admin console, not here. An agent's own workspace
  // is not the place to sign off money entering their own account.
  const canRequest = can(session?.identity ?? null, 'wallet.recharge');

  if (loading) return <Loading rows={2} />;

  return (
    <div className="stack">
      <PageHead
        title="Recharge"
        sub="Send the money, record it here, and finance confirms it separately"
      />

      {error && <ErrorNotice message={error} />}
      {flash && <div className="notice notice-info">{flash}</div>}

      {canRequest && (
        <form className="card card-pad stack" style={{ maxWidth: 420 }} onSubmit={request}>
          <h3>Record a payment you have sent</h3>
          <div className="field">
            <label className="label" htmlFor="amt">Amount (৳)</label>
            <input id="amt" className="input tnum" type="number" min="1" step="1"
                   value={amount} onChange={(e) => setAmount(e.target.value)} required />
          </div>
          <div className="field">
            <label className="label" htmlFor="mth">Sent by</label>
            <select id="mth" className="select" value={method} onChange={(e) => setMethod(e.target.value)}>
              <option value="BKASH">bKash</option>
              <option value="NAGAD">Nagad</option>
              <option value="BANK">Bank transfer</option>
            </select>
          </div>
          <div className="field">
            <label className="label" htmlFor="ref">Transaction reference</label>
            <input id="ref" className="input mono" value={reference}
                   onChange={(e) => setReference(e.target.value)} placeholder="TRX…" required />
          </div>
          <button className="btn btn-primary btn-block" type="submit" disabled={busy}>
            {busy ? 'Recording…' : 'Record recharge'}
          </button>
          <p className="small muted" style={{ marginBottom: 0 }}>
            This does not add to your balance on its own. Nothing moves until a
            second person in finance confirms the money landed.
          </p>
        </form>
      )}

      <div>
        <h3 style={{ marginBottom: '.5rem' }}>Recharge history</h3>
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>Requested</th><th>Agency</th><th>Method</th><th>Reference</th>
                <th className="num">Amount</th><th>Status</th><th>Requested by</th>
                <th>Approved by</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.recharge_id}>
                  <td className="muted small">{dateTimeOf(r.created_at)}</td>
                  <td>{r.agency}</td>
                  <td>{r.method}</td>
                  <td className="mono small">{r.reference || '—'}</td>
                  <td className="num"><Money poisha={r.amount_poisha} /></td>
                  <td>
                    <span className={`pill ${r.status === 'APPROVED' ? 'pill-ok' : r.status === 'REJECTED' ? 'pill-danger' : 'pill-warn'}`}>
                      {r.status.toLowerCase()}
                    </span>
                  </td>
                  <td className="small">{r.requested_by}</td>
                  <td className="small muted">{r.approved_by || '—'}</td>
                </tr>
              ))}
              {rows.length === 0 && (
                <tr><td colSpan={8} className="muted center">No recharges yet.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
