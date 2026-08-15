'use client';

import { Suspense, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { api, ApiError, type SearchResponse } from '@/lib/api';
import { SearchForm } from '@/components/SearchForm';
import { TripCard } from '@/components/TripCard';
import { Empty, ErrorNotice, Loading, Stepper } from '@/components/ui';
import { isoDate, relativeDay } from '@/lib/format';

type Sort = 'departure' | 'price' | 'duration' | 'availability';

function Results() {
  const params = useSearchParams();
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

  return (
    <div className="page">
      <div className="container">
        <Stepper current="Search" />

        <div className="card card-pad" style={{ marginBottom: '1.25rem' }}>
          <SearchForm initialFrom={from} initialTo={to} initialDate={date} compact />
        </div>

        <div className="row-between" style={{ marginBottom: '.9rem' }}>
          <div>
            <h1 style={{ fontSize: '1.35rem' }}>
              {data?.origin ?? from} → {data?.destination ?? to}
            </h1>
            <p className="muted small" style={{ margin: 0 }}>
              {relativeDay(date + 'T00:00:00')} · {loading ? 'searching…' : `${shown.length} of ${data?.count ?? 0} departures`}
            </p>
          </div>

          <div className="field" style={{ minWidth: 190 }}>
            <label className="label" htmlFor="sort">Sort by</label>
            <select id="sort" className="select" value={sort} onChange={(e) => setSort(e.target.value as Sort)}>
              <option value="departure">Departure time</option>
              <option value="price">Price, lowest first</option>
              <option value="duration">Journey time</option>
              <option value="availability">Seats available</option>
            </select>
          </div>
        </div>

        {!loading && !error && (data?.count ?? 0) > 0 && (
          <div className="card card-pad" style={{ marginBottom: '1rem' }}>
            <div className="row" style={{ gap: '1rem' }}>
              <label className="row small" style={{ gap: '.35rem' }}>
                <input type="checkbox" checked={acOnly} onChange={(e) => setAcOnly(e.target.checked)} />
                AC only
              </label>
              <label className="row small" style={{ gap: '.35rem' }}>
                <input type="checkbox" checked={hideSoldOut} onChange={(e) => setHideSoldOut(e.target.checked)} />
                Hide sold out
              </label>
              <span className="small muted">Operator:</span>
              {brands.map((b) => (
                <label key={b} className="row small" style={{ gap: '.3rem' }}>
                  <input type="checkbox" checked={operators.includes(b)} onChange={() => toggleOperator(b)} />
                  {b}
                </label>
              ))}
            </div>
          </div>
        )}

        {loading && <Loading rows={4} />}
        {error && <ErrorNotice message={error} onRetry={() => setNonce((n) => n + 1)} />}

        {!loading && !error && shown.length === 0 && (
          <Empty title="No buses match">
            <p className="muted">
              {(data?.count ?? 0) > 0
                ? 'Try clearing a filter, or pick another date.'
                : 'Nothing is scheduled on this route for that date. Try a different day.'}
            </p>
          </Empty>
        )}

        <div className="stack">
          {shown.map((t) => <TripCard key={t.trip_id} trip={t} />)}
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
