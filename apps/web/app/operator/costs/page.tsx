'use client';

import { useCallback, useEffect, useState } from 'react';
import { ApiError } from '@/lib/api';
import { sget, spost, staffCall } from '@/lib/staff';
import { ErrorNotice, Loading } from '@/components/ui';
import { PageHead, Money, Tile } from '@/components/staff-ui';
import { taka, isoDate, dateOf } from '@/lib/format';

interface Cost {
  expense_id: string;
  registration: string;
  bus_id: string;
  category: string;
  amount_poisha: number;
  incurred_on: string;
  note: string;
  recorded_by: string;
}
interface CostList { costs: Cost[]; total_poisha: number }
interface Bus { bus_id: string; registration: string }

const CATEGORIES = ['FUEL', 'MAINTENANCE', 'WAGES', 'INSURANCE', 'TOLL', 'PERMIT', 'OTHER'];
const CAT_LABEL: Record<string, string> = {
  FUEL: 'Fuel', MAINTENANCE: 'Maintenance', WAGES: 'Wages', INSURANCE: 'Insurance',
  TOLL: 'Toll', PERMIT: 'Permit', OTHER: 'Other',
};

export default function CostsPage() {
  const [from, setFrom] = useState(isoDate(new Date(Date.now() - 29 * 864e5)));
  const [to, setTo] = useState(isoDate(new Date()));
  const [list, setList] = useState<CostList | null>(null);
  const [buses, setBuses] = useState<Bus[]>([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  // The record form.
  const [busId, setBusId] = useState('');
  const [category, setCategory] = useState('FUEL');
  const [amount, setAmount] = useState('');
  const [incurredOn, setIncurredOn] = useState(isoDate(new Date()));
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);
  const [formErr, setFormErr] = useState('');

  const load = useCallback(() => {
    setLoading(true);
    setError('');
    sget<CostList>(`/owner/costs?from=${from}&to=${to}`)
      .then(setList)
      .catch((e: ApiError) => setError(e.message))
      .finally(() => setLoading(false));
  }, [from, to]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    sget<{ buses: Bus[] }>('/operator/buses').then((d) => setBuses(d.buses)).catch(() => {});
  }, []);

  async function record(e: React.FormEvent) {
    e.preventDefault();
    setFormErr('');
    const taka100 = Math.round(parseFloat(amount) * 100);
    if (!Number.isFinite(taka100) || taka100 <= 0) {
      setFormErr('Enter an amount in taka, more than zero.');
      return;
    }
    setSaving(true);
    try {
      await spost('/owner/costs', {
        bus_id: busId,
        category,
        amount_poisha: taka100,
        incurred_on: incurredOn,
        note: note.trim(),
      });
      setAmount('');
      setNote('');
      load();
    } catch (err) {
      setFormErr((err as ApiError).message);
    } finally {
      setSaving(false);
    }
  }

  async function remove(id: string) {
    try {
      await staffCall(`/owner/costs/${id}`, { method: 'DELETE' });
      load();
    } catch (err) {
      setError((err as ApiError).message);
    }
  }

  return (
    <div className="stack">
      <PageHead
        title="Running costs"
        sub="Fuel, wages, upkeep — the spending the profit & loss subtracts"
        actions={
          <div className="row" style={{ gap: '.4rem' }}>
            <input className="input" type="date" value={from} style={{ width: 150 }}
                   onChange={(e) => setFrom(e.target.value)} aria-label="From" />
            <input className="input" type="date" value={to} style={{ width: 150 }}
                   onChange={(e) => setTo(e.target.value)} aria-label="To" />
          </div>
        }
      />

      <form className="card card-pad stack-sm" onSubmit={record}>
        <h3 style={{ margin: 0 }}>Record a cost</h3>
        <div className="row" style={{ gap: '.6rem', flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <label className="stack-xs">
            <span className="small muted">Bus</span>
            <select className="input" value={busId} onChange={(e) => setBusId(e.target.value)} style={{ width: 200 }}>
              <option value="">Operator-wide (no bus)</option>
              {buses.map((b) => <option key={b.bus_id} value={b.bus_id}>{b.registration}</option>)}
            </select>
          </label>
          <label className="stack-xs">
            <span className="small muted">Category</span>
            <select className="input" value={category} onChange={(e) => setCategory(e.target.value)} style={{ width: 150 }}>
              {CATEGORIES.map((c) => <option key={c} value={c}>{CAT_LABEL[c]}</option>)}
            </select>
          </label>
          <label className="stack-xs">
            <span className="small muted">Amount (৳)</span>
            <input className="input" inputMode="decimal" value={amount} placeholder="0.00"
                   onChange={(e) => setAmount(e.target.value)} style={{ width: 120 }} required />
          </label>
          <label className="stack-xs">
            <span className="small muted">Date spent</span>
            <input className="input" type="date" value={incurredOn}
                   onChange={(e) => setIncurredOn(e.target.value)} style={{ width: 150 }} required />
          </label>
          <label className="stack-xs" style={{ flex: 1, minWidth: 180 }}>
            <span className="small muted">Note</span>
            <input className="input" value={note} placeholder="Diesel, Dhaka depot"
                   onChange={(e) => setNote(e.target.value)} />
          </label>
          <button className="btn btn-brand" type="submit" disabled={saving}>
            {saving ? 'Saving…' : 'Record'}
          </button>
        </div>
        {formErr && <p className="small" style={{ color: 'var(--danger, #b3261e)' }}>{formErr}</p>}
      </form>

      {error && <ErrorNotice message={error} />}
      {loading || !list ? <Loading rows={2} /> : (
        <>
          <div className="tiles">
            <Tile k="Costs in window" n={taka(list.total_poisha)} hint={`${list.costs.length} entries`} />
          </div>
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>Date</th><th>Bus</th><th>Category</th><th>Note</th>
                  <th className="num">Amount</th><th></th>
                </tr>
              </thead>
              <tbody>
                {list.costs.map((c) => (
                  <tr key={c.expense_id}>
                    <td>{dateOf(c.incurred_on)}</td>
                    <td>{c.registration || <span className="muted">Operator-wide</span>}</td>
                    <td>{CAT_LABEL[c.category] ?? c.category}</td>
                    <td className="muted">{c.note}</td>
                    <td className="num"><Money poisha={c.amount_poisha} /></td>
                    <td className="num">
                      <button className="btn btn-ghost small" onClick={() => remove(c.expense_id)}
                              aria-label={`Remove ${CAT_LABEL[c.category]} cost`}>Remove</button>
                    </td>
                  </tr>
                ))}
                {list.costs.length === 0 && (
                  <tr><td colSpan={6} className="muted center">No costs recorded in this window.</td></tr>
                )}
              </tbody>
            </table>
          </div>
          <p className="small muted">
            A cost is corrected by removing it and entering it again — it is never
            stored as a negative amount, so the sign can never be argued about.
            These figures are the operator&apos;s own bookkeeping and do not touch
            the platform ledger.
          </p>
        </>
      )}
    </div>
  );
}
