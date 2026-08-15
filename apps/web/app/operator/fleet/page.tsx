'use client';

import { useEffect, useState } from 'react';
import { ApiError } from '@/lib/api';
import { sget } from '@/lib/staff';
import { ErrorNotice, Loading } from '@/components/ui';
import { PageHead } from '@/components/staff-ui';
import { AMENITY_LABEL } from '@/lib/format';

interface Bus {
  bus_id: string; registration: string; bus_type: string; is_ac: boolean;
  class: string; status: string; layout: string; seats: number; amenities: string;
}

export default function FleetPage() {
  const [buses, setBuses] = useState<Bus[]>([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    sget<{ buses: Bus[] }>('/operator/buses')
      .then((r) => setBuses(r.buses))
      .catch((e: ApiError) => setError(e.message))
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <Loading rows={2} />;

  return (
    <div className="stack">
      <PageHead title="Fleet" sub="Buses, their seat layouts and what is fitted" />
      {error && <ErrorNotice message={error} />}

      <div className="table-wrap">
        <table className="data">
          <thead>
            <tr>
              <th>Registration</th><th>Type</th><th>Class</th>
              <th>Seat layout</th><th className="num">Seats</th><th>Fitted</th><th>Status</th>
            </tr>
          </thead>
          <tbody>
            {buses.map((b) => (
              <tr key={b.bus_id}>
                <td className="mono"><strong>{b.registration}</strong></td>
                <td>{b.bus_type} {b.is_ac && <span className="pill pill-brand">AC</span>}</td>
                <td className="muted small">{b.class}</td>
                <td>{b.layout}</td>
                <td className="num">{b.seats}</td>
                <td className="small muted">
                  {b.amenities
                    ? b.amenities.split(', ').map((a) => AMENITY_LABEL[a] ?? a).join(' · ')
                    : '—'}
                </td>
                <td><span className={`pill ${b.status === 'ACTIVE' ? 'pill-ok' : 'pill-warn'}`}>{b.status.toLowerCase()}</span></td>
              </tr>
            ))}
            {buses.length === 0 && (
              <tr><td colSpan={7} className="muted center">No buses registered.</td></tr>
            )}
          </tbody>
        </table>
      </div>

      <p className="small muted">
        A seat layout is frozen once a trip references it. Changing the layout of
        a bus that has already run would rewrite what every historical ticket
        meant, so a new version is created instead.
      </p>
    </div>
  );
}
