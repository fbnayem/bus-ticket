'use client';

import { useEffect, useState } from 'react';
import { ApiError } from '@/lib/api';
import { sget } from '@/lib/staff';
import { ErrorNotice, Loading } from '@/components/ui';
import { PageHead } from '@/components/staff-ui';
import { dateOf } from '@/lib/format';

interface Schedule {
  schedule_id: string; route: string; depart_local: string;
  days: string[]; registration: string;
  valid_from: string; valid_to: string | null; trips_generated: number;
}

export default function SchedulesPage() {
  const [rows, setRows] = useState<Schedule[]>([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    sget<{ schedules: Schedule[] }>('/operator/schedules')
      .then((r) => setRows(r.schedules))
      .catch((e: ApiError) => setError(e.message))
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <Loading rows={2} />;

  return (
    <div className="stack">
      <PageHead title="Schedules" sub="Recurring departures. Trips are generated from these on a rolling horizon." />
      {error && <ErrorNotice message={error} />}

      <div className="table-wrap">
        <table className="data">
          <thead>
            <tr>
              <th>Departs</th><th>Route</th><th>Bus</th><th>Runs on</th>
              <th>Valid</th><th className="num">Trips generated</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((s) => (
              <tr key={s.schedule_id}>
                <td className="mono"><strong>{s.depart_local.slice(0, 5)}</strong></td>
                <td>{s.route}</td>
                <td className="mono small">{s.registration}</td>
                <td>
                  <div className="row" style={{ gap: '.2rem' }}>
                    {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((d) => (
                      <span key={d} className={`pill ${s.days.includes(d) ? 'pill-brand' : ''}`}
                            style={{ fontSize: '.66rem', opacity: s.days.includes(d) ? 1 : .35 }}>
                        {d[0]}
                      </span>
                    ))}
                  </div>
                </td>
                <td className="small muted">
                  {dateOf(s.valid_from)} — {s.valid_to ? dateOf(s.valid_to) : 'open'}
                </td>
                <td className="num">{s.trips_generated}</td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr><td colSpan={6} className="muted center">No schedules configured.</td></tr>
            )}
          </tbody>
        </table>
      </div>

      <p className="small muted">
        Generation is idempotent — re-running it never creates a duplicate trip.
        A trip snapshots its route segments and seat layout the moment it is
        created and is immutable thereafter.
      </p>
    </div>
  );
}
