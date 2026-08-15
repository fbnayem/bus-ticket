'use client';

import { useCallback, useEffect, useState } from 'react';
import { ApiError } from '@/lib/api';
import { sget, spost, can } from '@/lib/staff';
import { useSession } from '@/components/StaffShell';
import { ErrorNotice, Loading } from '@/components/ui';
import { PageHead, Money } from '@/components/staff-ui';

// Routes and per-leg fares.
//
// Publishing a fare never edits the existing row — it writes a new version and
// supersedes the old one. Every booking holds a price snapshot frozen at hold
// time, so editing a fare in place would quietly rewrite what a passenger
// agreed to pay months ago.

interface Route { route_id: string; name: string; path: string; stop_count: number; fare_count: number }
interface Fare {
  fare_id: string; route: string; from_stop_seq: number; to_stop_seq: number;
  from: string; to: string; fare_class: string; amount_poisha: number; version: number;
}

export default function RoutesPage() {
  const session = useSession();
  const [routes, setRoutes] = useState<Route[]>([]);
  const [fares, setFares] = useState<Fare[]>([]);
  const [editing, setEditing] = useState<Fare | null>(null);
  const [value, setValue] = useState('');
  const [error, setError] = useState('');
  const [flash, setFlash] = useState('');
  const [loading, setLoading] = useState(true);

  const load = useCallback(() => {
    Promise.all([
      sget<{ routes: Route[] }>('/operator/routes'),
      sget<{ fares: Fare[] }>('/operator/fares'),
    ])
      .then(([r, f]) => { setRoutes(r.routes); setFares(f.fares); })
      .catch((e: ApiError) => setError(e.message))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { load(); }, [load]);

  const publish = async () => {
    if (!editing) return;
    setError('');
    try {
      const routeId = routes.find((r) => r.name === editing.route)?.route_id;
      const res = await spost<{ version: number }>('/operator/fares', {
        route_id: routeId,
        from_stop_seq: editing.from_stop_seq,
        to_stop_seq: editing.to_stop_seq,
        fare_class: editing.fare_class,
        amount_poisha: Math.round(Number(value) * 100),
      });
      setFlash(`Published as version ${res.version}. Bookings already made keep the price they were sold at.`);
      setEditing(null);
      load();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'The fare could not be published.');
    }
  };

  const mayEdit = can(session?.identity ?? null, 'fare.write');

  if (loading) return <Loading rows={2} />;

  return (
    <div className="stack">
      <PageHead title="Routes & fares" sub="A fare is published per leg, and every leg can be sold separately" />
      {error && <ErrorNotice message={error} />}
      {flash && <div className="notice notice-info">{flash}</div>}

      <div className="table-wrap">
        <table className="data">
          <thead><tr><th>Route</th><th>Stops</th><th className="num">Legs priced</th></tr></thead>
          <tbody>
            {routes.map((r) => (
              <tr key={r.route_id}>
                <td><strong>{r.name}</strong></td>
                <td>{r.path}</td>
                <td className="num">{r.fare_count}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div>
        <h3 style={{ marginBottom: '.5rem' }}>Published fares</h3>
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>Route</th><th>Leg</th><th>Class</th>
                <th className="num">Fare</th><th className="num">Version</th>{mayEdit && <th />}
              </tr>
            </thead>
            <tbody>
              {fares.map((f) => (
                <tr key={f.fare_id}>
                  <td className="small">{f.route}</td>
                  <td>{f.from} → {f.to}</td>
                  <td className="muted small">{f.fare_class}</td>
                  <td className="num"><Money poisha={f.amount_poisha} /></td>
                  <td className="num muted">v{f.version}</td>
                  {mayEdit && (
                    <td>
                      <button className="btn btn-sm btn-ghost"
                              onClick={() => { setEditing(f); setValue(String(f.amount_poisha / 100)); }}>
                        Change
                      </button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {editing && (
        <div className="card card-pad stack" style={{ maxWidth: 420 }}>
          <h3>Publish a new fare</h3>
          <p className="small muted" style={{ marginBottom: 0 }}>
            {editing.route} · {editing.from} → {editing.to} · {editing.fare_class}
          </p>
          <div className="field">
            <label className="label" htmlFor="fare">New fare (৳)</label>
            <input id="fare" className="input tnum" type="number" min="1" step="1"
                   value={value} onChange={(e) => setValue(e.target.value)} />
          </div>
          <div className="row">
            <button className="btn btn-primary" onClick={publish}>Publish version {editing.version + 1}</button>
            <button className="btn btn-ghost" onClick={() => setEditing(null)}>Cancel</button>
          </div>
          <p className="small muted" style={{ marginBottom: 0 }}>
            Takes effect for new bookings only. Existing bookings and live seat
            holds keep the price they were quoted.
          </p>
        </div>
      )}
    </div>
  );
}
