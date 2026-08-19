'use client';

import { useState } from 'react';
import { ApiError } from '@/lib/api';
import { spost } from '@/lib/staff';
import { isoDate } from '@/lib/format';

export interface RouteOpt { route_id: string; name: string }
export interface BusOpt { bus_id: string; registration: string }

// Days run Monday-first because that is how the schedule bitmask is numbered
// (bit 0 = Monday) — the checkbox index is the bit it sets.
const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

function Sheet({ title, children, onClose, busy }: {
  title: string; children: React.ReactNode; onClose: () => void; busy: boolean;
}) {
  return (
    <div className="sheet-backdrop" onClick={() => !busy && onClose()}>
      <div className="sheet" role="dialog" aria-modal="true" aria-label={title}
           onClick={(e) => e.stopPropagation()}>
        <div className="sheet-grip" />
        <div className="stack" style={{ gap: '.9rem', padding: '0 .25rem' }}>
          <h2 style={{ margin: 0 }}>{title}</h2>
          {children}
        </div>
      </div>
    </div>
  );
}

export function ScheduleBuilder({ routes, buses, onSaved, onClose }: {
  routes: RouteOpt[]; buses: BusOpt[]; onSaved: (trips: number) => void; onClose: () => void;
}) {
  const [routeId, setRouteId] = useState(routes[0]?.route_id ?? '');
  const [busId, setBusId] = useState(buses[0]?.bus_id ?? '');
  const [time, setTime] = useState('22:00');
  const [days, setDays] = useState<boolean[]>([true, true, true, true, true, true, true]);
  const [from, setFrom] = useState(isoDate(new Date()));
  const [to, setTo] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const mask = days.reduce((m, on, i) => (on ? m | (1 << i) : m), 0);

  async function save() {
    if (!routeId) { setError('Choose a route.'); return; }
    if (!busId) { setError('Choose a bus.'); return; }
    if (mask === 0) { setError('Choose at least one day.'); return; }
    setBusy(true); setError('');
    try {
      const r = await spost<{ trips_generated: number }>('/operator/schedules', {
        route_id: routeId, bus_id: busId, depart_local: time,
        days_mask: mask, valid_from: from, valid_to: to || undefined,
      });
      onSaved(r.trips_generated);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'The schedule could not be saved.');
    } finally { setBusy(false); }
  }

  return (
    <Sheet title="New schedule" onClose={onClose} busy={busy}>
      <label className="stack" style={{ gap: '.25rem' }}>
        <span className="small muted">Route</span>
        <select className="select" value={routeId} onChange={(e) => setRouteId(e.target.value)}>
          {routes.map((r) => <option key={r.route_id} value={r.route_id}>{r.name}</option>)}
        </select>
      </label>
      <label className="stack" style={{ gap: '.25rem' }}>
        <span className="small muted">Bus</span>
        <select className="select" value={busId} onChange={(e) => setBusId(e.target.value)}>
          {buses.map((b) => <option key={b.bus_id} value={b.bus_id}>{b.registration}</option>)}
        </select>
      </label>
      <div className="row" style={{ gap: '.6rem', flexWrap: 'wrap' }}>
        <label className="stack" style={{ gap: '.25rem', width: 130 }}>
          <span className="small muted">Departs (local)</span>
          <input className="input" type="time" value={time} onChange={(e) => setTime(e.target.value)} />
        </label>
        <label className="stack" style={{ gap: '.25rem', flex: 1 }}>
          <span className="small muted">From</span>
          <input className="input" type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
        </label>
        <label className="stack" style={{ gap: '.25rem', flex: 1 }}>
          <span className="small muted">Until (optional)</span>
          <input className="input" type="date" value={to} onChange={(e) => setTo(e.target.value)} />
        </label>
      </div>
      <div className="stack" style={{ gap: '.3rem' }}>
        <span className="small muted">Runs on</span>
        <div className="row" style={{ gap: '.3rem', flexWrap: 'wrap' }}>
          {DAYS.map((d, i) => (
            <button key={d} type="button" className={`btn btn-sm ${days[i] ? 'btn-brand' : 'btn-ghost'}`}
                    onClick={() => setDays(days.map((v, j) => (j === i ? !v : v)))}>{d}</button>
          ))}
        </div>
      </div>
      {error && <p className="small" style={{ color: 'var(--danger, #b3261e)' }}>{error}</p>}
      <div className="row" style={{ gap: '.5rem', justifyContent: 'flex-end' }}>
        <button className="btn btn-ghost" disabled={busy} onClick={onClose}>Cancel</button>
        <button className="btn btn-brand" disabled={busy} onClick={save}>
          {busy ? 'Saving…' : 'Save & generate trips'}
        </button>
      </div>
    </Sheet>
  );
}

export function OneOffTripForm({ routes, buses, onSaved, onClose }: {
  routes: RouteOpt[]; buses: BusOpt[]; onSaved: (seats: number) => void; onClose: () => void;
}) {
  const [routeId, setRouteId] = useState(routes[0]?.route_id ?? '');
  const [busId, setBusId] = useState(buses[0]?.bus_id ?? '');
  const [date, setDate] = useState(isoDate(new Date()));
  const [time, setTime] = useState('22:00');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function save() {
    if (!routeId || !busId) { setError('Choose a route and a bus.'); return; }
    setBusy(true); setError('');
    try {
      const r = await spost<{ seats: number }>('/operator/trips', {
        route_id: routeId, bus_id: busId, date, depart_local: time,
      });
      onSaved(r.seats);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'The trip could not be created.');
    } finally { setBusy(false); }
  }

  return (
    <Sheet title="Add a one-off trip" onClose={onClose} busy={busy}>
      <p className="small muted" style={{ margin: 0 }}>
        A single extra departure with no schedule behind it — the Eid relief bus,
        a charter, a bus laid on when a route sells out.
      </p>
      <label className="stack" style={{ gap: '.25rem' }}>
        <span className="small muted">Route</span>
        <select className="select" value={routeId} onChange={(e) => setRouteId(e.target.value)}>
          {routes.map((r) => <option key={r.route_id} value={r.route_id}>{r.name}</option>)}
        </select>
      </label>
      <label className="stack" style={{ gap: '.25rem' }}>
        <span className="small muted">Bus</span>
        <select className="select" value={busId} onChange={(e) => setBusId(e.target.value)}>
          {buses.map((b) => <option key={b.bus_id} value={b.bus_id}>{b.registration}</option>)}
        </select>
      </label>
      <div className="row" style={{ gap: '.6rem' }}>
        <label className="stack" style={{ gap: '.25rem', flex: 1 }}>
          <span className="small muted">Date</span>
          <input className="input" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        </label>
        <label className="stack" style={{ gap: '.25rem', width: 130 }}>
          <span className="small muted">Departs</span>
          <input className="input" type="time" value={time} onChange={(e) => setTime(e.target.value)} />
        </label>
      </div>
      {error && <p className="small" style={{ color: 'var(--danger, #b3261e)' }}>{error}</p>}
      <div className="row" style={{ gap: '.5rem', justifyContent: 'flex-end' }}>
        <button className="btn btn-ghost" disabled={busy} onClick={onClose}>Cancel</button>
        <button className="btn btn-brand" disabled={busy} onClick={save}>
          {busy ? 'Creating…' : 'Create trip'}
        </button>
      </div>
    </Sheet>
  );
}
