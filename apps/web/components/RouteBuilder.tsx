'use client';

import { useEffect, useRef, useState } from 'react';
import { ApiError } from '@/lib/api';
import { sget, spost } from '@/lib/staff';

interface Loc { id: string; name: string; name_bn: string; kind: string; parent: string; served: boolean }
interface Stop { location_id: string; name: string; is_boarding: boolean; is_dropping: boolean }

interface Props {
  onSaved: () => void;
  onClose: () => void;
}

// Build a route as an ordered list of stops. The order is the route — stop 0 is
// where the bus starts, the last stop is where it ends, and every stop in
// between can be a boarding or dropping point that a passenger buys a leg
// against.
export default function RouteBuilder({ onSaved, onClose }: Props) {
  const [name, setName] = useState('');
  const [stops, setStops] = useState<Stop[]>([]);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<Loc[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (debounce.current) clearTimeout(debounce.current);
    if (query.trim().length < 2) { setResults([]); return; }
    debounce.current = setTimeout(() => {
      sget<{ locations: Loc[] }>(`/locations?q=${encodeURIComponent(query.trim())}&limit=8`)
        .then((r) => setResults(r.locations))
        .catch(() => setResults([]));
    }, 200);
    return () => { if (debounce.current) clearTimeout(debounce.current); };
  }, [query]);

  function addStop(l: Loc) {
    if (stops.some((s) => s.location_id === l.id)) return;
    setStops([...stops, { location_id: l.id, name: l.name, is_boarding: true, is_dropping: true }]);
    setQuery('');
    setResults([]);
  }
  function removeStop(i: number) { setStops(stops.filter((_, j) => j !== i)); }
  function move(i: number, d: -1 | 1) {
    const j = i + d;
    if (j < 0 || j >= stops.length) return;
    const next = stops.slice();
    [next[i], next[j]] = [next[j], next[i]];
    setStops(next);
  }
  function toggle(i: number, key: 'is_boarding' | 'is_dropping') {
    setStops(stops.map((s, j) => (j === i ? { ...s, [key]: !s[key] } : s)));
  }

  async function save() {
    if (!name.trim()) { setError('Give the route a name.'); return; }
    if (stops.length < 2) { setError('A route needs at least a start and an end.'); return; }
    setBusy(true); setError('');
    try {
      await spost('/operator/routes', {
        name: name.trim(),
        stops: stops.map((s) => ({
          location_id: s.location_id, is_boarding: s.is_boarding, is_dropping: s.is_dropping,
        })),
      });
      onSaved();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'The route could not be saved.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="sheet-backdrop" onClick={() => !busy && onClose()}>
      <div className="sheet" role="dialog" aria-modal="true" aria-label="New route"
           onClick={(e) => e.stopPropagation()}>
        <div className="sheet-grip" />
        <div className="stack" style={{ gap: '.9rem', padding: '0 .25rem' }}>
          <h2 style={{ margin: 0 }}>New route</h2>

          <label className="stack" style={{ gap: '.25rem' }}>
            <span className="small muted">Name</span>
            <input className="input" value={name} placeholder="e.g. Dhaka → Chattogram"
                   onChange={(e) => setName(e.target.value)} />
          </label>

          {stops.length > 0 && (
            <ol className="stack" style={{ gap: '.4rem', margin: 0, paddingLeft: 0, listStyle: 'none' }}>
              {stops.map((s, i) => (
                <li key={s.location_id} className="row"
                    style={{ gap: '.5rem', alignItems: 'center', border: '1px solid var(--line)', borderRadius: 10, padding: '.5rem .6rem' }}>
                  <span className="mono small muted" style={{ width: 22 }}>{i + 1}</span>
                  <strong style={{ flex: 1 }}>{s.name}</strong>
                  <button type="button" className={`btn btn-sm ${s.is_boarding ? 'btn-brand' : 'btn-ghost'}`}
                          title="Passengers may board here" onClick={() => toggle(i, 'is_boarding')}>Board</button>
                  <button type="button" className={`btn btn-sm ${s.is_dropping ? 'btn-brand' : 'btn-ghost'}`}
                          title="Passengers may get off here" onClick={() => toggle(i, 'is_dropping')}>Drop</button>
                  <button type="button" className="btn btn-sm btn-ghost" disabled={i === 0}
                          onClick={() => move(i, -1)} aria-label="Move up">↑</button>
                  <button type="button" className="btn btn-sm btn-ghost" disabled={i === stops.length - 1}
                          onClick={() => move(i, 1)} aria-label="Move down">↓</button>
                  <button type="button" className="btn btn-sm btn-ghost" onClick={() => removeStop(i)}
                          aria-label="Remove stop">✕</button>
                </li>
              ))}
            </ol>
          )}

          <div style={{ position: 'relative' }}>
            <input className="input" value={query} placeholder="Add a stop — search a city or terminal"
                   onChange={(e) => setQuery(e.target.value)} />
            {results.length > 0 && (
              <div className="card" style={{ position: 'absolute', top: '100%', left: 0, right: 0, zIndex: 5, marginTop: 4, maxHeight: 240, overflowY: 'auto' }}>
                {results.map((l) => (
                  <button key={l.id} type="button" className="btn btn-ghost"
                          style={{ display: 'block', width: '100%', textAlign: 'left', borderRadius: 0 }}
                          onClick={() => addStop(l)}>
                    {l.name} <span className="small muted">{l.name_bn} · {l.kind.toLowerCase()}</span>
                  </button>
                ))}
              </div>
            )}
          </div>

          {error && <p className="small" style={{ color: 'var(--danger, #b3261e)' }}>{error}</p>}

          <div className="row" style={{ gap: '.5rem', justifyContent: 'flex-end' }}>
            <button className="btn btn-ghost" disabled={busy} onClick={onClose}>Cancel</button>
            <button className="btn btn-brand" disabled={busy || stops.length < 2} onClick={save}>
              {busy ? 'Saving…' : `Save route (${stops.length} stops)`}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
