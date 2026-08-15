'use client';

import { useEffect, useState } from 'react';
import { ApiError } from '@/lib/api';
import { sget } from '@/lib/staff';
import { ErrorNotice, Loading } from '@/components/ui';
import { PageHead, Money, Tile } from '@/components/staff-ui';
import { taka } from '@/lib/format';

interface Agency {
  agency_id: string; name: string; parent: string; kyc_status: string; status: string;
  available_poisha: number; held_poisha: number; credit_limit_poisha: number;
  spendable_poisha: number; bookings: number; commission_poisha: number;
}

export default function AdminAgentsPage() {
  const [rows, setRows] = useState<Agency[]>([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    sget<{ agencies: Agency[] }>('/admin/agents')
      .then((r) => setRows(r.agencies))
      .catch((e: ApiError) => setError(e.message))
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <Loading rows={2} />;

  const exposure = rows.reduce((a, r) => a + Math.max(0, r.held_poisha - r.available_poisha), 0);
  const creditGiven = rows.reduce((a, r) => a + r.credit_limit_poisha, 0);

  return (
    <div className="stack">
      <PageHead title="Agencies" sub="Wallet balances, credit exposure and commission earned" />
      {error && <ErrorNotice message={error} />}

      <div className="tiles">
        <Tile k="Agencies" n={rows.length} />
        <Tile k="Credit extended" n={taka(creditGiven)} hint="total agreed overdraft" />
        <Tile k="Credit in use" n={taka(exposure)} hint="what would be lost today" />
      </div>

      <div className="table-wrap">
        <table className="data">
          <thead>
            <tr>
              <th>Agency</th><th>Parent</th><th>KYC</th>
              <th className="num">Balance</th><th className="num">Held</th>
              <th className="num">Credit</th><th className="num">Spendable</th>
              <th className="num">Sold</th><th className="num">Commission</th><th>Status</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((a) => (
              <tr key={a.agency_id}>
                <td><strong>{a.name}</strong></td>
                <td className="muted small">{a.parent || '—'}</td>
                <td>
                  <span className={`pill ${a.kyc_status === 'VERIFIED' ? 'pill-ok' : 'pill-warn'}`}>
                    {a.kyc_status.toLowerCase()}
                  </span>
                </td>
                <td className="num"><Money poisha={a.available_poisha} /></td>
                <td className="num muted">{a.held_poisha ? <Money poisha={a.held_poisha} /> : '—'}</td>
                <td className="num muted"><Money poisha={a.credit_limit_poisha} /></td>
                <td className="num"><strong><Money poisha={a.spendable_poisha} /></strong></td>
                <td className="num">{a.bookings}</td>
                <td className="num"><Money poisha={a.commission_poisha} /></td>
                <td>
                  <span className={`pill ${a.status === 'ACTIVE' ? 'pill-ok' : 'pill-danger'}`}>
                    {a.status.toLowerCase()}
                  </span>
                </td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr><td colSpan={10} className="muted center">No agencies.</td></tr>
            )}
          </tbody>
        </table>
      </div>

      <p className="small muted">
        Every wallet figure here is derived from the append-only transaction log,
        not from a balance column somebody could edit.
      </p>
    </div>
  );
}
