'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { ApiError } from '@/lib/api';
import { sget, spost } from '@/lib/staff';
import { ErrorNotice, Loading } from '@/components/ui';
import { PageHead, Tile } from '@/components/staff-ui';
import { dateTimeOf } from '@/lib/format';

interface Case {
  case_id: string; reference: string; pnr: string; subject: string;
  category: string; priority: string; status: string;
  created_at: string; assigned_to: string; notes: number;
}

const NEXT_STATUS = ['OPEN', 'IN_PROGRESS', 'WAITING', 'RESOLVED', 'CLOSED'];

export default function CasesPage() {
  const [rows, setRows] = useState<Case[]>([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  const load = useCallback(() => {
    sget<{ cases: Case[] }>('/helpdesk/cases')
      .then((r) => setRows(r.cases))
      .catch((e: ApiError) => setError(e.message))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { load(); }, [load]);

  const setStatus = async (c: Case, status: string) => {
    try {
      await spost(`/helpdesk/cases/${c.case_id}/status`, { status });
      load();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'The case could not be updated.');
    }
  };

  if (loading) return <Loading rows={2} />;

  const open = rows.filter((c) => !['RESOLVED', 'CLOSED'].includes(c.status));

  return (
    <div className="stack">
      <PageHead title="Cases" sub="Open a case from any booking timeline" />
      {error && <ErrorNotice message={error} />}

      <div className="tiles">
        <Tile k="Open" n={open.length} />
        <Tile k="Urgent" n={open.filter((c) => c.priority === 'URGENT').length} />
        <Tile k="Total" n={rows.length} />
      </div>

      <div className="table-wrap">
        <table className="data">
          <thead>
            <tr>
              <th>Reference</th><th>Subject</th><th>PNR</th><th>Category</th>
              <th>Priority</th><th className="num">Notes</th><th>Opened</th><th>Status</th><th />
            </tr>
          </thead>
          <tbody>
            {rows.map((c) => (
              <tr key={c.case_id}>
                <td className="mono small"><strong>{c.reference}</strong></td>
                <td>{c.subject}</td>
                <td className="mono small">
                  {c.pnr ? <Link href={`/helpdesk/booking/${c.pnr}`}>{c.pnr}</Link> : '—'}
                </td>
                <td className="small muted">{c.category.toLowerCase()}</td>
                <td>
                  <span className={`pill ${c.priority === 'URGENT' ? 'pill-danger' : c.priority === 'HIGH' ? 'pill-warn' : ''}`}>
                    {c.priority.toLowerCase()}
                  </span>
                </td>
                <td className="num">{c.notes}</td>
                <td className="small muted">{dateTimeOf(c.created_at)}</td>
                <td>
                  <span className={`pill ${['RESOLVED', 'CLOSED'].includes(c.status) ? 'pill-ok' : 'pill-warn'}`}>
                    {c.status.replace(/_/g, ' ').toLowerCase()}
                  </span>
                </td>
                <td>
                  <select className="select" style={{ width: 130, padding: '.25rem .4rem', fontSize: '.8rem' }}
                          value={c.status} onChange={(e) => setStatus(c, e.target.value)}
                          aria-label={`Status for ${c.reference}`}>
                    {NEXT_STATUS.map((s) => <option key={s} value={s}>{s.replace(/_/g, ' ').toLowerCase()}</option>)}
                  </select>
                </td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr><td colSpan={9} className="muted center">No cases yet.</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
