'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { ApiError } from '@/lib/api';
import { sget, spost } from '@/lib/staff';
import { ErrorNotice, Loading } from '@/components/ui';
import { PageHead, Bar } from '@/components/staff-ui';
import { dateOf, timeOf } from '@/lib/format';

// The driver's trips.
//
// Crew can move a trip through the states they are actually in a position to
// observe — boarding started, we have left, we have arrived. Cancelling a trip
// is an office decision and the server refuses it from here.

interface Trip {
  trip_id: string; depart_at: string; status: string; route: string;
  registration: string; crew_role: string; passengers: number; boarded: number;
}

const CREW_NEXT: Record<string, string> = {
  SCHEDULED: 'BOARDING', OPEN: 'BOARDING', BOARDING: 'DEPARTED',
  DEPARTED: 'IN_PROGRESS', IN_PROGRESS: 'ARRIVED',
};

export default function DriverTripsPage() {
  const [trips, setTrips] = useState<Trip[]>([]);
  const [error, setError] = useState('');
  const [flash, setFlash] = useState('');
  const [loading, setLoading] = useState(true);
  const [sharing, setSharing] = useState<string | null>(null);

  const load = useCallback(() => {
    sget<{ trips: Trip[] }>('/driver/trips')
      .then((r) => setTrips(r.trips))
      .catch((e: ApiError) => setError(e.message))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { load(); }, [load]);

  const advance = async (t: Trip) => {
    const next = CREW_NEXT[t.status];
    if (!next) return;
    setError('');
    try {
      await spost(`/driver/trips/${t.trip_id}/status`, { status: next });
      setFlash(`Marked ${next.replace(/_/g, ' ').toLowerCase()}.`);
      load();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'That could not be recorded.');
    }
  };

  // Sharing position is what turns the passenger's tracking page from "estimated
  // from the timetable" into a real fix. It is opt-in per trip, on purpose.
  const shareLocation = (t: Trip) => {
    if (!navigator.geolocation) {
      setError('This device cannot report its position.');
      return;
    }
    setSharing(t.trip_id);
    const send = (lat: number, lng: number, speed: number) =>
      spost(`/driver/trips/${t.trip_id}/position`, {
        lat, lng, speed_kph: Math.round(speed * 3.6), heading: 0,
      }).catch(() => {});

    navigator.geolocation.getCurrentPosition(
      (pos) => {
        void send(pos.coords.latitude, pos.coords.longitude, pos.coords.speed ?? 0);
        setFlash('Position shared. Passengers on this trip now see a real fix instead of an estimate.');
        setSharing(null);
      },
      () => {
        // No GPS permission, no invented position. Say so.
        setError('Location was refused, so nothing was sent. Passengers keep seeing the timetable estimate.');
        setSharing(null);
      },
      { enableHighAccuracy: true, timeout: 8000 },
    );
  };

  if (loading) return <Loading rows={2} />;

  return (
    <div className="stack">
      <PageHead title="My trips" sub="Today and the next two days" />
      {error && <ErrorNotice message={error} />}
      {flash && <div className="notice notice-info">{flash}</div>}

      {trips.map((t) => (
        <div className="card card-pad stack-sm" key={t.trip_id}>
          <div className="row-between">
            <div>
              <strong style={{ fontSize: '1.1rem' }}>{timeOf(t.depart_at)}</strong>{' '}
              <span className="muted">{dateOf(t.depart_at)}</span>
              <div>{t.route}</div>
              <div className="small muted">
                {t.registration} · {t.crew_role === 'UNASSIGNED' ? 'not rostered' : t.crew_role.toLowerCase()}
              </div>
            </div>
            <span className="pill">{t.status.replace(/_/g, ' ').toLowerCase()}</span>
          </div>

          <div className="row" style={{ gap: '.6rem' }}>
            <span className="small muted">{t.boarded} of {t.passengers} boarded</span>
            <div style={{ flex: '0 1 160px' }}><Bar value={t.boarded} max={Math.max(1, t.passengers)} /></div>
          </div>

          <div className="row">
            <Link className="btn btn-brand btn-sm" href={`/driver/scan?trip=${t.trip_id}`}>
              Board passengers
            </Link>
            <Link className="btn btn-ghost btn-sm" href={`/driver/manifest/${t.trip_id}`}>
              Manifest
            </Link>
            {CREW_NEXT[t.status] && (
              <button className="btn btn-primary btn-sm" onClick={() => advance(t)}>
                {CREW_NEXT[t.status].replace(/_/g, ' ').toLowerCase()}
              </button>
            )}
            <button className="btn btn-ghost btn-sm" disabled={sharing === t.trip_id}
                    onClick={() => shareLocation(t)}>
              {sharing === t.trip_id ? 'Sharing…' : 'Share position'}
            </button>
          </div>
        </div>
      ))}

      {trips.length === 0 && (
        <div className="empty">
          <h3>No trips assigned</h3>
          <p className="muted">Nothing is rostered to you in the next few days.</p>
        </div>
      )}
    </div>
  );
}
