'use client';

import { use, useEffect, useState } from 'react';
import Link from 'next/link';
import { api, ApiError, type Tracking } from '@/lib/api';
import { ErrorNotice, Loading } from '@/components/ui';
import { useLang } from '@/components/LangProvider';
import { STRINGS, type Key } from '@/lib/i18n';

/**
 * Where the bus is.
 *
 * Two corrections, both about telling the truth in the right tone.
 *
 * THE PROVENANCE NOTE WAS PAINTED AS A WARNING. "Estimated from the timetable"
 * sat in amber, which in this system means a human needs to act soon. Nothing
 * has gone wrong when a position is derived from a schedule — it is simply not
 * GPS. It now uses the in-flight semantic, the same one the payment-pending
 * screen uses: waiting on the outside world, not broken.
 *
 * THE STATE WAS THE DATABASE'S WORD, LOWERCASED. `IN_PROGRESS` became
 * "in progress", which is not a thing a passenger says about a bus. Each state
 * is now a sentence about the bus: on the road, boarding now, arrived.
 */
export default function TrackingPage({ params }: { params: Promise<{ pnr: string }> }) {
  const { pnr } = use(params);
  const { t, fmt } = useLang();
  const [data, setData] = useState<Tracking | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let alive = true;
    const load = () =>
      api.tracking(pnr)
        .then((d) => alive && setData(d))
        .catch((e: ApiError) => alive && setError(e.message));
    load();
    const timer = setInterval(load, 20000);
    return () => { alive = false; clearInterval(timer); };
  }, [pnr]);

  if (error) return <div className="page container-narrow"><ErrorNotice message={error} /></div>;
  if (!data) return <div className="page container-narrow"><Loading rows={2} /></div>;

  // An unfamiliar state is still shown rather than swallowed: a passenger who
  // reads a raw status is better served than one who reads an empty pill.
  const stateKey = `tr.state.${data.state}` as Key;
  const stateLabel = stateKey in STRINGS ? t(stateKey) : data.state.replace(/_/g, ' ');
  const moving = data.state === 'IN_PROGRESS' || data.state === 'DEPARTED';
  const done = data.state === 'ARRIVED' || data.state === 'COMPLETED';

  // A real fix and a timetable guess are different kinds of fact, so they get
  // different semantics: an actual GPS position has landed, a derived one is
  // still waiting on the outside world. Neither is a warning.
  const live = data.source === 'DRIVER_APP_GPS';
  const srcKey = `tr.src.${data.source}` as Key;
  const pct = Math.round(data.progress * 100);

  // The stop the bus is working towards: the first one not yet passed.
  const nowIdx = data.stops.findIndex((s) => !s.passed);

  return (
    <div className="page container-narrow">
      <div className="row-between" style={{ marginBottom: '.3rem' }}>
        <h1 style={{ fontSize: '1.35rem', marginBottom: 0 }}>{t('tr.title')}</h1>
        <span className={`pill ${moving ? 'pill-ok' : 'pill-inflight'}`}>{stateLabel}</span>
      </div>
      <p className="muted small" style={{ marginBottom: '1rem' }}>
        {t('find.label')} <span className="ref">{pnr}</span>
      </p>

      {/*
        Provenance, in the in-flight colour. Nothing is wrong; this is simply
        where the number came from — and saying so is what keeps a passenger
        from treating a timetable estimate as a satellite fix.
      */}
      <div className="notice" style={{
        marginBottom: '1rem',
        background: live ? 'var(--ok-tint)' : 'var(--inflight-tint)',
        color: live ? 'var(--ok)' : 'var(--inflight)',
        borderColor: 'transparent',
      }}>
        <strong>{live ? t('tr.live') : t('tr.estimated')}.</strong>{' '}
        {srcKey in STRINGS ? t(srcKey) : data.source_note}
      </div>

      <div className="card card-pad stack" style={{ marginBottom: '1rem' }}>
        <div className="row-between">
          <div>
            <div className="small muted">{moving || done ? t('tr.departed') : t('tr.departs')}</div>
            <div style={{ fontWeight: 640 }}>{fmt.dateTime(data.depart_at)}</div>
          </div>
          <div style={{ textAlign: 'right' }}>
            <div className="small muted">{t('tr.arriving')}</div>
            <div style={{ fontWeight: 640 }}>{fmt.dateTime(data.arrive_at)}</div>
          </div>
        </div>

        <div className="progress" role="progressbar" aria-label={t('tr.progress', { pct })}
             aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
          <span style={{ width: `${pct}%` }} />
        </div>

        {data.next_stop && (
          <div>
            <span className="small muted">{t('tr.nextStop')}</span>{' '}
            <strong>{data.next_stop}</strong>
            {data.eta && <> — <span className="tnum">{t('tr.around', { time: fmt.time(data.eta) })}</span></>}
          </div>
        )}
      </div>

      <div className="card">
        <div className="card-head">{t('tr.stops')}</div>
        <div className="card-pad">
          {/*
            The route drawn down the page with the travelled part of the spine
            painted, rather than a flat list with a "passed" badge repeated on
            every row. Position is the thing being communicated, so position is
            what carries it.
          */}
          <ol className="journey">
            {data.stops.map((s, i) => (
              <li key={s.seq}
                  className={s.passed ? 'is-past' : i === nowIdx ? 'is-now' : ''}>
                <span className="j-spine" aria-hidden="true" />
                <span className="j-dot" aria-hidden="true" />
                <span className="j-time">{fmt.time(s.at)}</span>
                <span className="j-name">{s.name}</span>
                {s.passed && <span className="j-tag pill pill-ok">{t('tr.passed')}</span>}
              </li>
            ))}
          </ol>
        </div>
      </div>

      <div className="row" style={{ gap: '.5rem', marginTop: '1rem' }}>
        <Link className="btn btn-ghost" href={`/tickets/${pnr}`}>{t('mb.viewTicket')}</Link>
        <Link className="btn btn-ghost" href={`/manage/${pnr}`}>{t('mb.title')}</Link>
      </div>
    </div>
  );
}
