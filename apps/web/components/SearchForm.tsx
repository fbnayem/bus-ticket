'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { api, type Location } from '@/lib/api';
import { isoDate } from '@/lib/format';
import { useT } from './LangProvider';

export function SearchForm({
  initialFrom = 'Dhaka',
  initialTo = 'Chattogram',
  initialDate,
  compact = false,
}: {
  initialFrom?: string;
  initialTo?: string;
  initialDate?: string;
  compact?: boolean;
}) {
  const router = useRouter();
  const t = useT();
  const [locations, setLocations] = useState<Location[]>([]);
  const [from, setFrom] = useState(initialFrom);
  const [to, setTo] = useState(initialTo);
  const [date, setDate] = useState(initialDate ?? isoDate(new Date(Date.now() + 864e5)));
  const [error, setError] = useState('');

  useEffect(() => {
    api.locations().then((r) => setLocations(r.locations)).catch(() => {});
  }, []);

  const swap = () => { setFrom(to); setTo(from); };

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (from.trim().toLowerCase() === to.trim().toLowerCase()) {
      setError(t('search.sameCity'));
      return;
    }
    setError('');
    router.push(`/search?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&date=${date}`);
  };

  return (
    <form onSubmit={submit} className="stack" aria-label={t('search.submit')}>
      <div style={{
        display: 'grid',
        gridTemplateColumns: compact ? '1fr auto 1fr 1fr auto' : '1fr auto 1fr',
        gap: '.6rem', alignItems: 'end',
      }} className="search-grid">
        <div className="field">
          <label className="label" htmlFor="from">{t('search.from')}</label>
          <input
            id="from" className="input" list="loc-list" value={from} autoComplete="off"
            onChange={(e) => setFrom(e.target.value)} placeholder={t('search.pickFrom')} required
          />
        </div>

        <button
          type="button" className="btn btn-ghost swap-btn" onClick={swap}
          aria-label={t('search.swap')} title={t('search.swap')}
        >
          <span aria-hidden="true">⇄</span>
        </button>

        <div className="field">
          <label className="label" htmlFor="to">{t('search.to')}</label>
          <input
            id="to" className="input" list="loc-list" value={to} autoComplete="off"
            onChange={(e) => setTo(e.target.value)} placeholder={t('search.pickTo')} required
          />
        </div>

        {compact && (
          <>
            <div className="field">
              <label className="label" htmlFor="date">{t('search.date')}</label>
              <input id="date" className="input" type="date" value={date}
                min={isoDate(new Date())} onChange={(e) => setDate(e.target.value)} required />
            </div>
            <button className="btn btn-primary" type="submit" style={{ minHeight: 40 }}>
              {t('nav.search')}
            </button>
          </>
        )}
      </div>

      {!compact && (
        <div className="grid-2">
          <div className="field">
            <label className="label" htmlFor="date-full">{t('search.date')}</label>
            <input id="date-full" className="input" type="date" value={date}
              min={isoDate(new Date())} onChange={(e) => setDate(e.target.value)} required />
          </div>
          <div className="field" style={{ justifyContent: 'flex-end' }}>
            <button className="btn btn-primary btn-lg" type="submit">{t('search.submit')}</button>
          </div>
        </div>
      )}

      {error && <p className="err" role="alert" style={{ margin: 0 }}>{error}</p>}

      <datalist id="loc-list">
        {locations.map((l) => <option key={l.id} value={l.name} />)}
      </datalist>

    </form>
  );
}
