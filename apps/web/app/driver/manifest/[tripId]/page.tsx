'use client';

import { use, useEffect, useState } from 'react';
import Link from 'next/link';
import { ApiError } from '@/lib/api';
import { sget } from '@/lib/staff';
import { ErrorNotice, Loading } from '@/components/ui';
import { PageHead, Bar } from '@/components/staff-ui';
import { useLang } from '@/components/LangProvider';

interface Manifest {
  trip: { depart_at: string; route: string; operator: string; registration: string; status: string };
  passengers: {
    seat_no: string; pnr: string; channel: string; passenger: string; phone: string;
    ticket_status: string; from: string; to: string;
  }[];
  total: number; boarded: number;
}

export default function DriverManifestPage({ params }: { params: Promise<{ tripId: string }> }) {
  const { tripId } = use(params);
  const { t, fmt } = useLang();
  const [m, setM] = useState<Manifest | null>(null);
  const [error, setError] = useState('');
  const [stale, setStale] = useState(false);

  useEffect(() => {
    sget<Manifest>(`/driver/trips/${tripId}/manifest`)
      .then((r) => {
        setM(r);
        // Saved before departure, because this is the list a helper checks
        // tickets against when the signal goes.
        localStorage.setItem('jatra.manifest.' + tripId, JSON.stringify(r));
      })
      .catch((e: ApiError) => {
        const cached = localStorage.getItem('jatra.manifest.' + tripId);
        if (cached) { setM(JSON.parse(cached)); setStale(true); }
        else setError(e.message);
      });
  }, [tripId]);

  if (!m && error) return <ErrorNotice message={error} />;
  if (!m) return <Loading rows={2} />;

  return (
    <div className="stack">
      <PageHead
        title={t('dr.mf.title')}
        sub={`${m.trip.route} · ${fmt.dateTime(m.trip.depart_at)} · ${m.trip.registration}`}
        actions={
          <>
            <Link className="btn btn-brand" href={`/driver/scan?trip=${tripId}`}>{t('dr.mf.board')}</Link>
            <button className="btn btn-ghost" onClick={() => window.print()}>{t('dr.mf.print')}</button>
          </>
        }
      />
      {stale && <div className="notice notice-warn">{t('dr.mf.cached')}</div>}

      <div className="row" style={{ gap: '.7rem', alignItems: 'center' }}>
        <span className="small muted">{t('dr.ofTotal', { done: m.boarded, total: m.total })}</span>
        <div style={{ flex: '0 1 200px' }}><Bar value={m.boarded} max={Math.max(1, m.total)} /></div>
      </div>

      <div className="table-wrap">
        <table className="data">
          <thead>
            <tr>
              <th>{t('co.seats')}</th><th>{t('co.paxName')}</th>
              <th>{t('dr.mf.getsOn')}</th><th>{t('co.s.pnr')}</th>
              <th>{t('dr.mf.phone')}</th><th>{t('dr.boarded')}</th>
            </tr>
          </thead>
          <tbody>
            {m.passengers.map((p) => (
              <tr key={p.seat_no + p.pnr}>
                <td className="mono"><strong>{p.seat_no}</strong></td>
                <td>{p.passenger || '—'}</td>
                <td className="small">{p.from} → {p.to}</td>
                <td className="mono small">{p.pnr}</td>
                <td className="mono small">{p.phone}</td>
                <td>
                  {p.ticket_status === 'BOARDED'
                    ? <span className="pill pill-ok">{t('dr.mf.yes')}</span>
                    : <span className="pill">—</span>}
                </td>
              </tr>
            ))}
            {m.passengers.length === 0 && (
              <tr><td colSpan={6} className="muted center">{t('dr.mf.empty')}</td></tr>
            )}
          </tbody>
        </table>
      </div>

      <p className="small muted">{t('dr.mf.foot')}</p>
    </div>
  );
}
