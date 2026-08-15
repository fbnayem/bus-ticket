'use client';

import { useCallback, useEffect, useState } from 'react';
import { ApiError } from '@/lib/api';
import { sget, spost } from '@/lib/staff';
import { queue } from '@/lib/offline';
import { ErrorNotice, Loading } from '@/components/ui';
import { PageHead, Money, Tile, Variance } from '@/components/staff-ui';
import { taka, dateTimeOf } from '@/lib/format';

// The cash drawer.
//
// A shift closes by counting the money and comparing it to what the ledger says
// should be there. A difference is never quietly absorbed: it posts an explicit
// Cash Variance entry so the books stay balanced and the discrepancy stays
// visible in the accounts rather than in somebody's memory.

interface Ctx {
  counter_id: string;
  name: string;
  operator: string;
  shift?: {
    shift_id: string;
    opened_at: string;
    opening_float_poisha: number;
    cash_sales_poisha: number;
    expected_cash_poisha: number;
    sale_count: number;
  };
}

interface Shift {
  shift_id: string; status: string; opened_at: string; closed_at?: string;
  opening_float_poisha: number; counted_cash_poisha: number;
  expected_cash_poisha: number; variance_poisha: number;
  clerk: string; sale_count: number;
}

export default function ShiftPage() {
  const [ctx, setCtx] = useState<Ctx | null>(null);
  const [history, setHistory] = useState<Shift[]>([]);
  const [error, setError] = useState('');
  const [flash, setFlash] = useState('');
  const [float, setFloat] = useState('2000');
  const [counted, setCounted] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      const [c, h] = await Promise.all([
        sget<Ctx>('/counter/context'),
        sget<{ shifts: Shift[] }>('/counter/shifts'),
      ]);
      setCtx(c);
      setHistory(h.shifts);
      if (c.shift) setCounted(String(c.shift.expected_cash_poisha / 100));
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not load the drawer.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const open = async () => {
    setBusy(true); setError('');
    try {
      await spost('/counter/shifts', { opening_float_poisha: Math.round(Number(float) * 100) });
      setFlash('Shift open. Cash sales are now counted against this drawer.');
      await load();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'The shift could not be opened.');
    } finally { setBusy(false); }
  };

  const close = async () => {
    if (!ctx?.shift) return;
    const pending = queue.all().length;
    if (pending > 0) {
      // The plan is explicit about this: a shift cannot close with a pending
      // replay queue, because the cash for those sales is in the drawer but the
      // sales are not yet in the ledger.
      setError(`${pending} offline sale${pending === 1 ? '' : 's'} have not synced yet. ` +
               'Sync them before closing, or the count cannot be reconciled.');
      return;
    }
    setBusy(true); setError('');
    try {
      const res = await spost<{ status: string; expected_cash_poisha: number; variance_poisha: number }>(
        '/counter/shifts/close',
        { shift_id: ctx.shift.shift_id, counted_cash_poisha: Math.round(Number(counted) * 100), note });
      setFlash(res.variance_poisha === 0
        ? `Drawer balanced at ${taka(res.expected_cash_poisha, { decimals: true })}.`
        : `Closed with a ${taka(Math.abs(res.variance_poisha), { decimals: true })} ` +
          `${res.variance_poisha < 0 ? 'shortfall' : 'surplus'}. A Cash Variance entry has been posted.`);
      setNote('');
      await load();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'The shift could not be closed.');
    } finally { setBusy(false); }
  };

  if (loading) return <Loading rows={2} />;

  const s = ctx?.shift;

  return (
    <div className="stack">
      <PageHead title="Drawer & shift" sub={ctx ? `${ctx.name} · ${ctx.operator}` : ''} />

      {error && <ErrorNotice message={error} />}
      {flash && <div className="notice notice-info">{flash}</div>}

      {s ? (
        <>
          <div className="tiles">
            <Tile k="Opened" n={new Date(s.opened_at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}
                  hint={dateTimeOf(s.opened_at)} />
            <Tile k="Opening float" n={taka(s.opening_float_poisha)} />
            <Tile k="Cash sales" n={taka(s.cash_sales_poisha)} hint={`${s.sale_count} sales`} />
            <Tile k="Expected in drawer" n={taka(s.expected_cash_poisha)} hint="float + cash movements" />
          </div>

          <div className="card card-pad stack" style={{ maxWidth: 460 }}>
            <h3>Close the shift</h3>
            <p className="small muted" style={{ marginBottom: 0 }}>
              Count the drawer and enter what is physically there. Do not adjust it
              to match — the point of the count is to catch the difference.
            </p>
            <div className="field">
              <label className="label" htmlFor="counted">Counted cash (৳)</label>
              <input id="counted" className="input tnum" type="number" step="0.01"
                     value={counted} onChange={(e) => setCounted(e.target.value)} />
            </div>
            <div className="field">
              <label className="label" htmlFor="note">Note (optional)</label>
              <input id="note" className="input" value={note} onChange={(e) => setNote(e.target.value)}
                     placeholder="Anything the manager should know" />
            </div>
            {counted !== '' && (
              <div className="row-between">
                <span className="small muted">Difference</span>
                <Variance poisha={Math.round(Number(counted) * 100) - s.expected_cash_poisha} />
              </div>
            )}
            <button className="btn btn-primary btn-block" disabled={busy || counted === ''} onClick={close}>
              {busy ? 'Closing…' : 'Count and close'}
            </button>
          </div>
        </>
      ) : (
        <div className="card card-pad stack" style={{ maxWidth: 420 }}>
          <h3>Open a shift</h3>
          <p className="small muted" style={{ marginBottom: 0 }}>
            Declare the float you are starting with. Only one drawer can be open
            on a counter at a time — two would make every taka unattributable.
          </p>
          <div className="field">
            <label className="label" htmlFor="float">Opening float (৳)</label>
            <input id="float" className="input tnum" type="number" step="1"
                   value={float} onChange={(e) => setFloat(e.target.value)} />
          </div>
          <button className="btn btn-primary btn-block" disabled={busy} onClick={open}>
            {busy ? 'Opening…' : 'Open shift'}
          </button>
        </div>
      )}

      <div>
        <h3 style={{ marginBottom: '.5rem' }}>Recent shifts</h3>
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>Opened</th><th>Clerk</th><th className="num">Sales</th>
                <th className="num">Expected</th><th className="num">Counted</th><th>Result</th>
              </tr>
            </thead>
            <tbody>
              {history.map((h) => (
                <tr key={h.shift_id}>
                  <td>{dateTimeOf(h.opened_at)}</td>
                  <td>{h.clerk}</td>
                  <td className="num">{h.sale_count}</td>
                  <td className="num"><Money poisha={h.expected_cash_poisha} decimals /></td>
                  <td className="num"><Money poisha={h.counted_cash_poisha} decimals /></td>
                  <td>
                    {h.status === 'OPEN'
                      ? <span className="pill pill-warn">Open</span>
                      : <Variance poisha={h.variance_poisha} />}
                  </td>
                </tr>
              ))}
              {history.length === 0 && (
                <tr><td colSpan={6} className="muted center">No shifts yet.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
