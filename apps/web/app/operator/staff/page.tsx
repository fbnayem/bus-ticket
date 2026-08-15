'use client';

import { useEffect, useState } from 'react';
import { ApiError } from '@/lib/api';
import { sget } from '@/lib/staff';
import { ErrorNotice, Loading } from '@/components/ui';
import { PageHead } from '@/components/staff-ui';
import { dateTimeOf } from '@/lib/format';

interface Person {
  staff_id: string; full_name: string; email: string; phone: string;
  status: string; roles: string; counter: string; last_login_at: string | null;
}

export default function OperatorStaffPage() {
  const [rows, setRows] = useState<Person[]>([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    sget<{ staff: Person[] }>('/operator/staff')
      .then((r) => setRows(r.staff))
      .catch((e: ApiError) => setError(e.message))
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <Loading rows={2} />;

  return (
    <div className="stack">
      <PageHead title="Staff & roles" sub="Who works here and what each of them may do" />
      {error && <ErrorNotice message={error} />}

      <div className="table-wrap">
        <table className="data">
          <thead>
            <tr><th>Name</th><th>Email</th><th>Roles</th><th>Counter</th><th>Last signed in</th><th>Status</th></tr>
          </thead>
          <tbody>
            {rows.map((p) => (
              <tr key={p.staff_id}>
                <td><strong>{p.full_name}</strong><div className="muted small">{p.phone}</div></td>
                <td className="mono small">{p.email}</td>
                <td>
                  <div className="row" style={{ gap: '.25rem' }}>
                    {p.roles.split(', ').filter(Boolean).map((r) => (
                      <span className="pill" key={r} style={{ fontSize: '.68rem' }}>{r.replace(/_/g, ' ')}</span>
                    ))}
                  </div>
                </td>
                <td className="small muted">{p.counter || '—'}</td>
                <td className="small muted">{p.last_login_at ? dateTimeOf(p.last_login_at) : 'Never'}</td>
                <td>
                  <span className={`pill ${p.status === 'ACTIVE' ? 'pill-ok' : 'pill-danger'}`}>
                    {p.status.toLowerCase()}
                  </span>
                </td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr><td colSpan={6} className="muted center">No staff.</td></tr>
            )}
          </tbody>
        </table>
      </div>

      <p className="small muted">
        Roles are data, not code. A permission is a string of the form
        <code className="mono"> resource.action</code>, and a new role is a row —
        so creating &ldquo;Regional Supervisor&rdquo; with exactly the rights it
        needs does not require a release.
      </p>
    </div>
  );
}
