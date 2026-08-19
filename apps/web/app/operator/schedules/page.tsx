'use client';

import { useCallback, useEffect, useState } from 'react';
import { ApiError } from '@/lib/api';
import { sget, spost, staffCall, can } from '@/lib/staff';
import { useSession } from '@/components/StaffShell';
import { ErrorNotice, Loading } from '@/components/ui';
import { PageHead } from '@/components/staff-ui';
import { dateOf } from '@/lib/format';
import { ScheduleBuilder, OneOffTripForm, RouteOpt, BusOpt } from '@/components/ScheduleForms';

interface Schedule {
  schedule_id: string; route: string; depart_local: string;
  days: string[]; registration: string;
  valid_from: string; valid_to: string | null; trips_generated: number;
}

const DAY_ORDER = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

export default function SchedulesPage() {
  const session = useSession();
  const [rows, setRows] = useState<Schedule[]>([]);
  const [routes, setRoutes] = useState<RouteOpt[]>([]);
  const [buses, setBuses] = useState<BusOpt[]>([]);
  const [error, setError] = useState('');
  const [flash, setFlash] = useState('');
  const [loading, setLoading] = useState(true);
  const [mode, setMode] = useState<'' | 'schedule' | 'oneoff'>('');

  const mayWrite = can(session?.identity ?? null, 'schedule.write');

  const load = useCallback(() => {
    Promise.all([
      sget<{ schedules: Schedule[] }>('/operator/schedules'),
      sget<{ routes: RouteOpt[] }>('/operator/routes'),
      sget<{ buses: BusOpt[] }>('/operator/buses'),
    ])
      .then(([s, r, b]) => { setRows(s.schedules); setRoutes(r.routes); setBuses(b.buses); })
      .catch((e: ApiError) => setError(e.message))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { load(); }, [load]);

  const endSchedule = async (s: Schedule) => {
    setError('');
    try {
      await spost(`/operator/schedules/${s.schedule_id}/end`, {});
      setFlash('Schedule ended. Trips already on the board keep running; no new ones are generated.');
      load();
    } catch (e) { setError(e instanceof ApiError ? e.message : 'Could not end the schedule.'); }
  };

  const deleteSchedule = async (s: Schedule) => {
    setError('');
    try {
      await staffCall(`/operator/schedules/${s.schedule_id}`, { method: 'DELETE' });
      setFlash('Schedule deleted.');
      load();
    } catch (e) { setError(e instanceof ApiError ? e.message : 'Could not delete the schedule.'); }
  };

  if (loading) return <Loading rows={2} />;

  const canBuild = routes.length > 0 && buses.length > 0;

  return (
    <div className="stack">
      <PageHead title="Schedules" sub="Recurring departures. Trips are generated from these on a rolling horizon."
        actions={mayWrite && (
          <div className="row" style={{ gap: '.4rem' }}>
            <button className="btn btn-ghost" disabled={!canBuild} onClick={() => setMode('oneoff')}>One-off trip</button>
            <button className="btn btn-brand" disabled={!canBuild} onClick={() => setMode('schedule')}>New schedule</button>
          </div>
        )} />
      {error && <ErrorNotice message={error} />}
      {flash && <div className="notice notice-info">{flash}</div>}
      {mayWrite && !canBuild && (
        <p className="small muted">You need at least one route and one bus before you can schedule departures.</p>
      )}

      <div className="table-wrap">
        <table className="data">
          <thead>
            <tr>
              <th>Departs</th><th>Route</th><th>Bus</th><th>Runs on</th>
              <th>Valid</th><th className="num">Trips</th>{mayWrite && <th />}
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
                    {DAY_ORDER.map((d) => (
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
                {mayWrite && (
                  <td>
                    <div className="row" style={{ gap: '.3rem' }}>
                      {s.trips_generated > 0
                        ? <button className="btn btn-sm btn-ghost" onClick={() => endSchedule(s)}>End</button>
                        : <button className="btn btn-sm btn-ghost" onClick={() => deleteSchedule(s)}>Delete</button>}
                    </div>
                  </td>
                )}
              </tr>
            ))}
            {rows.length === 0 && (
              <tr><td colSpan={mayWrite ? 7 : 6} className="muted center">No schedules configured.</td></tr>
            )}
          </tbody>
        </table>
      </div>

      <p className="small muted">
        Generation is idempotent — re-running it never creates a duplicate trip.
        A trip snapshots its route segments and seat layout the moment it is
        created and is immutable thereafter.
      </p>

      {mode === 'schedule' && (
        <ScheduleBuilder routes={routes} buses={buses} onClose={() => setMode('')}
          onSaved={(n) => { setMode(''); setFlash(`Schedule saved — ${n} trip${n === 1 ? '' : 's'} generated over the horizon.`); load(); }} />
      )}
      {mode === 'oneoff' && (
        <OneOffTripForm routes={routes} buses={buses} onClose={() => setMode('')}
          onSaved={(seats) => { setMode(''); setFlash(`One-off trip created with ${seats} seats.`); load(); }} />
      )}
    </div>
  );
}
