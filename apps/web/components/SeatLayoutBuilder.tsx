'use client';

import { useMemo, useState } from 'react';
import { ApiError } from '@/lib/api';
import { spost } from '@/lib/staff';

// A seat is placed at a physical grid cell. col_idx includes the aisle gaps so
// the map on the passenger's phone shows the aisle where the aisle really is.
export interface BuilderSeat {
  seat_no: string;
  row_idx: number;
  col_idx: number;
  seat_type: string;
  fare_class: string;
}

// The seat types an operator actually assigns while shaping a deck. SLEEPER,
// PREMIUM, BUSINESS and CREW exist in the schema too, but a first layout is
// overwhelmingly these four; the cycle stays short so a tap is predictable.
const CYCLE = ['NORMAL', 'FEMALE_RESERVED', 'ACCESSIBLE', 'BLOCKED', 'EMPTY'] as const;
type Cell = (typeof CYCLE)[number];

const CELL_STYLE: Record<Cell, { bg: string; fg: string; label: string }> = {
  NORMAL: { bg: 'var(--surface-2, #eef1ec)', fg: 'var(--ink, #10201a)', label: 'Seat' },
  FEMALE_RESERVED: { bg: '#f6d9e6', fg: '#7a1f45', label: 'Women' },
  ACCESSIBLE: { bg: '#d9e8f6', fg: '#1f4c7a', label: 'Accessible' },
  BLOCKED: { bg: '#e2e2e2', fg: '#666', label: 'Held back' },
  EMPTY: { bg: 'transparent', fg: 'transparent', label: 'Aisle / gap' },
};

const LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ'; // no I/O — they read as 1/0 on a seat

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
  const [grid, setGrid] = useState<Cell[][] | null>(null);
  const [seatNos, setSeatNos] = useState<string[][]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  // The physical column plan: seat columns interleaved with a single aisle
  // column between each group. width is the total grid columns.
  const plan = useMemo(() => {
    const groups = parsePattern(pattern);
    const cols: ('seat' | 'aisle')[] = [];
    groups.forEach((g, gi) => {
      for (let i = 0; i < g; i++) cols.push('seat');
      if (gi < groups.length - 1) cols.push('aisle');
    });
    return cols;
  }, [pattern]);

  function generate() {
    const g: Cell[][] = [];
    const nos: string[][] = [];
    for (let r = 0; r < rows; r++) {
      const rowCells: Cell[] = [];
      const rowNos: string[] = [];
      let seatInRow = 0;
      for (const kind of plan) {
        if (kind === 'aisle') {
          rowCells.push('EMPTY');
          rowNos.push('');
        } else {
          rowCells.push('NORMAL');
          rowNos.push(`${r + 1}${LETTERS[seatInRow] ?? seatInRow}`);
          seatInRow++;
        }
      }
      g.push(rowCells);
      nos.push(rowNos);
    }
    setGrid(g);
    setSeatNos(nos);
    setError('');
  }

  function cycle(r: number, c: number) {
    if (!grid) return;
    const next = grid.map((row) => row.slice());
    const cur = next[r][c];
    next[r][c] = CYCLE[(CYCLE.indexOf(cur) + 1) % CYCLE.length];
    setGrid(next);
  }

  const seatCount = useMemo(
    () => (grid ? grid.flat().filter((c) => c !== 'EMPTY').length : 0),
    [grid],
  );

  async function save() {
    if (!grid) return;
    const seats: BuilderSeat[] = [];
    for (let r = 0; r < grid.length; r++) {
      for (let c = 0; c < grid[r].length; c++) {
        const cell = grid[r][c];
        if (cell === 'EMPTY') continue;
        seats.push({
          seat_no: seatNos[r][c],
          row_idx: r,
          col_idx: c,
          seat_type: cell,
          fare_class: 'BASE',
        });
      }
    }
    if (!name.trim()) { setError('Give the layout a name.'); return; }
    if (seats.length === 0) { setError('Add at least one seat.'); return; }
    setBusy(true);
    setError('');
    try {
      await spost('/operator/layouts', { name: name.trim(), decks: 1, seats });
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
           style={{ maxWidth: 720 }} onClick={(e) => e.stopPropagation()}>
        <div className="sheet-grip" />
        <div className="stack" style={{ gap: '.9rem', padding: '0 .25rem' }}>
          <h2 style={{ margin: 0 }}>New seat layout</h2>
          <p className="small muted" style={{ margin: 0 }}>
            Set the shape, then tap any seat to mark it for women, accessible, or held
            back. A tap cycles through those and an aisle gap.
          </p>

          <div className="row" style={{ gap: '.6rem', flexWrap: 'wrap', alignItems: 'flex-end' }}>
            <label className="stack" style={{ gap: '.25rem', flex: '2 1 200px' }}>
              <span className="small muted">Name</span>
              <input className="input" value={name} placeholder="e.g. 40-seat AC, 2+2"
                     onChange={(e) => setName(e.target.value)} />
            </label>
            <label className="stack" style={{ gap: '.25rem', width: 90 }}>
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
            <button className="btn btn-ghost" onClick={generate}>Generate</button>
          </div>

          {grid && (
            <>
              <div style={{ overflowX: 'auto', padding: '.25rem', border: '1px solid var(--line)', borderRadius: 12 }}>
                <div style={{ display: 'inline-flex', flexDirection: 'column', gap: 6 }}>
                  {grid.map((row, r) => (
                    <div key={r} style={{ display: 'flex', gap: 6 }}>
                      {row.map((cell, c) => {
                        const st = CELL_STYLE[cell];
                        if (cell === 'EMPTY') {
                          return <div key={c} style={{ width: 30 }} aria-hidden />;
                        }
                        return (
                          <button key={c} type="button" onClick={() => cycle(r, c)}
                                  title={`${seatNos[r][c]} — ${st.label} (tap to change)`}
                                  style={{
                                    width: 40, height: 34, borderRadius: 7, cursor: 'pointer',
                                    border: '1px solid var(--line)', background: st.bg, color: st.fg,
                                    fontSize: 11, fontWeight: 600,
                                  }}>
                            {seatNos[r][c]}
                          </button>
                        );
                      })}
                    </div>
                  ))}
                </div>
              </div>

              <div className="row small muted" style={{ gap: '1rem', flexWrap: 'wrap' }}>
                {(['NORMAL', 'FEMALE_RESERVED', 'ACCESSIBLE', 'BLOCKED'] as Cell[]).map((k) => (
                  <span key={k} className="row" style={{ gap: '.35rem', alignItems: 'center' }}>
                    <span style={{ width: 14, height: 14, borderRadius: 4, background: CELL_STYLE[k].bg, border: '1px solid var(--line)' }} />
                    {CELL_STYLE[k].label}
                  </span>
                ))}
                <strong style={{ color: 'var(--ink)' }}>{seatCount} seats</strong>
              </div>
            </>
          )}

          {error && <p className="small" style={{ color: 'var(--danger, #b3261e)' }}>{error}</p>}

          <div className="row" style={{ gap: '.5rem', justifyContent: 'flex-end' }}>
            <button className="btn btn-ghost" disabled={busy} onClick={onClose}>Cancel</button>
            <button className="btn btn-brand" disabled={busy || !grid || seatCount === 0} onClick={save}>
              {busy ? 'Saving…' : `Save ${seatCount} seats`}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
