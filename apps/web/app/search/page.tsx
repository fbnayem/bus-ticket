'use client';

import { Suspense, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { api, ApiError, type SearchResponse } from '@/lib/api';
import { SearchForm } from '@/components/SearchForm';
import { TripCard } from '@/components/TripCard';
import { Empty, ErrorNotice, Loading, Stepper } from '@/components/ui';
import { useLang, useT } from '@/components/LangProvider';
import { isoDate } from '@/lib/format';

type Sort = 'departure' | 'price' | 'duration' | 'availability';

/**
 * A week of departures, centred on the day being viewed but never reaching
 * into the past. Changing day used to mean reopening the operating system's
 * date picker inside a form that had already collapsed to five stacked rows —
 * on a phone that is four taps to answer "is tomorrow cheaper?".
 */
function useDayStrip(date: string) {
  return useMemo(() => {
    const today = isoDate(new Date());
    const centre = new Date(date + 'T00:00:00');
    const days: string[] = [];
    for (let i = -2; i <= 4; i++) {
      const d = new Date(centre);
      d.setDate(d.getDate() + i);
      const iso = isoDate(d);
      if (iso >= today) days.push(iso);
    }
    return days.slice(0, 6);
  }, [date]);
}

function Results() {
  const params = useSearchParams();
  const t = useT();
  const { fmt } = useLang();

  const from = params.get('from') ?? 'Dhaka';
  const to = params.get('to') ?? 'Chattogram';
  const date = params.get('date') ?? isoDate(new Date(Date.now() + 864e5));

  const [data, setData] = useState<SearchResponse | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [nonce, setNonce] = useState(0);

  const [sort, setSort] = useState<Sort>('departure');
  const [acOnly, setAcOnly] = useState(false);
  const [operators, setOperators] = useState<string[]>([]);
  const [hideSoldOut, setHideSoldOut] = useState(false);

  const days = useDayStrip(date);

  useEffect(() => {
    setLoading(true);
    setError('');
    api.search(from, to, date)
      .then(setData)
      .catch((e: ApiError) => setError(e.message))
      .finally(() => setLoading(false));
  }, [from, to, date, nonce]);

  const brands = useMemo(
    () => Array.from(new Set(data?.results.map((r) => r.brand) ?? [])).sort(),
    [data]);

  const shown = useMemo(() => {
    let rows = data?.results ?? [];
    if (acOnly) rows = rows.filter((r) => r.is_ac);
    if (operators.length) rows = rows.filter((r) => operators.includes(r.brand));
    if (hideSoldOut) rows = rows.filter((r) => r.available_seats > 0);
    const sorted = [...rows];
    sorted.sort((a, b) => {
      switch (sort) {
        case 'price': return a.fare_poisha - b.fare_poisha;
        case 'duration': return a.duration_min - b.duration_min;
        case 'availability': return b.available_seats - a.available_seats;
        default: return a.depart_at.localeCompare(b.depart_at);
      }
    });
    return sorted;
  }, [data, sort, acOnly, operators, hideSoldOut]);

  const toggleOperator = (b: string) =>
    setOperators((prev) => prev.includes(b) ? prev.filter((x) => x !== b) : [...prev, b]);

  const filtered = acOnly || hideSoldOut || operators.length > 0;
  const clearAll = () => { setAcOnly(false); setHideSoldOut(false); setOperators([]); };

  return (
    <div className="page">
      <div className="container">
        <Stepper current="Search" />

        <div className="card card-pad" style={{ marginBottom: '1rem' }}>
          <SearchForm initialFrom={from} initialTo={to} initialDate={date} compact />
        </div>

        {/* Six days, priced by a tap rather than a date picker. */}
        <nav className="daystrip" aria-label={t('search.otherDays')}>
          {days.map((d) => (
            <Link
              key={d}
              href={`/search?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&date=${d}`}
              className="daystrip-day"
              aria-current={d === date ? 'page' : undefined}
            >
              <span className="ds-label">{fmt.day(d + 'T00:00:00')}</span>
              <span className="ds-date">{fmt.date(d + 'T00:00:00')}</span>
            </Link>
          ))}
        </nav>

        <div className="row-between" style={{ marginBottom: '.9rem' }}>
          <div>
            <h1 style={{ fontSize: '1.35rem' }}>
              {data?.origin ?? from} → {data?.destination ?? to}
            </h1>
            <p className="muted small" style={{ margin: 0 }}>
              {loading
                ? t('search.searching')
                : t('search.showing', { shown: shown.length, total: data?.count ?? 0 })}
            </p>
          </div>

          <div className="field" style={{ minWidth: 190 }}>
            <label className="label" htmlFor="sort">{t('search.sort')}</label>
            <select id="sort" className="select" value={sort} onChange={(e) => setSort(e.target.value as Sort)}>
              <option value="departure">{t('search.sortDeparture')}</option>
              <option value="price">{t('search.sortPrice')}</option>
              <option value="duration">{t('search.sortDuration')}</option>
              <option value="availability">{t('search.sortSeats')}</option>
            </select>
          </div>
        </div>

        {/* Chips, not a wrapped paragraph of native checkboxes. Each one is a
            pressed/unpressed control at touch size, and the set says plainly
            when it is hiding something. */}
        {!loading && !error && (data?.count ?? 0) > 0 && (
          <div className="chipbar" role="group" aria-label={t('search.filters')}>
            <button type="button" className="chip" aria-pressed={acOnly}
                    onClick={() => setAcOnly((v) => !v)}>
              {t('search.acOnly')}
            </button>
            <button type="button" className="chip" aria-pressed={hideSoldOut}
                    onClick={() => setHideSoldOut((v) => !v)}>
              {t('search.hideSoldOut')}
            </button>
            <span className="chip-sep" aria-hidden="true" />
            {brands.map((b) => (
              <button key={b} type="button" className="chip" aria-pressed={operators.includes(b)}
                      onClick={() => toggleOperator(b)}>
                {b}
              </button>
            ))}
            {filtered && (
              <button type="button" className="chip chip-clear" onClick={clearAll}>
                {t('search.clearAll')}
              </button>
            )}
          </div>
        )}

        {loading && <Loading rows={4} />}
        {error && <ErrorNotice message={error} onRetry={() => setNonce((n) => n + 1)} />}

        {!loading && !error && shown.length === 0 && (
          <Empty title={(data?.count ?? 0) > 0 ? t('search.noMatch') : t('search.noResults')}>
            <p className="muted">
              {(data?.count ?? 0) > 0 ? t('search.clearHint') : t('search.nothingToday')}
            </p>
            {(data?.count ?? 0) > 0 && (
              <button className="btn btn-ghost" onClick={clearAll}>{t('search.clearAll')}</button>
            )}
          </Empty>
        )}

        <div className="stack">
          {shown.map((tr) => <TripCard key={tr.trip_id} trip={tr} />)}
        </div>
      </div>
    </div>
  );
}

export default function SearchPage() {
  return (
    <Suspense fallback={<div className="page container"><Loading rows={4} /></div>}>
      <Results />
    </Suspense>
  );
}
