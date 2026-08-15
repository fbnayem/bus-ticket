'use client';

import { useEffect, useState } from 'react';
import { ApiError } from '@/lib/api';
import { sget } from '@/lib/staff';
import { ErrorNotice, Loading } from '@/components/ui';
import { PageHead, Money, Variance } from '@/components/staff-ui';
import { dateTimeOf } from '@/lib/format';

interface Counter {
  counter_id: string; name: string; address: string; status: string;
  city: string; shift_open: boolean; revenue_today_poisha: number;
}
interface Shift {
  shift_id: string; status: string; opened_at: string; closed_at?: string;
  opening_float_poisha: number; counted_cash_poisha: number;
  expected_cash_poisha: number; variance_poisha: number;
  clerk: string; sale_count: number;
}

export default function CountersPage() {
  const [counters, setCounters] = useState<Counter[]>([]);
  const [selected, setSelected] = useState<Counter | null>(null);
  const [shifts, setShifts] = useState<Shift[]>([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    sget<{ counters: Counter[] }>('/operator/counters')
      .then((r) => setCounters(r.counters))
      .catch((e: ApiError) => setError(e.message))
      .finally(() => setLoading(false));
  }, []);

  const openCounter = async (c: Counter) => {
    setSelected(c);
    try {
      setShifts((await sget<{ shifts: Shift[] }>(`/counter/shifts?counter_id=${c.counter_id}`)).shifts);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not load shifts.');
    }
  };

  if (loading) return <Loading rows={2} />;

  return (
    <div className="stack">
      <PageHead title="Counters" sub="Physical ticket windows and their cash drawers" />
      {error && <ErrorNotice message={error} />}

      <div className="table-wrap">
        <table className="data">
          <thead>
            <tr><th>Counter</th><th>Where</th><th>Drawer</th><th className="num">Sold today</th><th /></tr>
          </thead>
          <tbody>
            {counters.map((c) => (
              <tr key={c.counter_id}>
                <td><strong>{c.name}</strong></td>
                <td className="small muted">{c.address || c.city}</td>
                <td>
                  {c.shift_open
                    ? <span className="pill pill-ok">Open</span>
                    : <span className="pill">Closed</span>}
                </td>
                <td className="num"><Money poisha={c.revenue_today_poisha} /></td>
                <td><button className="btn btn-sm btn-ghost" onClick={() => openCounter(c)}>Shifts</button></td>
              </tr>
            ))}
            {counters.length === 0 && (
              <tr><td colSpan={5} className="muted center">No counters configured.</td></tr>
            )}
          </tbody>
        </table>
      </div>

      {selected && (
        <div className="stack">
          <div className="row-between">
            <h3 style={{ marginBottom: 0 }}>{selected.name} — shift history</h3>
            <button className="btn btn-ghost btn-sm" onClick={() => setSelected(null)}>Close</button>
          </div>
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>Opened</th><th>Closed</th><th>Clerk</th><th className="num">Sales</th>
                  <th className="num">Expected</th><th className="num">Counted</th><th>Result</th>
                </tr>
              </thead>
              <tbody>
                {shifts.map((s) => (
                  <tr key={s.shift_id}>
                    <td className="small">{dateTimeOf(s.opened_at)}</td>
                    <td className="small muted">{s.closed_at ? dateTimeOf(s.closed_at) : '—'}</td>
                    <td>{s.clerk}</td>
                    <td className="num">{s.sale_count}</td>
                    <td className="num"><Money poisha={s.expected_cash_poisha} decimals /></td>
                    <td className="num"><Money poisha={s.counted_cash_poisha} decimals /></td>
                    <td>
                      {s.status === 'OPEN'
                        ? <span className="pill pill-warn">Still open</span>
                        : <Variance poisha={s.variance_poisha} />}
                    </td>
                  </tr>
                ))}
                {shifts.length === 0 && (
                  <tr><td colSpan={7} className="muted center">No shifts recorded.</td></tr>
                )}
              </tbody>
            </table>
          </div>
          <p className="small muted">
            A variance is posted to the Cash Variance account, so the books stay
            balanced and the difference stays visible rather than being absorbed.
          </p>
        </div>
      )}
    </div>
  );
}
