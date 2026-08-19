'use client';

import { useCallback, useEffect, useState } from 'react';
import { ApiError } from '@/lib/api';
import { sget, spost, can } from '@/lib/staff';
import { useSession } from '@/components/StaffShell';
import { ErrorNotice, Loading } from '@/components/ui';
import { PageHead, Bar } from '@/components/staff-ui';
import { isoDate, timeOf, channelLabel } from '@/lib/format';
import CrewRoster from '@/components/CrewRoster';

interface Trip {
  trip_id: string; depart_at: string; status: string; route: string;
  registration: string; bus_type: string;
  seats: number; sold: number; counter_quota: number; crew: string;
}

interface Manifest {
  trip: { depart_at: string; route: string; operator: string; registration: string; status: string };
  passengers: {
    seat_no: string; pnr: string; channel: string; passenger: string; phone: string;
    ticket_status: string; from: string; to: string;
  }[];
  total: number;
  boarded: number;
}

// The trip lifecycle. A trip may only move to a state that follows from the one
// it is in — the server rejects anything else, and this only offers what is
// legal so a dispatcher is never presented with a button that cannot work.
const NEXT: Record<string, string[]> = {
  SCHEDULED: ['OPEN', 'CANCELLED'],
  OPEN: ['BOARDING', 'CANCELLED'],
  BOARDING: ['DEPARTED', 'CANCELLED'],
  DEPARTED: ['IN_PROGRESS', 'ARRIVED'],
  IN_PROGRESS: ['ARRIVED'],
  ARRIVED: ['COMPLETED'],
};

export default function OperatorTripsPage() {
  const session = useSession();
  const [date, setDate] = useState(isoDate(new Date()));
  const [trips, setTrips] = useState<Trip[]>([]);
  const [manifest, setManifest] = useState<Manifest | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [cancelTrip, setCancelTrip] = useState<Trip | null>(null);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [rosterTrip, setRosterTrip] = useState<Trip | null>(null);

  const load = useCallback((d: string) => {
    setLoading(true);
    sget<{ trips: Trip[] }>(`/operator/trips?date=${d}`)
      .then((r) => setTrips(r.trips))
      .catch((e: ApiError) => setError(e.message))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { load(date); }, [date, load]);

  const advance = async (t: Trip, status: string) => {
    // Cancelling refunds every passenger and texts them — never a one-click
    // action. Open a confirmation that states the impact and takes a reason.
    if (status === 'CANCELLED') {
      setReason('');
      setCancelTrip(t);
      return;
    }
    setError('');
    try {
      await spost(`/operator/trips/${t.trip_id}/status`, { status });
      load(date);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'The trip status could not be changed.');
    }
  };

  const confirmCancel = async () => {
    if (!cancelTrip) return;
    setBusy(true);
    setError('');
    try {
      const r = await spost<{ bookings_cancelled: number; refund_poisha: number }>(
        `/operator/trips/${cancelTrip.trip_id}/status`,
        { status: 'CANCELLED', reason: reason.trim() },
      );
      setNotice(
        r.bookings_cancelled > 0
          ? `Trip cancelled. ${r.bookings_cancelled} passenger${r.bookings_cancelled === 1 ? '' : 's'} refunded in full (৳${(r.refund_poisha / 100).toLocaleString('en-BD')}) and notified.`
          : 'Trip cancelled. No passengers were booked.',
      );
      setCancelTrip(null);
      load(date);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'The trip could not be cancelled.');
    } finally {
      setBusy(false);
    }
  };

  const openManifest = async (t: Trip) => {
    try {
      setManifest(await sget<Manifest>(`/operator/trips/${t.trip_id}/manifest`));
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'The manifest could not be loaded.');
    }
  };

  const mayWrite = can(session?.identity ?? null, 'trip.write');
  const mayRoster = can(session?.identity ?? null, 'schedule.write');

  if (manifest) {
    return (
      <div className="stack">
        <PageHead
          title="Passenger manifest"
          sub={`${manifest.trip.operator} · ${manifest.trip.route} · ${timeOf(manifest.trip.depart_at)}`}
          actions={
            <>
              <button className="btn btn-ghost" onClick={() => window.print()}>Print</button>
              <button className="btn btn-ghost" onClick={() => setManifest(null)}>Back to trips</button>
            </>
          }
        />
        <p className="small muted">
          {manifest.total} passengers · {manifest.boarded} boarded. The driver app
          and the crew scanner read this same list — there is one manifest, not
          three that can drift apart.
        </p>
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr><th>Seat</th><th>Passenger</th><th>PNR</th><th>Journey</th><th>Sold via</th><th>Phone</th><th>Ticket</th></tr>
            </thead>
            <tbody>
              {manifest.passengers.map((p) => (
                <tr key={p.seat_no + p.pnr}>
                  <td className="mono"><strong>{p.seat_no}</strong></td>
                  <td>{p.passenger || '—'}</td>
                  <td className="mono small">{p.pnr}</td>
                  <td className="small">{p.from} → {p.to}</td>
                  <td className="small muted">{channelLabel(p.channel)}</td>
                  <td className="mono small">{p.phone}</td>
                  <td>
                    <span className={`pill ${p.ticket_status === 'BOARDED' ? 'pill-ok' : ''}`}>
                      {p.ticket_status.toLowerCase()}
                    </span>
                  </td>
                </tr>
              ))}
              {manifest.passengers.length === 0 && (
                <tr><td colSpan={7} className="muted center">Nobody booked on this departure yet.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    );
  }

  return (
    <div className="stack">
      <PageHead
        title="Trips"
        sub="Generated automatically from your schedules"
        actions={
          <input className="input" type="date" value={date} style={{ width: 170 }}
                 onChange={(e) => setDate(e.target.value)} aria-label="Service date" />
        }
      />

      {error && <ErrorNotice message={error} />}
      {notice && (
        <div className="card card-pad" role="status"
             style={{ borderColor: 'var(--brand)', display: 'flex', justifyContent: 'space-between', gap: '.75rem', alignItems: 'center' }}>
          <span className="small">{notice}</span>
          <button className="btn btn-sm btn-ghost" onClick={() => setNotice('')}>Dismiss</button>
        </div>
      )}
      {loading ? <Loading rows={2} /> : (
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>Departs</th><th>Route</th><th>Bus</th><th>Occupancy</th>
                <th className="num">Sold</th><th className="num">Counter quota</th>
                <th>Crew</th><th>Status</th><th />
              </tr>
            </thead>
            <tbody>
              {trips.map((t) => (
                <tr key={t.trip_id}>
                  <td><strong>{timeOf(t.depart_at)}</strong></td>
                  <td>{t.route}</td>
                  <td className="small">{t.registration}<br /><span className="muted">{t.bus_type}</span></td>
                  <td style={{ width: 110 }}><Bar value={t.sold} max={t.seats} /></td>
                  <td className="num">{t.sold}/{t.seats}</td>
                  <td className="num">{t.counter_quota || '—'}</td>
                  <td className="small muted">{t.crew || 'Unassigned'}</td>
                  <td><span className="pill">{t.status.toLowerCase()}</span></td>
                  <td>
                    <div className="row" style={{ gap: '.3rem' }}>
                      <button className="btn btn-sm btn-ghost" onClick={() => openManifest(t)}>Manifest</button>
                      {mayRoster && <button className="btn btn-sm btn-ghost" onClick={() => setRosterTrip(t)}>Crew</button>}
                      {mayWrite && (NEXT[t.status] ?? []).map((s) => (
                        <button key={s} className={`btn btn-sm ${s === 'CANCELLED' ? 'btn-danger' : 'btn-brand'}`}
                                onClick={() => advance(t, s)}>
                          {s === 'CANCELLED' ? 'Cancel' : s.replace(/_/g, ' ').toLowerCase()}
                        </button>
                      ))}
                    </div>
                  </td>
                </tr>
              ))}
              {trips.length === 0 && (
                <tr><td colSpan={9} className="muted center">No departures on that date.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      {rosterTrip && (
        <CrewRoster tripID={rosterTrip.trip_id}
                    label={`${rosterTrip.route} · ${timeOf(rosterTrip.depart_at)} · ${rosterTrip.registration}`}
                    onClose={() => setRosterTrip(null)}
                    onChanged={() => load(date)} />
      )}

      {cancelTrip && (
        <div className="sheet-backdrop" onClick={() => !busy && setCancelTrip(null)}>
          <div className="sheet" role="dialog" aria-modal="true" aria-label="Cancel trip"
               onClick={(e) => e.stopPropagation()}>
            <div className="sheet-grip" />
            <div className="stack" style={{ gap: '.9rem', padding: '0 .25rem' }}>
              <PageHead title="Cancel this trip"
                        sub={`${cancelTrip.route} · ${timeOf(cancelTrip.depart_at)} · ${cancelTrip.registration}`} />
              <p className="small">
                {cancelTrip.sold > 0 ? (
                  <><strong>{cancelTrip.sold} passenger{cancelTrip.sold === 1 ? '' : 's'}</strong> will be
                  refunded in full and sent an SMS. Their seats are released and their
                  tickets voided. This cannot be undone.</>
                ) : (
                  <>No passengers are booked on this departure. It will simply be marked cancelled.</>
                )}
              </p>
              <label className="stack" style={{ gap: '.35rem' }}>
                <span className="small muted">Reason (shown in the audit log)</span>
                <input className="input" value={reason} autoFocus
                       placeholder="e.g. engine failure, driver unavailable"
                       onChange={(e) => setReason(e.target.value)} />
              </label>
              <div className="row" style={{ gap: '.5rem', justifyContent: 'flex-end' }}>
                <button className="btn btn-ghost" disabled={busy} onClick={() => setCancelTrip(null)}>
                  Keep the trip
                </button>
                <button className="btn btn-danger" disabled={busy || !reason.trim()} onClick={confirmCancel}>
                  {busy ? 'Cancelling…' : cancelTrip.sold > 0 ? `Cancel & refund ${cancelTrip.sold}` : 'Cancel trip'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
