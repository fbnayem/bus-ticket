'use client';

import { useCallback, useEffect, useState } from 'react';
import { ApiError } from '@/lib/api';
import { sget, spost, can } from '@/lib/staff';
import { useSession } from '@/components/StaffShell';
import { ErrorNotice, Loading } from '@/components/ui';
import { PageHead, Money } from '@/components/staff-ui';
import { dateOf } from '@/lib/format';

interface Operator {
  operator_id: string; brand: string; legal_name: string; status: string;
  created_at: string; buses: number; routes: number; counters: number; gmv_poisha: number;
}

const STATUSES = ['PENDING', 'ACTIVE', 'SUSPENDED', 'BLOCKED', 'TERMINATED'];

export default function AdminOperatorsPage() {
  const session = useSession();
  const [rows, setRows] = useState<Operator[]>([]);
  const [error, setError] = useState('');
  const [flash, setFlash] = useState('');
  const [loading, setLoading] = useState(true);

  const load = useCallback(() => {
    sget<{ operators: Operator[] }>('/admin/operators')
      .then((r) => setRows(r.operators))
      .catch((e: ApiError) => setError(e.message))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { load(); }, [load]);

  const setStatus = async (o: Operator, status: string) => {
    setError('');
    try {
      await spost(`/admin/operators/${o.operator_id}/status`, { status });
      setFlash(
        status === 'ACTIVE'
          ? `${o.brand} can sell again.`
          : `${o.brand} is now ${status.toLowerCase()}. Existing tickets are unaffected.`);
      load();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'The status could not be changed.');
    }
  };

  const mayWrite = can(session?.identity ?? null, 'operator.write');

  if (loading) return <Loading rows={2} />;

  return (
    <div className="stack">
      <PageHead title="Operators" sub="Bus companies selling on the platform" />
      {error && <ErrorNotice message={error} />}
      {flash && <div className="notice notice-info">{flash}</div>}

      <div className="table-wrap">
        <table className="data">
          <thead>
            <tr>
              <th>Brand</th><th>Legal name</th><th className="num">Buses</th>
              <th className="num">Routes</th><th className="num">Counters</th>
              <th className="num">Gross sales</th><th>Joined</th><th>Status</th>
              {mayWrite && <th />}
            </tr>
          </thead>
          <tbody>
            {rows.map((o) => (
              <tr key={o.operator_id}>
                <td><strong>{o.brand}</strong></td>
                <td className="muted small">{o.legal_name}</td>
                <td className="num">{o.buses}</td>
                <td className="num">{o.routes}</td>
                <td className="num">{o.counters}</td>
                <td className="num"><Money poisha={o.gmv_poisha} /></td>
                <td className="muted small">{dateOf(o.created_at)}</td>
                <td>
                  <span className={`pill ${o.status === 'ACTIVE' ? 'pill-ok' : o.status === 'PENDING' ? 'pill-warn' : 'pill-danger'}`}>
                    {o.status.toLowerCase()}
                  </span>
                </td>
                {mayWrite && (
                  <td>
                    <select className="select" style={{ width: 130, padding: '.25rem .4rem', fontSize: '.8rem' }}
                            value={o.status} onChange={(e) => setStatus(o, e.target.value)}
                            aria-label={`Status for ${o.brand}`}>
                      {STATUSES.map((s) => <option key={s} value={s}>{s.toLowerCase()}</option>)}
                    </select>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <p className="small muted">
        Suspending an operator stops new sales. It never invalidates a ticket a
        passenger already holds — a passenger is not the party being sanctioned.
      </p>
    </div>
  );
}
