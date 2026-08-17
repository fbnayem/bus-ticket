'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { ApiError } from '@/lib/api';
import { sget, spost } from '@/lib/staff';
import { ErrorNotice, Loading } from '@/components/ui';
import { PageHead, Bar } from '@/components/staff-ui';
import { useLang } from '@/components/LangProvider';
import { STRINGS, errorText, type Key } from '@/lib/i18n';
// The driver's trips.
//
// Crew can move a trip through the states they are actually in a position to
// observe — boarding started, we have left, we have arrived. Cancelling a trip
// is an office decision and the server refuses it from here.
//
// Read on a phone, one-handed, often in sunlight, by someone who is also
// managing a queue of passengers at a bus door. So: one card per trip, the
// departure time as the biggest thing on it, and every button a verb.

interface Trip {
  trip_id: string; depart_at: string; status: string; route: string;
  registration: string; crew_role: string; passengers: number; boarded: number;
}

const CREW_NEXT: Record<string, string> = {
  SCHEDULED: 'BOARDING', OPEN: 'BOARDING', BOARDING: 'DEPARTED',
  DEPARTED: 'IN_PROGRESS', IN_PROGRESS: 'ARRIVED',
};

export default function DriverTripsPage() {
  const { t, fmt } = useLang();
  const [trips, setTrips] = useState<Trip[]>([]);
  const [error, setError] = useState('');
  const [flash, setFlash] = useState('');
  const [loading, setLoading] = useState(true);
  const [sharing, setSharing] = useState<string | null>(null);

  const load = useCallback(() => {
    sget<{ trips: Trip[] }>('/driver/trips')
      .then((r) => setTrips(r.trips))
      .catch((e: ApiError) => setError(errorText(t, e)))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { load(); }, [load]);

  /** A catalogue string if we have one, the server's own word if we do not. */
  const say = (key: string, fallback: string) =>
    (key as Key) in STRINGS ? t(key as Key) : fallback;

  const advance = async (tr: Trip) => {
    const next = CREW_NEXT[tr.status];
    if (!next) return;
    setError('');
    try {
      await spost(`/driver/trips/${tr.trip_id}/status`, { status: next });
      setFlash(say(`dr.done.${next}`, next.replace(/_/g, ' ').toLowerCase()));
      load();
    } catch (e) {
      setError(errorText(t, e, 'dr.stateFail'));
    }
  };

  // Sharing position is what turns the passenger's tracking page from "estimated
  // from the timetable" into a real fix. It is opt-in per trip, on purpose.
  const shareLocation = (tr: Trip) => {
    if (!navigator.geolocation) {
      setError(t('dr.noGeo'));
      return;
    }
    setSharing(tr.trip_id);
    const send = (lat: number, lng: number, speed: number) =>
      spost(`/driver/trips/${tr.trip_id}/position`, {
        lat, lng, speed_kph: Math.round(speed * 3.6), heading: 0,
      }).catch(() => {});

    navigator.geolocation.getCurrentPosition(
      (pos) => {
        void send(pos.coords.latitude, pos.coords.longitude, pos.coords.speed ?? 0);
        setFlash(t('dr.shared'));
        setSharing(null);
      },
      () => {
        // No GPS permission, no invented position. Say so.
        setError(t('dr.shareRefused'));
        setSharing(null);
      },
      { enableHighAccuracy: true, timeout: 8000 },
    );
  };

  if (loading) return <Loading rows={2} />;

  return (
    <div className="stack">
      <PageHead title={t('dr.myTrips')} sub={t('dr.nextDays')} />
      {error && <ErrorNotice message={error} />}
      {flash && <div className="notice notice-info" role="status">{flash}</div>}

      {trips.map((tr) => {
        const next = CREW_NEXT[tr.status];
        const allOn = tr.passengers > 0 && tr.boarded >= tr.passengers;
        return (
          <div className="card card-pad stack-sm" key={tr.trip_id}>
            <div className="row-between">
              <div style={{ minWidth: 0 }}>
                {/* The departure time is what a driver looks for first, so it is
                    the largest thing on the card and nothing competes with it. */}
                <div className="crew-when">
                  <strong>{fmt.time(tr.depart_at)}</strong>
                  <span className="muted">{fmt.day(tr.depart_at)}</span>
                </div>
                <div style={{ fontWeight: 600 }}>{tr.route}</div>
                <div className="small muted">
                  {tr.registration} ·{' '}
                  {tr.crew_role === 'UNASSIGNED'
                    ? t('dr.notRostered')
                    : say(`dr.role.${tr.crew_role}`, tr.crew_role.toLowerCase())}
                </div>
              </div>
              <span className="pill">
                {say(`tr.state.${tr.status}`, tr.status.replace(/_/g, ' ').toLowerCase())}
              </span>
            </div>

            {/* How many are on. A count with a bar rather than a bare fraction:
                a driver checks this at a glance while looking at the door. */}
            <div className="row" style={{ gap: '.6rem' }}>
              <span className={`small ${allOn ? '' : 'muted'}`} style={allOn ? { color: 'var(--ok)', fontWeight: 660 } : undefined}>
                {t('dr.ofTotal', { done: tr.boarded, total: tr.passengers })}
              </span>
              <div style={{ flex: '0 1 160px' }}>
                <Bar value={tr.boarded} max={Math.max(1, tr.passengers)} />
              </div>
            </div>

            <div className="row">
              <Link className="btn btn-brand" href={`/driver/scan?trip=${tr.trip_id}`}>
                {t('dr.nav.scan')}
              </Link>
              <Link className="btn btn-ghost" href={`/driver/manifest/${tr.trip_id}`}>
                {t('dr.manifest')}
              </Link>
              {next && (
                <button className="btn btn-primary" onClick={() => advance(tr)}>
                  {say(`dr.do.${next}`, next.replace(/_/g, ' ').toLowerCase())}
                </button>
              )}
              <button className="btn btn-ghost" disabled={sharing === tr.trip_id}
                      onClick={() => shareLocation(tr)}>
                {sharing === tr.trip_id ? t('dr.sharing') : t('dr.shareLocation')}
              </button>
            </div>
          </div>
        );
      })}

      {trips.length === 0 && (
        <div className="empty">
          <h3>{t('dr.noTrips')}</h3>
          <p className="muted">{t('dr.noneAssigned')}</p>
        </div>
      )}
    </div>
  );
}
