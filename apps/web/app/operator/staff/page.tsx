'use client';

import { useCallback, useEffect, useState } from 'react';
import { ApiError } from '@/lib/api';
import { sget, can } from '@/lib/staff';
import { useSession } from '@/components/StaffShell';
import { ErrorNotice, Loading } from '@/components/ui';
import { PageHead } from '@/components/staff-ui';
import { dateTimeOf } from '@/lib/format';
import StaffForm, { RoleOpt, Person } from '@/components/StaffForm';

interface Row extends Person {
  counter: string; last_login_at: string | null;
}

export default function OperatorStaffPage() {
  const session = useSession();
  const [rows, setRows] = useState<Row[]>([]);
  const [roles, setRoles] = useState<RoleOpt[]>([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<Row | null>(null);

  const mayWrite = can(session?.identity ?? null, 'staff.write');

  const load = useCallback(() => {
    Promise.all([
      sget<{ staff: Row[] }>('/operator/staff'),
      mayWrite ? sget<{ roles: RoleOpt[] }>('/operator/roles') : Promise.resolve({ roles: [] }),
    ])
      .then(([s, r]) => { setRows(s.staff); setRoles(r.roles); })
      .catch((e: ApiError) => setError(e.message))
      .finally(() => setLoading(false));
  }, [mayWrite]);

  useEffect(() => { load(); }, [load]);

  if (loading) return <Loading rows={2} />;

  return (
    <div className="stack">
      <PageHead title="Staff & roles" sub="Who works here and what each of them may do"
        actions={mayWrite && <button className="btn btn-brand" onClick={() => setCreating(true)}>New staff</button>} />
      {error && <ErrorNotice message={error} />}

      <div className="table-wrap">
        <table className="data">
          <thead>
            <tr><th>Name</th><th>Email</th><th>Roles</th><th>Counter</th><th>Last signed in</th><th>Status</th>{mayWrite && <th />}</tr>
          </thead>
          <tbody>
            {rows.map((p) => (
              <tr key={p.staff_id}>
                <td><strong>{p.full_name}</strong><div className="muted small">{p.phone}</div></td>
                <td className="mono small">{p.email}</td>
                <td>
                  <div className="row" style={{ gap: '.25rem', flexWrap: 'wrap' }}>
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
                {mayWrite && (
                  <td><button className="btn btn-sm btn-ghost" onClick={() => setEditing(p)}>Edit</button></td>
                )}
              </tr>
            ))}
            {rows.length === 0 && (
              <tr><td colSpan={mayWrite ? 7 : 6} className="muted center">No staff.</td></tr>
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

      {creating && (
        <StaffForm roles={roles} onClose={() => setCreating(false)}
                   onSaved={() => { setCreating(false); load(); }} />
      )}
      {editing && (
        <StaffForm roles={roles} person={editing} onClose={() => setEditing(null)}
                   onSaved={() => { setEditing(null); load(); }} />
      )}
    </div>
  );
}
