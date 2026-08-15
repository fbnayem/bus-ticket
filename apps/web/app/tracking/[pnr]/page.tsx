'use client';

import { use, useEffect, useState } from 'react';
import Link from 'next/link';
import { api, ApiError, type Tracking } from '@/lib/api';
import { ErrorNotice, Loading } from '@/components/ui';
import { dateTimeOf, timeOf } from '@/lib/format';

export default function TrackingPage({ params }: { params: Promise<{ pnr: string }> }) {
  const { pnr } = use(params);
  const [data, setData] = useState<Tracking | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let alive = true;
    const load = () =>
      api.tracking(pnr)
        .then((d) => alive && setData(d))
        .catch((e: ApiError) => alive && setError(e.message));
    load();
    const t = setInterval(load, 20000);
    return () => { alive = false; clearInterval(t); };
  }, [pnr]);

  if (error) return <div className="page container-narrow"><ErrorNotice message={error} /></div>;
  if (!data) return <div className="page container-narrow"><Loading rows={2} /></div>;

  return (
    <div className="page container-narrow">
      <div className="row-between" style={{ marginBottom: '1rem' }}>
        <div>
          <h1 style={{ fontSize: '1.3rem' }}>Where is my bus?</h1>
          <p className="muted small" style={{ margin: 0 }}>
            Booking <span className="mono">{pnr}</span>
          </p>
        </div>
        <span className={`pill ${data.state === 'IN_PROGRESS' ? 'pill-ok' : ''}`}>
          {data.state.replace(/_/g, ' ').toLowerCase()}
        </span>
      </div>

      {/* Honesty about provenance: this is derived from the timetable, not GPS. */}
      <div className="notice notice-warn" style={{ marginBottom: '1rem' }}>
        <strong>Estimated from the timetable.</strong> {data.source_note}
      </div>

      <div className="card card-pad stack" style={{ marginBottom: '1rem' }}>
        <div className="row-between">
          <div>
            <div className="small muted">Departed</div>
            <div style={{ fontWeight: 600 }}>{dateTimeOf(data.depart_at)}</div>
          </div>
          <div style={{ textAlign: 'right' }}>
            <div className="small muted">Expected arrival</div>
            <div style={{ fontWeight: 600 }}>{dateTimeOf(data.arrive_at)}</div>
          </div>
        </div>

        <div className="progress" role="progressbar"
             aria-valuenow={Math.round(data.progress * 100)} aria-valuemin={0} aria-valuemax={100}>
          <span style={{ width: `${Math.round(data.progress * 100)}%` }} />
        </div>

        {data.next_stop && (
          <div className="small">
            Next stop <strong>{data.next_stop}</strong>
            {data.eta && <> — around <span className="mono">{timeOf(data.eta)}</span></>}
          </div>
        )}
      </div>

      <div className="card">
        <div className="card-head">Route progress</div>
        <div className="card-pad">
          <ol style={{ listStyle: 'none', margin: 0, padding: 0 }}>
            {data.stops.map((s) => (
              <li key={s.seq} className="row" style={{ gap: '.7rem', padding: '.45rem 0' }}>
                <span className={`route-dot ${s.passed ? '' : 'hollow'}`} />
                <span className="mono tnum small" style={{ minWidth: 46 }}>{timeOf(s.at)}</span>
                <span style={{ fontWeight: s.passed ? 400 : 600, color: s.passed ? 'var(--muted)' : 'var(--ink)' }}>
                  {s.name}
                </span>
                {s.passed && <span className="pill pill-ok">passed</span>}
              </li>
            ))}
          </ol>
        </div>
      </div>

      <div className="row" style={{ gap: '.5rem', marginTop: '1rem' }}>
        <Link className="btn btn-ghost" href={`/tickets/${pnr}`}>View ticket</Link>
        <Link className="btn btn-ghost" href={`/manage/${pnr}`}>Manage booking</Link>
      </div>
    </div>
  );
}
