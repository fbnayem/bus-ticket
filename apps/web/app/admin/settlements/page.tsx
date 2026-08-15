'use client';

import { useCallback, useEffect, useState } from 'react';
import { ApiError } from '@/lib/api';
import { sget, spost, can } from '@/lib/staff';
import { useSession } from '@/components/StaffShell';
import { ErrorNotice, Loading } from '@/components/ui';
import { PageHead, Money } from '@/components/staff-ui';
import { SettlementStatus, SettlementDetail, type Settlement } from '@/components/Settlements';
import { isoDate } from '@/lib/format';

interface Operator { operator_id: string; brand: string }

export default function AdminSettlementsPage() {
  const session = useSession();
  const [rows, setRows] = useState<Settlement[]>([]);
  const [operators, setOperators] = useState<Operator[]>([]);
  const [open, setOpen] = useState<Settlement | null>(null);
  const [operatorId, setOperatorId] = useState('');
  const [from, setFrom] = useState(isoDate(new Date(Date.now() - 6 * 864e5)));
  const [to, setTo] = useState(isoDate(new Date()));
  const [error, setError] = useState('');
  const [flash, setFlash] = useState('');
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);

  const load = useCallback(() => {
    Promise.all([
      sget<{ settlements: Settlement[] }>('/admin/settlements'),
      sget<{ operators: Operator[] }>('/admin/operators'),
    ])
      .then(([s, o]) => {
        setRows(s.settlements);
        setOperators(o.operators);
        if (!operatorId && o.operators[0]) setOperatorId(o.operators[0].operator_id);
      })
      .catch((e: ApiError) => setError(e.message))
      .finally(() => setLoading(false));
  }, [operatorId]);

  useEffect(() => { load(); }, [load]);

  const act = async (path: string, body?: unknown, ok?: string) => {
    setError(''); setBusy(true);
    try {
      await spost(path, body);
      setFlash(ok ?? 'Done.');
      const fresh = await sget<{ settlements: Settlement[] }>('/admin/settlements');
      setRows(fresh.settlements);
      if (open) setOpen(fresh.settlements.find((s) => s.settlement_id === open.settlement_id) ?? null);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'That could not be done.');
    } finally { setBusy(false); }
  };

  const mayCalc = can(session?.identity ?? null, 'settlement.calculate');
  const mayApprove = can(session?.identity ?? null, 'settlement.approve');
  // Maker-checker, shown rather than merely enforced: the reviewer never sees
  // an approve button, so nobody presses one only to be refused.
  const iReviewed = !!open?.reviewed_by_id && open.reviewed_by_id === session?.identity.staff_id;

  if (loading) return <Loading rows={3} />;

  return (
    <div className="stack">
      <PageHead title="Settlements" sub="Seven states, two people, no shortcuts" />
      {error && <ErrorNotice message={error} />}
      {flash && <div className="notice notice-info">{flash}</div>}

      {mayCalc && (
        <div className="card card-pad">
          <div className="row" style={{ gap: '.6rem', alignItems: 'flex-end' }}>
            <div className="field" style={{ flex: '1 1 200px' }}>
              <label className="label" htmlFor="op">Operator</label>
              <select id="op" className="select" value={operatorId} onChange={(e) => setOperatorId(e.target.value)}>
                {operators.map((o) => <option key={o.operator_id} value={o.operator_id}>{o.brand}</option>)}
              </select>
            </div>
            <div className="field" style={{ flex: '0 1 160px' }}>
              <label className="label" htmlFor="sf">From</label>
              <input id="sf" className="input" type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
            </div>
            <div className="field" style={{ flex: '0 1 160px' }}>
              <label className="label" htmlFor="st">To</label>
              <input id="st" className="input" type="date" value={to} onChange={(e) => setTo(e.target.value)} />
            </div>
            <button className="btn btn-primary" disabled={busy}
                    onClick={() => act('/admin/settlements/calculate',
                      { operator_id: operatorId, from, to }, 'Settlement calculated from the bookings themselves.')}>
              Calculate
            </button>
          </div>
        </div>
      )}

      <div className="table-wrap">
        <table className="data">
          <thead>
            <tr>
              <th>Operator</th><th>Period</th><th className="num">Bookings</th>
              <th className="num">Gross</th><th className="num">Net payable</th>
              <th>Status</th><th>Reviewed</th><th>Approved</th><th />
            </tr>
          </thead>
          <tbody>
            {rows.map((s) => (
              <tr key={s.settlement_id}>
                <td><strong>{s.operator}</strong></td>
                <td className="small">{s.period_start} → {s.period_end}</td>
                <td className="num">{s.booking_count}</td>
                <td className="num"><Money poisha={s.gross_poisha} /></td>
                <td className="num"><strong><Money poisha={s.net_payable_poisha} /></strong></td>
                <td><SettlementStatus status={s.status} /></td>
                <td className="small muted">{s.reviewed_by || '—'}</td>
                <td className="small muted">{s.approved_by || '—'}</td>
                <td><button className="btn btn-sm btn-ghost" onClick={() => setOpen(s)}>Open</button></td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr><td colSpan={9} className="muted center">No settlements yet.</td></tr>
            )}
          </tbody>
        </table>
      </div>

      {open && (
        <SettlementDetail settlement={open} onClose={() => setOpen(null)}>
          <div className="row">
            {open.status === 'CALCULATED' && mayCalc && (
              <button className="btn btn-brand" disabled={busy}
                      onClick={() => act(`/admin/settlements/${open.settlement_id}/review`, undefined,
                        'Marked reviewed. Someone else must approve it.')}>
                Mark reviewed
              </button>
            )}
            {open.status === 'REVIEWED' && mayApprove && !iReviewed && (
              <button className="btn btn-primary" disabled={busy}
                      onClick={() => act(`/admin/settlements/${open.settlement_id}/approve`, undefined,
                        'Approved.')}>
                Approve for payment
              </button>
            )}
            {open.status === 'REVIEWED' && mayApprove && iReviewed && (
              <span className="small muted">
                You reviewed this settlement, so you cannot also approve it.
                It needs a second person with approval rights.
              </span>
            )}
            {open.status === 'APPROVED' && mayApprove && (
              <button className="btn btn-primary" disabled={busy}
                      onClick={() => act(`/admin/settlements/${open.settlement_id}/pay`,
                        { reference: 'BEFTN-' + Date.now().toString().slice(-8) },
                        'Marked paid. Operator Payable has been cleared in the ledger.')}>
                Mark paid
              </button>
            )}
            {open.status === 'REVIEWED' && !mayApprove && (
              <span className="small muted">
                Waiting for someone with approval rights.
              </span>
            )}
          </div>
        </SettlementDetail>
      )}
    </div>
  );
}
