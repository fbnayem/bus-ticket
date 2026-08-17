'use client';

import { useCallback, useEffect, useState } from 'react';
import { ApiError } from '@/lib/api';
import { sget, spost } from '@/lib/staff';
import { queue } from '@/lib/offline';
import { ErrorNotice, Loading } from '@/components/ui';
import { PageHead, Money, Tile, Variance } from '@/components/staff-ui';
import { useLang } from '@/components/LangProvider';
import { errorText } from '@/lib/i18n';

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
  const { t, fmt } = useLang();
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
      setError(errorText(t, e, 'co.sh.failLoad'));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => { void load(); }, [load]);

  const open = async () => {
    setBusy(true); setError('');
    try {
      await spost('/counter/shifts', { opening_float_poisha: Math.round(Number(float) * 100) });
      setFlash(t('co.sh.openedFlash'));
      await load();
    } catch (e) {
      setError(errorText(t, e, 'co.sh.failOpen'));
    } finally { setBusy(false); }
  };

  const close = async () => {
    if (!ctx?.shift) return;
    const pending = queue.all().length;
    if (pending > 0) {
      // The plan is explicit about this: a shift cannot close with a pending
      // replay queue, because the cash for those sales is in the drawer but the
      // sales are not yet in the ledger.
      setError(pending === 1 ? t('co.sh.pending1') : t('co.sh.pending', { count: pending }));
      return;
    }
    setBusy(true); setError('');
    try {
      const res = await spost<{ status: string; expected_cash_poisha: number; variance_poisha: number }>(
        '/counter/shifts/close',
        { shift_id: ctx.shift.shift_id, counted_cash_poisha: Math.round(Number(counted) * 100), note });
      const gap = fmt.taka(Math.abs(res.variance_poisha), { decimals: true });
      setFlash(
        res.variance_poisha === 0
          ? t('co.sh.balanced', { amount: fmt.taka(res.expected_cash_poisha, { decimals: true }) })
          : res.variance_poisha < 0
            ? t('co.sh.short', { amount: gap })
            : t('co.sh.over', { amount: gap }));
      setNote('');
      await load();
    } catch (e) {
      setError(errorText(t, e, 'co.sh.failClose'));
    } finally { setBusy(false); }
  };

  if (loading) return <Loading rows={2} />;

  const s = ctx?.shift;

  return (
    <div className="stack">
      <PageHead title={t('co.nav.shift')} sub={ctx ? `${ctx.name} · ${ctx.operator}` : ''} />

      {error && <ErrorNotice message={error} />}
      {flash && <div className="notice notice-info">{flash}</div>}

      {s ? (
        <>
          <div className="tiles">
            <Tile k={t('co.sh.opened')} n={fmt.time(s.opened_at)} hint={fmt.dateTime(s.opened_at)} />
            <Tile k={t('co.sh.float')} n={fmt.taka(s.opening_float_poisha)} />
            <Tile k={t('co.sh.cashSales')} n={fmt.taka(s.cash_sales_poisha)}
                  hint={s.sale_count === 1 ? t('co.sh.saleCount1') : t('co.sh.saleCount', { count: s.sale_count })} />
            <Tile k={t('co.sh.expected')} n={fmt.taka(s.expected_cash_poisha)} hint={t('co.sh.expectedHint')} />
          </div>

          <div className="card card-pad stack" style={{ maxWidth: 460 }}>
            <h3>{t('co.sh.closeTitle')}</h3>
            <p className="small muted" style={{ marginBottom: 0 }}>{t('co.sh.countHint')}</p>
            <div className="field">
              <label className="label" htmlFor="counted">{t('co.sh.counted')}</label>
              <input id="counted" className="input tnum" type="number" step="0.01"
                     value={counted} onChange={(e) => setCounted(e.target.value)}
                     style={{ fontSize: '1.3rem' }} />
            </div>
            <div className="field">
              <label className="label" htmlFor="note">{t('co.sh.note')}</label>
              <input id="note" className="input" value={note} onChange={(e) => setNote(e.target.value)}
                     placeholder={t('co.sh.notePlaceholder')} />
            </div>
            {counted !== '' && (
              <div className="row-between">
                <span className="small muted">{t('co.sh.difference')}</span>
                <Variance poisha={Math.round(Number(counted) * 100) - s.expected_cash_poisha} />
              </div>
            )}
            <button className="btn btn-primary btn-block btn-lg" disabled={busy || counted === ''}
                    onClick={close} data-act="close-shift">
              {busy ? t('co.sh.closing') : t('co.sh.close')}
            </button>
          </div>
        </>
      ) : (
        <div className="card card-pad stack" style={{ maxWidth: 420 }}>
          <h3>{t('co.sh.openTitle')}</h3>
          <p className="small muted" style={{ marginBottom: 0 }}>{t('co.sh.openHint')}</p>
          <div className="field">
            <label className="label" htmlFor="float">{t('co.sh.floatLabel')}</label>
            <input id="float" className="input tnum" type="number" step="1"
                   value={float} onChange={(e) => setFloat(e.target.value)}
                   style={{ fontSize: '1.3rem' }} />
          </div>
          <button className="btn btn-primary btn-block btn-lg" disabled={busy}
                  onClick={open} data-act="open-shift">
            {busy ? t('co.sh.opening') : t('co.sh.open')}
          </button>
        </div>
      )}

      <div>
        <h3 style={{ marginBottom: '.5rem' }}>{t('co.sh.history')}</h3>
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>{t('co.sh.opened')}</th><th>{t('co.sh.clerk')}</th>
                <th className="num">{t('co.sh.sales')}</th>
                <th className="num">{t('co.sh.expected')}</th>
                <th className="num">{t('co.sh.countedShort')}</th>
                <th>{t('co.sh.result')}</th>
              </tr>
            </thead>
            <tbody>
              {history.map((h) => (
                <tr key={h.shift_id}>
                  <td>{fmt.dateTime(h.opened_at)}</td>
                  <td>{h.clerk}</td>
                  <td className="num">{h.sale_count}</td>
                  <td className="num"><Money poisha={h.expected_cash_poisha} decimals /></td>
                  <td className="num"><Money poisha={h.counted_cash_poisha} decimals /></td>
                  <td>
                    {h.status === 'OPEN'
                      ? <span className="pill pill-warn">{t('co.sh.stillOpen')}</span>
                      : <Variance poisha={h.variance_poisha} />}
                  </td>
                </tr>
              ))}
              {history.length === 0 && (
                <tr><td colSpan={6} className="muted center">{t('co.sh.noneYet')}</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
