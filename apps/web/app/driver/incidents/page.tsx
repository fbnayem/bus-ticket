'use client';

import { useCallback, useEffect, useState } from 'react';
import { ApiError } from '@/lib/api';
import { sget, spost } from '@/lib/staff';
import { ErrorNotice, Loading } from '@/components/ui';
import { PageHead } from '@/components/staff-ui';
import { dateTimeOf, timeOf } from '@/lib/format';

interface Trip { trip_id: string; depart_at: string; route: string }
interface Incident {
  incident_id: string; trip_id: string; kind: string; severity: string;
  note: string; created_at: string; reported_by: string; route: string; depart_at: string;
}

const KINDS = [
  ['BREAKDOWN', 'Breakdown'],
  ['ACCIDENT', 'Accident'],
  ['ROUTE_INTERRUPTION', 'Road blocked'],
  ['DELAY', 'Running late'],
  ['PASSENGER_ISSUE', 'Passenger issue'],
  ['OTHER', 'Something else'],
];

export default function IncidentsPage() {
  const [trips, setTrips] = useState<Trip[]>([]);
  const [rows, setRows] = useState<Incident[]>([]);
  const [tripId, setTripId] = useState('');
  const [kind, setKind] = useState('DELAY');
  const [severity, setSeverity] = useState('LOW');
  const [note, setNote] = useState('');
  const [error, setError] = useState('');
  const [flash, setFlash] = useState('');
  const [loading, setLoading] = useState(true);

  const load = useCallback(() => {
    Promise.all([
      sget<{ trips: Trip[] }>('/driver/trips'),
      sget<{ incidents: Incident[] }>('/driver/incidents'),
    ])
      .then(([t, i]) => {
        setTrips(t.trips);
        setRows(i.incidents);
        if (!tripId && t.trips[0]) setTripId(t.trips[0].trip_id);
      })
      .catch((e: ApiError) => setError(e.message))
      .finally(() => setLoading(false));
  }, [tripId]);

  useEffect(() => { load(); }, [load]);

  const report = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    try {
      await spost('/driver/incidents', { trip_id: tripId, kind, severity, note });
      setFlash('Reported. The office can see this now.');
      setNote('');
      load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'The report could not be saved.');
    }
  };

  if (loading) return <Loading rows={2} />;

  return (
    <div className="stack">
      <PageHead title="Incidents" sub="Tell the office what happened, in your own words" />
      {error && <ErrorNotice message={error} />}
      {flash && <div className="notice notice-info">{flash}</div>}

      <form className="card card-pad stack" style={{ maxWidth: 520 }} onSubmit={report}>
        <div className="field">
          <label className="label" htmlFor="i-trip">Which trip</label>
          <select id="i-trip" className="select" value={tripId} onChange={(e) => setTripId(e.target.value)}>
            {trips.map((t) => (
              <option key={t.trip_id} value={t.trip_id}>{timeOf(t.depart_at)} · {t.route}</option>
            ))}
          </select>
        </div>
        <div className="row" style={{ gap: '.6rem' }}>
          <div className="field" style={{ flex: 1 }}>
            <label className="label" htmlFor="i-kind">What happened</label>
            <select id="i-kind" className="select" value={kind} onChange={(e) => setKind(e.target.value)}>
              {KINDS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
          </div>
          <div className="field" style={{ flex: '0 1 140px' }}>
            <label className="label" htmlFor="i-sev">How serious</label>
            <select id="i-sev" className="select" value={severity} onChange={(e) => setSeverity(e.target.value)}>
              <option value="LOW">Minor</option>
              <option value="MEDIUM">Needs attention</option>
              <option value="HIGH">Urgent</option>
            </select>
          </div>
        </div>
        <div className="field">
          <label className="label" htmlFor="i-note">Details</label>
          <input id="i-note" className="input" value={note} onChange={(e) => setNote(e.target.value)}
                 placeholder="Held 20 minutes at the Meghna bridge" required />
        </div>
        <button className="btn btn-primary btn-block" type="submit" disabled={!note}>Report</button>
      </form>

      <div>
        <h3 style={{ marginBottom: '.5rem' }}>Reported</h3>
        <div className="table-wrap">
          <table className="data">
            <thead><tr><th>When</th><th>Trip</th><th>Type</th><th>Severity</th><th>Details</th><th>By</th></tr></thead>
            <tbody>
              {rows.map((i) => (
                <tr key={i.incident_id}>
                  <td className="small muted">{dateTimeOf(i.created_at)}</td>
                  <td className="small">{i.route}<div className="muted">{timeOf(i.depart_at)}</div></td>
                  <td>{KINDS.find(([v]) => v === i.kind)?.[1] ?? i.kind}</td>
                  <td>
                    <span className={`pill ${i.severity === 'HIGH' ? 'pill-danger' : i.severity === 'MEDIUM' ? 'pill-warn' : ''}`}>
                      {i.severity.toLowerCase()}
                    </span>
                  </td>
                  <td>{i.note}</td>
                  <td className="small muted">{i.reported_by}</td>
                </tr>
              ))}
              {rows.length === 0 && (
                <tr><td colSpan={6} className="muted center">Nothing reported.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      <p className="small muted">
        Reporting an incident records it and raises it: the control room and the
        operator both get a message, and a breakdown opens an alert in the
        operations console. Nobody has to be watching this screen for it to be
        seen.
      </p>
    </div>
  );
}
