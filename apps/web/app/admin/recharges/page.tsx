'use client';

import { useCallback, useEffect, useState } from 'react';
import { ApiError } from '@/lib/api';
import { sget, spost } from '@/lib/staff';
import { ErrorNotice, Loading } from '@/components/ui';
import { PageHead, Money, Tile } from '@/components/staff-ui';
import { taka, dateTimeOf } from '@/lib/format';

// The checker half of maker-checker, in finance's own workplace.
//
// An agent records money they say they have sent; nothing moves until someone
// here confirms it arrived. Deliberately NOT a screen inside the agent portal:
// the person approving should not have to walk into the account they are
// approving, and the two roles should not share a workspace.

interface Recharge {
  recharge_id: string; agency: string; amount_poisha: number;
  method: string; reference: string; status: string;
  created_at: string; requested_by: string; approved_by: string;
}

export default function AdminRechargesPage() {
  const [rows, setRows] = useState<Recharge[]>([]);
  const [error, setError] = useState('');
  const [flash, setFlash] = useState('');
  const [busy, setBusy] = useState('');
  const [loading, setLoading] = useState(true);

  const load = useCallback(() => {
    sget<{ recharges: Recharge[] }>('/agent/recharges')
      .then((r) => setRows(r.recharges))
      .catch((e: ApiError) => setError(e.message))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { load(); }, [load]);

  const approve = async (r: Recharge) => {
    setError(''); setBusy(r.recharge_id);
    try {
      await spost(`/agent/recharges/${r.recharge_id}/approve`);
      setFlash(`Approved ${taka(r.amount_poisha)} for ${r.agency}. ` +
               'The wallet has been credited and a balanced journal posted.');
      load();
    } catch (e) {
      // The usual cause is trying to approve your own request.
      setError(e instanceof ApiError ? e.message : 'That could not be approved.');
    } finally { setBusy(''); }
  };

  if (loading) return <Loading rows={2} />;

  const pending = rows.filter((r) => r.status === 'REQUESTED');
  const pendingValue = pending.reduce((a, r) => a + r.amount_poisha, 0);

  return (
    <div className="stack">
      <PageHead
        title="Wallet recharges"
        sub="Agents record what they have sent. Money moves only when someone else confirms it arrived."
      />
      {error && <ErrorNotice message={error} />}
      {flash && <div className="notice notice-info">{flash}</div>}

      <div className="tiles">
        <Tile k="Waiting" n={pending.length} hint="unapproved requests" />
        <Tile k="Value waiting" n={taka(pendingValue)} />
        <Tile k="Total recorded" n={rows.length} />
      </div>

      <div className="table-wrap">
        <table className="data">
          <thead>
            <tr>
              <th>Requested</th><th>Agency</th><th>Sent by</th><th>Reference</th>
              <th className="num">Amount</th><th>Requested by</th>
              <th>Approved by</th><th>Status</th><th />
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.recharge_id}>
                <td className="small muted">{dateTimeOf(r.created_at)}</td>
                <td><strong>{r.agency}</strong></td>
                <td>{r.method}</td>
                <td className="mono small">{r.reference || '—'}</td>
                <td className="num"><Money poisha={r.amount_poisha} /></td>
                <td className="small">{r.requested_by}</td>
                <td className="small muted">{r.approved_by || '—'}</td>
                <td>
                  <span className={`pill ${r.status === 'APPROVED' ? 'pill-ok' : r.status === 'REJECTED' ? 'pill-danger' : 'pill-warn'}`}>
                    {r.status.toLowerCase()}
                  </span>
                </td>
                <td>
                  {r.status === 'REQUESTED' && (
                    <button className="btn btn-sm btn-primary" disabled={busy === r.recharge_id}
                            onClick={() => approve(r)}>
                      {busy === r.recharge_id ? 'Approving…' : 'Approve'}
                    </button>
                  )}
                </td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr><td colSpan={9} className="muted center">No recharges recorded.</td></tr>
            )}
          </tbody>
        </table>
      </div>

      <p className="small muted">
        Approving your own request is refused by a CHECK constraint in the
        database, not only by this screen — so it stays refused even if a future
        service forgets to look.
      </p>
    </div>
  );
}
