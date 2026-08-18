'use client';

import { useCallback, useEffect, useState } from 'react';
import { ApiError } from '@/lib/api';
import { sget } from '@/lib/staff';
import { ErrorNotice, Loading } from '@/components/ui';
import { PageHead, Money, Tile, Bar } from '@/components/staff-ui';
import { taka, isoDate } from '@/lib/format';

interface StaffRow {
  staff_id: string;
  full_name: string;
  roles: string;
  tickets: number;
  gross_poisha: number;
  discount_poisha: number;
  commission_poisha: number;
}
interface Report {
  from: string; to: string;
  staff: StaffRow[];
  totals: { tickets: number; gross_poisha: number; discount_poisha: number; commission_poisha: number };
}

const ROLE_LABEL: Record<string, string> = {
  COUNTER_AGENT: 'Counter', DRIVER: 'Driver', HELPER: 'Helper',
  SUPERVISOR: 'Supervisor', AGENT_OWNER: 'Agent', SUB_AGENT: 'Sub-agent',
  OPERATOR_MANAGER: 'Manager', OPERATOR_OWNER: 'Owner',
};

function roleLabel(roles: string): string {
  return roles.split(', ').map((r) => ROLE_LABEL[r] ?? r).filter(Boolean).join(', ');
}

export default function SalesByStaffPage() {
  const [from, setFrom] = useState(isoDate(new Date(Date.now() - 29 * 864e5)));
  const [to, setTo] = useState(isoDate(new Date()));
  const [r, setR] = useState<Report | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  const load = useCallback(() => {
    setLoading(true);
    setError('');
    sget<Report>(`/owner/sales-by-staff?from=${from}&to=${to}`)
      .then(setR)
      .catch((e: ApiError) => setError(e.message))
      .finally(() => setLoading(false));
  }, [from, to]);

  useEffect(() => { load(); }, [load]);

  const maxGross = Math.max(1, ...(r?.staff.map((s) => s.gross_poisha) ?? [1]));

  return (
    <div className="stack">
      <PageHead
        title="Sales by staff"
        sub="Who sold how many tickets, and what they earned"
        actions={
          <div className="row" style={{ gap: '.4rem' }}>
            <input className="input" type="date" value={from} style={{ width: 150 }}
                   onChange={(e) => setFrom(e.target.value)} aria-label="From" />
            <input className="input" type="date" value={to} style={{ width: 150 }}
                   onChange={(e) => setTo(e.target.value)} aria-label="To" />
          </div>
        }
      />
      {error && <ErrorNotice message={error} />}
      {loading || !r ? <Loading rows={2} /> : (
        <>
          <div className="tiles">
            <Tile k="Tickets sold" n={r.totals.tickets} />
            <Tile k="Total sales" n={taka(r.totals.gross_poisha)} />
            <Tile k="Discounts given" n={taka(r.totals.discount_poisha)} />
            <Tile k="Commission earned" n={taka(r.totals.commission_poisha)} />
          </div>
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>Staff</th><th>Role</th>
                  <th>Sales</th>
                  <th className="num">Tickets</th>
                  <th className="num">Discount</th>
                  <th className="num">Commission</th>
                </tr>
              </thead>
              <tbody>
                {r.staff.map((s) => (
                  <tr key={s.staff_id}>
                    <td>{s.full_name}</td>
                    <td className="muted">{roleLabel(s.roles)}</td>
                    <td style={{ width: '30%' }}>
                      <div className="row" style={{ gap: '.5rem', flexWrap: 'nowrap' }}>
                        <Bar value={s.gross_poisha} max={maxGross} />
                        <span className="tnum small">{taka(s.gross_poisha)}</span>
                      </div>
                    </td>
                    <td className="num">{s.tickets}</td>
                    <td className="num muted">{s.discount_poisha ? <Money poisha={s.discount_poisha} /> : '—'}</td>
                    <td className="num">{s.commission_poisha ? <Money poisha={s.commission_poisha} /> : '—'}</td>
                  </tr>
                ))}
                {r.staff.length === 0 && (
                  <tr><td colSpan={6} className="muted center">No staff sales in this window.</td></tr>
                )}
              </tbody>
            </table>
          </div>
          <p className="small muted">
            A ticket is attributed to whoever sold it — the counter clerk, the
            agent, or the conductor who sold it on the bus. Commission is shown
            for the channels that earn it; the website and app earn none.
          </p>
        </>
      )}
    </div>
  );
}
