'use client';

import { useEffect, useState } from 'react';
import { ApiError } from '@/lib/api';
import { sget } from '@/lib/staff';
import { ErrorNotice, Loading } from '@/components/ui';
import { PageHead } from '@/components/staff-ui';
import { dateTimeOf } from '@/lib/format';

interface Person {
  staff_id: string; full_name: string; email: string; status: string;
  roles: string; operator: string; counter: string; agency: string;
  last_login_at: string | null; permission_count: number;
}
interface Role { role_key: string; family: string; permissions: number }

export default function AdminStaffPage() {
  const [staff, setStaff] = useState<Person[]>([]);
  const [roles, setRoles] = useState<Role[]>([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    sget<{ staff: Person[]; roles: Role[] }>('/admin/staff')
      .then((r) => { setStaff(r.staff); setRoles(r.roles); })
      .catch((e: ApiError) => setError(e.message))
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <Loading rows={3} />;
  if (error) return <ErrorNotice message={error} />;

  const families = [...new Set(roles.map((r) => r.family))];

  return (
    <div className="stack">
      <PageHead title="Staff & roles" sub="Who can sign in, and exactly what each role permits" />

      <div className="card card-pad stack-sm">
        <h3 style={{ marginBottom: '.2rem' }}>Roles</h3>
        <p className="small muted" style={{ marginBottom: '.5rem' }}>
          Roles are rows, not code. Adding one with exactly the rights it needs is
          an INSERT — no release, no deploy, no engineer.
        </p>
        {families.map((f) => (
          <div key={f} className="stack-sm">
            <span className="small muted" style={{ textTransform: 'uppercase', letterSpacing: '.06em' }}>{f}</span>
            <div className="row" style={{ gap: '.4rem' }}>
              {roles.filter((r) => r.family === f).map((r) => (
                <span className="pill" key={r.role_key} title={`${r.permissions} permissions`}>
                  {r.role_key.replace(/_/g, ' ').toLowerCase()} · {r.permissions}
                </span>
              ))}
            </div>
          </div>
        ))}
      </div>

      <div className="table-wrap">
        <table className="data">
          <thead>
            <tr>
              <th>Name</th><th>Email</th><th>Roles</th><th className="num">Permissions</th>
              <th>Belongs to</th><th>Last signed in</th><th>Status</th>
            </tr>
          </thead>
          <tbody>
            {staff.map((p) => (
              <tr key={p.staff_id}>
                <td><strong>{p.full_name}</strong></td>
                <td className="mono small">{p.email}</td>
                <td>
                  <div className="row" style={{ gap: '.25rem' }}>
                    {p.roles.split(', ').filter(Boolean).map((r) => (
                      <span className="pill" key={r} style={{ fontSize: '.68rem' }}>{r.replace(/_/g, ' ')}</span>
                    ))}
                  </div>
                </td>
                <td className="num">{p.permission_count}</td>
                <td className="small muted">{p.operator || p.agency || 'Platform'}{p.counter && ` · ${p.counter}`}</td>
                <td className="small muted">{p.last_login_at ? dateTimeOf(p.last_login_at) : 'Never'}</td>
                <td>
                  <span className={`pill ${p.status === 'ACTIVE' ? 'pill-ok' : 'pill-danger'}`}>
                    {p.status.toLowerCase()}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
