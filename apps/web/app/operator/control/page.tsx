'use client';

import { useCallback, useEffect, useState } from 'react';
import { ApiError } from '@/lib/api';
import { sget, spost } from '@/lib/staff';
import { useSession } from '@/components/StaffShell';
import { ErrorNotice, Loading } from '@/components/ui';
import { PageHead, TableWrap, Tile } from '@/components/staff-ui';
import { can } from '@/lib/staff';

// The operations control centre.
//
// Six of the seven alert types are about something that did NOT happen — a bus
// that did not depart, a GPS fix that did not arrive, a stop that did not end.
// Absence produces no event, so a scanner runs over live trips every thirty
// seconds and this screen shows what it found.

interface Alert {
  alert_id: string;
  trip_id: string;
  route: string;
  bus: string;
  operator: string;
  kind: string;
  severity: string;
  detail: string;
  raised_at: string;
  cleared_at: string | null;
  acknowledged: boolean;
}

interface Bus {
  trip_id: string;
  operator: string;
  route: string;
  bus: string;
  status: string;
  depart_at: string;
  lat: number | null;
  lng: number | null;
  speed_kph: number | null;
  last_fix: string | null;
  source: string | null;
  open_alerts: number;
  passengers: number;
}

interface Conflict {
  pnr: string;
  old_seat: string;
  new_seat?: string;
  status: string;
  passenger?: string;
}

const KIND_LABEL: Record<string, string> = {
  LATE_DEPARTURE: 'Late departure',
  LONG_STOP: 'Long stop',
  ROUTE_DEVIATION: 'Off route',
  GPS_OFFLINE: 'GPS offline',
  UNEXPECTED_STOP: 'Unexpected stop',
  TRIP_CANCELLATION: 'Trip cancelled',
  BUS_BREAKDOWN: 'Breakdown',
};

export default function ControlCentrePage() {
  const session = useSession();
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [buses, setBuses] = useState<Bus[]>([]);
  const [conflicts, setConflicts] = useState<Record<string, Conflict[]>>({});
  const [error, setError] = useState('');
  const [flash, setFlash] = useState('');
  const [at, setAt] = useState('');

  const manage = can(session?.identity ?? null, 'ops.manage');

  const load = useCallback(() => {
    Promise.all([
      sget<{ alerts: Alert[] }>('/ops/alerts'),
      sget<{ buses: Bus[] }>('/ops/live'),
    ])
      .then(([a, b]) => {
        setAlerts(a.alerts); setBuses(b.buses);
        setAt(new Date().toLocaleTimeString('en-GB'));
      })
      .catch((e: ApiError) => setError(e.message));
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(load, 15000);
    return () => clearInterval(t);
  }, [load]);

  if (error) return <ErrorNotice message={error} onRetry={load} />;
  if (buses.length === 0 && alerts.length === 0 && !at) return <Loading rows={3} />;

  const open = alerts.filter((a) => !a.cleared_at);
  const high = open.filter((a) => a.severity === 'HIGH');
  const tracked = buses.filter((b) => b.last_fix).length;
  const moving = buses.filter((b) => b.status === 'DEPARTED' || b.status === 'IN_PROGRESS');

  return (
    <div className="stack">
      <PageHead
        title="Control centre"
        sub={`Refreshed ${at}`}
        actions={
          <button className="btn btn-ghost btn-sm"
            onClick={async () => { await spost('/ops/scan'); load(); }}>
            Run the detector now
          </button>
        }
      />

      <div className="tiles">
        <Tile k="Trips today" n={buses.length} />
        <Tile k="On the road" n={moving.length} />
        <Tile k="Reporting position" n={`${tracked} / ${buses.length}`} />
        <Tile k="Open alerts" n={open.length} />
        <Tile k="Urgent" n={high.length} hint="needs somebody now" />
      </div>

      {flash && <div className="notice notice-info small">{flash}</div>}

      {open.length === 0 ? (
        <div className="notice notice-info">
          <strong>Nothing needs attention.</strong> No bus is late, dark, stopped
          where it should not be, or off its corridor.
        </div>
      ) : (
        <section className="stack">
          <h2>Alerts</h2>
          <TableWrap>
            <table className="data">
              <thead><tr><th>Kind</th><th>Trip</th><th>Detail</th><th>Since</th><th /></tr></thead>
              <tbody>
                {open.map((a) => (
                  <tr key={a.alert_id}>
                    <td>
                      <span className={`pill ${a.severity === 'HIGH' ? 'pill-danger' : 'pill-warn'}`}>
                        {KIND_LABEL[a.kind] ?? a.kind}
                      </span>
                    </td>
                    <td>
                      <div><strong>{a.route}</strong></div>
                      <div className="small muted">{a.bus} · {a.operator}</div>
                    </td>
                    <td className="small">{a.detail}</td>
                    <td className="small muted">{new Date(a.raised_at).toLocaleTimeString('en-GB')}</td>
                    <td>
                      {a.acknowledged
                        ? <span className="pill pill-ok">Acknowledged</span>
                        : manage && (
                          <button className="btn btn-ghost btn-sm"
                            onClick={async () => { await spost(`/ops/alerts/${a.alert_id}/ack`); load(); }}>
                            Acknowledge
                          </button>
                        )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableWrap>
          {!manage && (
            <p className="muted small">
              Your role can watch the control room but not act on it. Acknowledging
              an alert or putting a replacement bus on the road needs ops.manage.
            </p>
          )}
        </section>
      )}

      <section className="stack">
        <h2>Live buses</h2>
        <TableWrap>
          <table className="data">
            <thead>
              <tr><th>Route</th><th>Bus</th><th>State</th><th>Departs</th>
                <th>Passengers</th><th>Last fix</th><th>Speed</th><th>Alerts</th>
                {manage && <th />}</tr>
            </thead>
            <tbody>
              {buses.map((b) => (
                <tr key={b.trip_id}>
                  <td>{b.route}</td>
                  <td className="mono small">{b.bus}</td>
                  <td><span className="pill">{b.status.toLowerCase().replace('_', ' ')}</span></td>
                  <td className="small muted">{new Date(b.depart_at).toLocaleString('en-GB')}</td>
                  <td className="tnum">{b.passengers}</td>
                  <td className="small muted">
                    {b.last_fix
                      ? `${new Date(b.last_fix).toLocaleTimeString('en-GB')} · ${(b.source ?? '').replace(/_/g, ' ').toLowerCase()}`
                      : 'never'}
                  </td>
                  <td className="tnum">{b.speed_kph !== null ? `${b.speed_kph} km/h` : '—'}</td>
                  <td className="tnum">{b.open_alerts || '—'}</td>
                  {manage && (
                    <td>
                      <button className="btn btn-ghost btn-sm"
                        onClick={async () => {
                          try {
                            const r = await sget<{ conflicts: Conflict[] }>(
                              `/ops/trips/${b.trip_id}/conflicts`);
                            setConflicts({ ...conflicts, [b.trip_id]: r.conflicts });
                            setFlash(r.conflicts.length === 0
                              ? 'No unresolved seat conflicts on that trip.'
                              : `${r.conflicts.length} passenger(s) need a seat.`);
                          } catch (e) { setFlash((e as ApiError).message); }
                        }}>
                        Seat conflicts
                      </button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </TableWrap>
      </section>

      {Object.entries(conflicts).map(([tripID, rows]) => rows.length > 0 && (
        <section className="stack" key={tripID}>
          <h2>Passengers without a seat</h2>
          <p className="muted small">
            A replacement bus with a different seat map leaves these people
            unseated. Nobody is moved automatically — a silent double assignment
            is worse than a list somebody has to work through.
          </p>
          <TableWrap>
            <table className="data">
              <thead><tr><th>PNR</th><th>Passenger</th><th>Was on</th><th>Status</th></tr></thead>
              <tbody>
                {rows.map((c) => (
                  <tr key={c.pnr + c.old_seat}>
                    <td className="mono">{c.pnr}</td>
                    <td>{c.passenger || '—'}</td>
                    <td className="mono">{c.old_seat}</td>
                    <td><span className="pill pill-danger">{c.status.toLowerCase()}</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableWrap>
        </section>
      ))}
    </div>
  );
}
