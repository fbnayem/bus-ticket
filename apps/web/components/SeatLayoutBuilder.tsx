'use client';

import { useMemo, useState } from 'react';
import { ApiError } from '@/lib/api';
import { spost } from '@/lib/staff';

// A seat is placed at a physical grid cell on a deck. col_idx includes the aisle
// gaps so the map on the passenger's phone shows the aisle where it really is.
export interface BuilderSeat {
  seat_no: string;
  deck: number;
  row_idx: number;
  col_idx: number;
  seat_type: string;
  fare_class: string;
}

// Every seat type the schema allows, each with a colour and a short label so a
// painted deck reads at a glance. EMPTY is the aisle/gap — a cell with no seat.
const SEAT_TYPES = [
  'NORMAL', 'BUSINESS', 'PREMIUM', 'SLEEPER',
  'FEMALE_RESERVED', 'ACCESSIBLE', 'CREW', 'BLOCKED', 'EMPTY',
] as const;
type SeatType = (typeof SEAT_TYPES)[number];

const TYPE_STYLE: Record<SeatType, { bg: string; fg: string; label: string }> = {
  NORMAL: { bg: 'var(--surface-2, #eef1ec)', fg: 'var(--ink, #10201a)', label: 'Seat' },
  BUSINESS: { bg: '#e7e0f6', fg: '#3d2a7a', label: 'Business' },
  PREMIUM: { bg: '#f6ecd9', fg: '#7a5a1f', label: 'Premium' },
  SLEEPER: { bg: '#dcefe6', fg: '#1f6b4c', label: 'Sleeper' },
  FEMALE_RESERVED: { bg: '#f6d9e6', fg: '#7a1f45', label: 'Women' },
  ACCESSIBLE: { bg: '#d9e8f6', fg: '#1f4c7a', label: 'Accessible' },
  CREW: { bg: '#e8e4dc', fg: '#5a4a2a', label: 'Crew' },
  BLOCKED: { bg: '#e2e2e2', fg: '#666', label: 'Held back' },
  EMPTY: { bg: 'transparent', fg: 'transparent', label: 'Aisle / gap' },
};

// Fare classes a seat can carry. A coach may mix them — the sleeper berths below,
// business seats above — so it is a per-seat brush, not a per-layout setting. The
// default fare class each seat type gets when painted, so the common case needs
// no second choice.
const FARE_CLASSES = ['BASE', 'BUSINESS', 'PREMIUM', 'SLEEPER'] as const;
const DEFAULT_FARE: Record<SeatType, string> = {
  NORMAL: 'BASE', BUSINESS: 'BUSINESS', PREMIUM: 'PREMIUM', SLEEPER: 'SLEEPER',
  FEMALE_RESERVED: 'BASE', ACCESSIBLE: 'BASE', CREW: 'BASE', BLOCKED: 'BASE', EMPTY: 'BASE',
};

const LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ'; // no I/O — they read as 1/0 on a seat

interface CellV { t: SeatType; f: string }

function parsePattern(pattern: string): number[] {
  const groups = pattern.split('+').map((g) => parseInt(g.trim(), 10)).filter((n) => n > 0);
  return groups.length ? groups : [2, 2];
}

interface Props {
  onSaved: () => void;
  onClose: () => void;
}

export default function SeatLayoutBuilder({ onSaved, onClose }: Props) {
  const [name, setName] = useState('');
  const [rows, setRows] = useState(10);
  const [pattern, setPattern] = useState('2+2');
  const [deckCount, setDeckCount] = useState(1);
  const [activeDeck, setActiveDeck] = useState(1);
  // One grid per deck (index = deck-1). null until the deck is generated.
  const [grids, setGrids] = useState<(CellV[][] | null)[]>([null, null]);
  const [seatNos, setSeatNos] = useState<string[][][]>([[], []]);
  const [brushType, setBrushType] = useState<SeatType>('BLOCKED');
  const [brushFare, setBrushFare] = useState('BASE');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const plan = useMemo(() => {
    const groups = parsePattern(pattern);
    const cols: ('seat' | 'aisle')[] = [];
    groups.forEach((g, gi) => {
      for (let i = 0; i < g; i++) cols.push('seat');
      if (gi < groups.length - 1) cols.push('aisle');
    });
    return cols;
  }, [pattern]);

  // Generate (or regenerate) the active deck from the current rows/pattern. Upper
  // deck seats are prefixed 'U' so a seat number is unique across the whole bus.
  function generate() {
    const prefix = activeDeck === 2 ? 'U' : '';
    const g: CellV[][] = [];
    const nos: string[][] = [];
    for (let r = 0; r < rows; r++) {
      const rowCells: CellV[] = [];
      const rowNos: string[] = [];
      let seatInRow = 0;
      for (const kind of plan) {
        if (kind === 'aisle') {
          rowCells.push({ t: 'EMPTY', f: 'BASE' });
          rowNos.push('');
        } else {
          rowCells.push({ t: 'NORMAL', f: 'BASE' });
          rowNos.push(`${prefix}${r + 1}${LETTERS[seatInRow] ?? seatInRow}`);
          seatInRow++;
        }
      }
      g.push(rowCells);
      nos.push(rowNos);
    }
    setGrids((prev) => prev.map((cur, i) => (i === activeDeck - 1 ? g : cur)));
    setSeatNos((prev) => prev.map((cur, i) => (i === activeDeck - 1 ? nos : cur)));
    setError('');
  }

  // Paint the active brush (type + fare class) onto a cell.
  function paint(r: number, c: number) {
    setGrids((prev) => prev.map((grid, i) => {
      if (i !== activeDeck - 1 || !grid) return grid;
      const next = grid.map((row) => row.slice());
      next[r][c] = { t: brushType, f: brushType === 'EMPTY' ? 'BASE' : brushFare };
      return next;
    }));
  }

  const activeGrid = grids[activeDeck - 1];
  const activeNos = seatNos[activeDeck - 1];

  const totalSeats = useMemo(
    () => grids.reduce((sum, g) => sum + (g ? g.flat().filter((c) => c.t !== 'EMPTY').length : 0), 0),
    [grids],
  );

  function setDecks(n: number) {
    setDeckCount(n);
    if (n === 1 && activeDeck === 2) setActiveDeck(1);
  }

  // When a seat type is chosen as the brush, adopt its natural fare class so the
  // common case (paint sleepers → sleeper fare) needs a single choice.
  function chooseType(t: SeatType) {
    setBrushType(t);
    if (t !== 'EMPTY') setBrushFare(DEFAULT_FARE[t]);
  }

  async function save() {
    const seats: BuilderSeat[] = [];
    for (let d = 0; d < deckCount; d++) {
      const grid = grids[d];
      const nos = seatNos[d];
      if (!grid) continue;
      for (let r = 0; r < grid.length; r++) {
        for (let c = 0; c < grid[r].length; c++) {
          const cell = grid[r][c];
          if (cell.t === 'EMPTY') continue;
          seats.push({
            seat_no: nos[r][c], deck: d + 1, row_idx: r, col_idx: c,
            seat_type: cell.t, fare_class: cell.f,
          });
        }
      }
    }
    if (!name.trim()) { setError('Give the layout a name.'); return; }
    if (seats.length === 0) { setError('Generate a deck and add at least one seat.'); return; }
    setBusy(true);
    setError('');
    try {
      await spost('/operator/layouts', { name: name.trim(), decks: deckCount, seats });
      onSaved();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'The layout could not be saved.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="sheet-backdrop" onClick={() => !busy && onClose()}>
      <div className="sheet" role="dialog" aria-modal="true" aria-label="New seat layout"
           style={{ maxWidth: 760 }} onClick={(e) => e.stopPropagation()}>
        <div className="sheet-grip" />
        <div className="stack" style={{ gap: '.9rem', padding: '0 .25rem' }}>
          <h2 style={{ margin: 0 }}>New seat layout</h2>
          <p className="small muted" style={{ margin: 0 }}>
            Set the shape and generate a deck, then pick a seat type and tap seats to
            paint it on. A double-decker gets an upper deck of its own.
          </p>

          <div className="row" style={{ gap: '.6rem', flexWrap: 'wrap', alignItems: 'flex-end' }}>
            <label className="stack" style={{ gap: '.25rem', flex: '2 1 180px' }}>
              <span className="small muted">Name</span>
              <input className="input" value={name} placeholder="e.g. 40-seat AC, 2+2"
                     onChange={(e) => setName(e.target.value)} />
            </label>
            <label className="stack" style={{ gap: '.25rem', width: 84 }}>
              <span className="small muted">Rows</span>
              <input className="input" type="number" min={1} max={30} value={rows}
                     onChange={(e) => setRows(Math.max(1, Math.min(30, +e.target.value || 1)))} />
            </label>
            <label className="stack" style={{ gap: '.25rem', width: 110 }}>
              <span className="small muted">Across</span>
              <select className="select" value={pattern} onChange={(e) => setPattern(e.target.value)}>
                <option value="2+2">2 + 2</option>
                <option value="2+1">2 + 1 (sleeper)</option>
                <option value="1+1">1 + 1</option>
                <option value="3+2">3 + 2</option>
              </select>
            </label>
            <label className="stack" style={{ gap: '.25rem', width: 96 }}>
              <span className="small muted">Decks</span>
              <select className="select" value={deckCount} onChange={(e) => setDecks(+e.target.value)}>
                <option value={1}>Single</option>
                <option value={2}>Double</option>
              </select>
            </label>
            <button className="btn btn-ghost" onClick={generate}>
              {activeGrid ? 'Regenerate deck' : 'Generate deck'}
            </button>
          </div>

          {deckCount === 2 && (
            <div className="row" style={{ gap: '.4rem' }}>
              {[1, 2].map((d) => (
                <button key={d} type="button"
                        className={`btn btn-sm ${activeDeck === d ? 'btn-brand' : 'btn-ghost'}`}
                        onClick={() => setActiveDeck(d)}>
                  {d === 1 ? 'Lower deck' : 'Upper deck'}
                  {grids[d - 1] ? ` · ${grids[d - 1]!.flat().filter((c) => c.t !== 'EMPTY').length}` : ' · empty'}
                </button>
              ))}
            </div>
          )}

          {activeGrid && (
            <>
              {/* Brush palette: seat type + fare class */}
              <div className="stack" style={{ gap: '.4rem', border: '1px solid var(--line)', borderRadius: 10, padding: '.5rem .6rem' }}>
                <div className="row" style={{ gap: '.35rem', flexWrap: 'wrap', alignItems: 'center' }}>
                  <span className="small muted" style={{ marginRight: '.25rem' }}>Paint:</span>
                  {SEAT_TYPES.map((t) => {
                    const st = TYPE_STYLE[t];
                    const on = brushType === t;
                    return (
                      <button key={t} type="button" onClick={() => chooseType(t)}
                              title={st.label}
                              style={{
                                display: 'inline-flex', alignItems: 'center', gap: 5,
                                padding: '.2rem .5rem', borderRadius: 7, cursor: 'pointer', fontSize: 12,
                                border: on ? '2px solid var(--brand, #1f6b4c)' : '1px solid var(--line)',
                                background: t === 'EMPTY' ? 'repeating-linear-gradient(45deg,#fff,#fff 4px,#eee 4px,#eee 8px)' : st.bg,
                                color: st.fg, fontWeight: on ? 700 : 500,
                              }}>
                        {st.label}
                      </button>
                    );
                  })}
                </div>
                <label className="row" style={{ gap: '.4rem', alignItems: 'center' }}>
                  <span className="small muted">Fare class:</span>
                  <select className="select" style={{ width: 150, padding: '.2rem .4rem', fontSize: '.8rem' }}
                          value={brushFare} disabled={brushType === 'EMPTY'}
                          onChange={(e) => setBrushFare(e.target.value)}>
                    {FARE_CLASSES.map((f) => <option key={f} value={f}>{f.toLowerCase()}</option>)}
                  </select>
                  <span className="small muted">
                    priced by the route fare table for this class
                  </span>
                </label>
              </div>

              <div style={{ overflowX: 'auto', padding: '.25rem', border: '1px solid var(--line)', borderRadius: 12 }}>
                <div style={{ display: 'inline-flex', flexDirection: 'column', gap: 6 }}>
                  {activeGrid.map((row, r) => (
                    <div key={r} style={{ display: 'flex', gap: 6 }}>
                      {row.map((cell, c) => {
                        const st = TYPE_STYLE[cell.t];
                        if (cell.t === 'EMPTY') {
                          return (
                            <button key={c} type="button" onClick={() => paint(r, c)}
                                    title="Aisle / gap (tap to paint)"
                                    style={{ width: 30, height: 34, border: '1px dashed var(--line)', borderRadius: 6, background: 'transparent', cursor: 'pointer' }}
                                    aria-label="empty cell" />
                          );
                        }
                        return (
                          <button key={c} type="button" onClick={() => paint(r, c)}
                                  title={`${activeNos[r][c]} — ${st.label} · ${cell.f.toLowerCase()} (tap to paint)`}
                                  style={{
                                    width: 42, height: 36, borderRadius: 7, cursor: 'pointer',
                                    border: '1px solid var(--line)', background: st.bg, color: st.fg,
                                    fontSize: 11, fontWeight: 600, lineHeight: 1.1,
                                    display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
                                  }}>
                            <span>{activeNos[r][c]}</span>
                            {cell.f !== 'BASE' && <span style={{ fontSize: 8, opacity: .8 }}>{cell.f[0]}</span>}
                          </button>
                        );
                      })}
                    </div>
                  ))}
                </div>
              </div>

              <div className="row small muted" style={{ gap: '1rem', flexWrap: 'wrap' }}>
                {(['NORMAL', 'BUSINESS', 'SLEEPER', 'FEMALE_RESERVED', 'ACCESSIBLE', 'BLOCKED'] as SeatType[]).map((k) => (
                  <span key={k} className="row" style={{ gap: '.35rem', alignItems: 'center' }}>
                    <span style={{ width: 14, height: 14, borderRadius: 4, background: TYPE_STYLE[k].bg, border: '1px solid var(--line)' }} />
                    {TYPE_STYLE[k].label}
                  </span>
                ))}
                <strong style={{ color: 'var(--ink)' }}>{totalSeats} seats total</strong>
              </div>
            </>
          )}

          {error && <p className="small" style={{ color: 'var(--danger, #b3261e)' }}>{error}</p>}

          <div className="row" style={{ gap: '.5rem', justifyContent: 'flex-end' }}>
            <button className="btn btn-ghost" disabled={busy} onClick={onClose}>Cancel</button>
            <button className="btn btn-brand" disabled={busy || totalSeats === 0} onClick={save}>
              {busy ? 'Saving…' : `Save ${totalSeats} seats`}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
