'use client';

import { useEffect, useState } from 'react';
import { ApiError } from '@/lib/api';
import { sget } from '@/lib/staff';
import { ErrorNotice, Loading } from '@/components/ui';
import { PageHead } from '@/components/staff-ui';
import { dateTimeOf } from '@/lib/format';

interface Entry {
  audit_id: number; actor: string; role: string; action: string;
  resource: string; occurred_at: string; detail: string;
}

export default function AuditPage() {
  const [rows, setRows] = useState<Entry[]>([]);
  const [q, setQ] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    sget<{ entries: Entry[] }>('/admin/audit')
      .then((r) => setRows(r.entries))
      .catch((e: ApiError) => setError(e.message))
      .finally(() => setLoading(false));
  }, []);

  const shown = q
    ? rows.filter((r) =>
        [r.actor, r.action, r.resource, r.detail].join(' ').toLowerCase().includes(q.toLowerCase()))
    : rows;

  if (loading) return <Loading rows={3} />;

  return (
    <div className="stack">
      <PageHead
        title="Audit log"
        sub="Append-only at the database grant level — UPDATE and DELETE are revoked, not merely discouraged"
        actions={
          <input className="input" style={{ width: 240 }} placeholder="Filter…"
                 value={q} onChange={(e) => setQ(e.target.value)} aria-label="Filter audit log" />
        }
      />
      {error && <ErrorNotice message={error} />}

      <div className="table-wrap">
        <table className="data">
          <thead>
            <tr><th className="num">#</th><th>When</th><th>Who</th><th>Role</th><th>Action</th><th>Resource</th><th>Detail</th></tr>
          </thead>
          <tbody>
            {shown.map((e) => (
              <tr key={e.audit_id}>
                <td className="num muted">{e.audit_id}</td>
                <td className="small muted">{dateTimeOf(e.occurred_at)}</td>
                <td>{e.actor}</td>
                <td className="small muted">{e.role?.replace(/_/g, ' ').toLowerCase()}</td>
                <td className="mono small">{e.action}</td>
                <td className="mono small">{e.resource}</td>
                <td className="small muted">{e.detail}</td>
              </tr>
            ))}
            {shown.length === 0 && (
              <tr><td colSpan={7} className="muted center">Nothing matches.</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
