'use client';

import { useCallback, useEffect, useState } from 'react';
import { ApiError } from '@/lib/api';
import { sget, spost, staffCall, can } from '@/lib/staff';
import { useSession } from '@/components/StaffShell';
import { ErrorNotice, Loading } from '@/components/ui';
import { PageHead, Money } from '@/components/staff-ui';
import RouteBuilder from '@/components/RouteBuilder';

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
  const [building, setBuilding] = useState(false);
  const [timesFor, setTimesFor] = useState<Route | null>(null);

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
  const mayEditRoutes = can(session?.identity ?? null, 'route.write');

  if (loading) return <Loading rows={2} />;

  return (
    <div className="stack">
      <PageHead title="Routes & fares" sub="A fare is published per leg, and every leg can be sold separately"
        actions={mayEditRoutes && (
          <button className="btn btn-brand" onClick={() => setBuilding(true)}>New route</button>
        )} />
      {error && <ErrorNotice message={error} />}
      {flash && <div className="notice notice-info">{flash}</div>}

      <div className="table-wrap">
        <table className="data">
          <thead><tr><th>Route</th><th>Stops</th><th className="num">Legs priced</th>{mayEditRoutes && <th />}</tr></thead>
          <tbody>
            {routes.map((r) => (
              <tr key={r.route_id}>
                <td><strong>{r.name}</strong></td>
                <td>{r.path}</td>
                <td className="num">{r.fare_count}</td>
                {mayEditRoutes && (
                  <td><button className="btn btn-sm btn-ghost" onClick={() => setTimesFor(r)}>Times &amp; coverage</button></td>
                )}
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

      {building && (
        <RouteBuilder onClose={() => setBuilding(false)}
                      onSaved={() => { setBuilding(false); setFlash('Route created. Publish a fare for each leg you want to sell.'); load(); }} />
      )}

      {timesFor && (
        <RouteTimesSheet route={timesFor}
                         onClose={() => setTimesFor(null)}
                         onSaved={() => { setTimesFor(null); setFlash('Leg times saved. Arrival times will show at each stop.'); }} />
      )}
    </div>
  );
}

interface DetailStop {
  stop_seq: number; name: string; is_boarding: boolean; is_dropping: boolean; minutes_to_next: number | null;
}
interface RouteDetail {
  route_id: string; name: string; editable: boolean;
  stops: DetailStop[]; fare_pairs: number; fully_priced: boolean;
}

// The leg-times editor, doubling as the price-coverage view (#19): an operator
// sees whether the end-to-end journey is priced before it silently drops out of
// search, and sets how long each leg takes so a passenger sees an arrival time
// at every stop, not just a departure.
function RouteTimesSheet({ route, onClose, onSaved }: { route: Route; onClose: () => void; onSaved: () => void }) {
  const [detail, setDetail] = useState<RouteDetail | null>(null);
  const [mins, setMins] = useState<string[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    sget<RouteDetail>(`/operator/routes/${route.route_id}`)
      .then((d) => {
        setDetail(d);
        setMins(d.stops.map((s) => (s.minutes_to_next != null ? String(s.minutes_to_next) : '')));
      })
      .catch((e: ApiError) => setError(e.message));
  }, [route.route_id]);

  async function save() {
    if (!detail) return;
    const segments: { from_stop_seq: number; minutes: number }[] = [];
    for (let i = 0; i < detail.stops.length - 1; i++) {
      const v = mins[i];
      if (v === '' || v == null) continue; // an unset leg is left as-is
      const n = Math.round(Number(v));
      if (!Number.isFinite(n) || n <= 0) { setError(`Leg ${i + 1} needs a time above zero.`); return; }
      segments.push({ from_stop_seq: detail.stops[i].stop_seq, minutes: n });
    }
    if (segments.length === 0) { setError('Set at least one leg time.'); return; }
    setBusy(true); setError('');
    try {
      await staffCall(`/operator/routes/${route.route_id}/segments`, { method: 'PUT', body: { segments } });
      onSaved();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'The times could not be saved.');
    } finally { setBusy(false); }
  }

  return (
    <div className="sheet-backdrop" onClick={() => !busy && onClose()}>
      <div className="sheet" role="dialog" aria-modal="true" aria-label={`Times for ${route.name}`}
           style={{ maxWidth: 480 }} onClick={(e) => e.stopPropagation()}>
        <div className="sheet-grip" />
        <div className="stack" style={{ gap: '.9rem', padding: '0 .25rem' }}>
          <h2 style={{ margin: 0 }}>{route.name}</h2>
          {!detail && !error && <p className="small muted">Loading…</p>}
          {detail && (
            <>
              <div className="row" style={{ gap: '.5rem', flexWrap: 'wrap' }}>
                <span className={`pill ${detail.fully_priced ? 'pill-ok' : 'pill-danger'}`}>
                  {detail.fully_priced ? 'End-to-end priced' : 'End-to-end fare missing'}
                </span>
                <span className="pill">{detail.fare_pairs} priced leg{detail.fare_pairs === 1 ? '' : 's'}</span>
              </div>
              {!detail.fully_priced && (
                <p className="small muted" style={{ margin: 0 }}>
                  Until the full first-to-last fare is published, this route will not
                  appear in search. Publish it below the routes table.
                </p>
              )}
              <div className="stack" style={{ gap: '.4rem' }}>
                <span className="small muted">Minutes for each leg</span>
                {detail.stops.map((s, i) => (
                  i < detail.stops.length - 1 && (
                    <div key={s.stop_seq} className="row" style={{ gap: '.5rem', alignItems: 'center' }}>
                      <span className="small" style={{ flex: '1 1 auto' }}>
                        {s.name} <span className="muted">→</span> {detail.stops[i + 1].name}
                      </span>
                      <input className="input tnum" type="number" min={1} step={5} value={mins[i]}
                             placeholder="—" style={{ width: 90 }}
                             onChange={(e) => setMins((prev) => prev.map((v, j) => (j === i ? e.target.value : v)))} />
                      <span className="small muted">min</span>
                    </div>
                  )
                ))}
              </div>
              {error && <p className="small" style={{ color: 'var(--danger, #b3261e)' }}>{error}</p>}
              <div className="row" style={{ gap: '.5rem', justifyContent: 'flex-end' }}>
                <button className="btn btn-ghost" disabled={busy} onClick={onClose}>Close</button>
                <button className="btn btn-brand" disabled={busy} onClick={save}>
                  {busy ? 'Saving…' : 'Save times'}
                </button>
              </div>
            </>
          )}
          {error && !detail && <p className="small" style={{ color: 'var(--danger, #b3261e)' }}>{error}</p>}
        </div>
      </div>
    </div>
  );
}
