'use client';

import { useCallback, useEffect, useState } from 'react';
import { ApiError } from '@/lib/api';
import { sget, spost } from '@/lib/staff';
import { ErrorNotice, Loading } from '@/components/ui';
import { PageHead } from '@/components/staff-ui';
import { useLang } from '@/components/LangProvider';
import { STRINGS, errorText, type Key } from '@/lib/i18n';
interface Trip { trip_id: string; depart_at: string; route: string }
interface Incident {
  incident_id: string; trip_id: string; kind: string; severity: string;
  note: string; created_at: string; reported_by: string; route: string; depart_at: string;
}

// The order is the order a driver would think of them in — the worst first,
// not alphabetical and not the order the enum happens to be declared in.
const KINDS = ['BREAKDOWN', 'ACCIDENT', 'ROUTE_INTERRUPTION', 'DELAY', 'PASSENGER_ISSUE', 'OTHER'];
const SEVERITIES = ['LOW', 'MEDIUM', 'HIGH'];

export default function IncidentsPage() {
  const { t, fmt } = useLang();
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
      .then(([tr, i]) => {
        setTrips(tr.trips);
        setRows(i.incidents);
        if (!tripId && tr.trips[0]) setTripId(tr.trips[0].trip_id);
      })
      .catch((e: ApiError) => setError(errorText(t, e)))
      .finally(() => setLoading(false));
  }, [tripId]);

  useEffect(() => { load(); }, [load]);

  const report = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    try {
      await spost('/driver/incidents', { trip_id: tripId, kind, severity, note });
      setFlash(t('dr.in.sent'));
      setNote('');
      load();
    } catch (err) {
      setError(errorText(t, err, 'dr.in.fail'));
    }
  };

  // Server-side enums, translated where a word exists and shown raw where it
  // does not. A new incident kind added to the backend appears here as itself
  // rather than as an empty cell.
  const say = (k: string, fallback: string) =>
    (k as Key) in STRINGS ? t(k as Key) : fallback;

  if (loading) return <Loading rows={2} />;

  return (
    <div className="stack">
      <PageHead title={t('dr.problem')} sub={t('dr.in.sub')} />
      {error && <ErrorNotice message={error} />}
      {flash && <div className="notice notice-info">{flash}</div>}

      <form className="card card-pad stack" style={{ maxWidth: 520 }} onSubmit={report}>
        <div className="field">
          <label className="label" htmlFor="i-trip">{t('dr.in.which')}</label>
          <select id="i-trip" className="select" value={tripId} onChange={(e) => setTripId(e.target.value)}>
            {trips.map((tr) => (
              <option key={tr.trip_id} value={tr.trip_id}>{fmt.time(tr.depart_at)} · {tr.route}</option>
            ))}
          </select>
        </div>
        <div className="row" style={{ gap: '.6rem' }}>
          <div className="field" style={{ flex: 1 }}>
            <label className="label" htmlFor="i-kind">{t('dr.in.what')}</label>
            <select id="i-kind" className="select" value={kind} onChange={(e) => setKind(e.target.value)}>
              {KINDS.map((k) => <option key={k} value={k}>{say(`dr.kind.${k}`, k)}</option>)}
            </select>
          </div>
          <div className="field" style={{ flex: '0 1 160px' }}>
            <label className="label" htmlFor="i-sev">{t('dr.in.serious')}</label>
            <select id="i-sev" className="select" value={severity} onChange={(e) => setSeverity(e.target.value)}>
              {SEVERITIES.map((s) => <option key={s} value={s}>{say(`dr.sev.${s}`, s)}</option>)}
            </select>
          </div>
        </div>
        <div className="field">
          <label className="label" htmlFor="i-note">{t('dr.in.details')}</label>
          <input id="i-note" className="input" value={note} onChange={(e) => setNote(e.target.value)}
                 placeholder={t('dr.in.placeholder')} required />
        </div>
        <button className="btn btn-primary btn-block btn-lg" type="submit"
                disabled={!note} data-act="report-incident">
          {t('dr.send')}
        </button>
      </form>

      <div>
        <h3 style={{ marginBottom: '.5rem' }}>{t('dr.in.listTitle')}</h3>
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>{t('ag.when')}</th><th>{t('dr.scanTrip')}</th>
                <th>{t('dr.in.what')}</th><th>{t('dr.in.serious')}</th>
                <th>{t('dr.in.details')}</th><th>{t('dr.in.by')}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((i) => (
                <tr key={i.incident_id}>
                  <td className="small muted">{fmt.dateTime(i.created_at)}</td>
                  <td className="small">{i.route}<div className="muted">{fmt.time(i.depart_at)}</div></td>
                  <td>{say(`dr.kind.${i.kind}`, i.kind)}</td>
                  <td>
                    <span className={`pill ${i.severity === 'HIGH' ? 'pill-danger' : i.severity === 'MEDIUM' ? 'pill-warn' : ''}`}>
                      {say(`dr.sev.${i.severity}`, i.severity.toLowerCase())}
                    </span>
                  </td>
                  <td>{i.note}</td>
                  <td className="small muted">{i.reported_by}</td>
                </tr>
              ))}
              {rows.length === 0 && (
                <tr><td colSpan={6} className="muted center">{t('dr.in.empty')}</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      <p className="small muted">{t('dr.in.foot')}</p>
    </div>
  );
}
