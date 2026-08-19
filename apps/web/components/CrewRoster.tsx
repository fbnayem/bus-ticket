'use client';

import { useCallback, useEffect, useState } from 'react';
import { ApiError } from '@/lib/api';
import { sget, spost, staffCall } from '@/lib/staff';

interface CrewMember { staff_id: string; full_name: string; crew_role: string }
interface StaffRow { staff_id: string; full_name: string; status: string }

const ROLES = ['DRIVER', 'HELPER', 'SUPERVISOR'];

interface Props {
  tripID: string;
  label: string;      // route + time, for the header
  onClose: () => void;
  onChanged: () => void;
}

// Who is on this bus. The crew role here is the job on this trip — a person may
// drive one run and supervise another — independent of the roles on their
// account.
export default function CrewRoster({ tripID, label, onClose, onChanged }: Props) {
  const [crew, setCrew] = useState<CrewMember[]>([]);
  const [staff, setStaff] = useState<StaffRow[]>([]);
  const [pick, setPick] = useState('');
  const [role, setRole] = useState('DRIVER');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    Promise.all([
      sget<{ crew: CrewMember[] }>(`/operator/trips/${tripID}/crew`),
      sget<{ staff: StaffRow[] }>('/operator/staff'),
    ])
      .then(([c, s]) => {
        setCrew(c.crew);
        setStaff(s.staff.filter((x) => x.status === 'ACTIVE'));
        setPick((p) => p || s.staff[0]?.staff_id || '');
      })
      .catch((e: ApiError) => setError(e.message));
  }, [tripID]);

  useEffect(() => { load(); }, [load]);

  async function add() {
    if (!pick) return;
    setBusy(true); setError('');
    try {
      await spost(`/operator/trips/${tripID}/crew`, { staff_id: pick, crew_role: role });
      load(); onChanged();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not assign that person.');
    } finally { setBusy(false); }
  }

  async function remove(staffID: string) {
    setBusy(true); setError('');
    try {
      await staffCall(`/operator/trips/${tripID}/crew/${staffID}`, { method: 'DELETE' });
      load(); onChanged();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not remove that person.');
    } finally { setBusy(false); }
  }

  const onboard = new Set(crew.map((c) => c.staff_id));
  const available = staff.filter((s) => !onboard.has(s.staff_id));

  return (
    <div className="sheet-backdrop" onClick={() => !busy && onClose()}>
      <div className="sheet" role="dialog" aria-modal="true" aria-label="Trip crew"
           onClick={(e) => e.stopPropagation()}>
        <div className="sheet-grip" />
        <div className="stack" style={{ gap: '.9rem', padding: '0 .25rem' }}>
          <h2 style={{ margin: 0 }}>Crew</h2>
          <p className="small muted" style={{ margin: 0 }}>{label}</p>

          {crew.length === 0
            ? <p className="small muted">Nobody rostered yet.</p>
            : (
              <ul className="stack" style={{ gap: '.4rem', margin: 0, padding: 0, listStyle: 'none' }}>
                {crew.map((c) => (
                  <li key={c.staff_id} className="row"
                      style={{ gap: '.5rem', alignItems: 'center', border: '1px solid var(--line)', borderRadius: 10, padding: '.45rem .6rem' }}>
                    <strong style={{ flex: 1 }}>{c.full_name}</strong>
                    <span className="pill pill-brand" style={{ fontSize: '.68rem' }}>{c.crew_role.toLowerCase()}</span>
                    <button className="btn btn-sm btn-ghost" disabled={busy}
                            onClick={() => remove(c.staff_id)} aria-label="Remove">✕</button>
                  </li>
                ))}
              </ul>
            )}

          <div className="row" style={{ gap: '.5rem', alignItems: 'flex-end', flexWrap: 'wrap' }}>
            <label className="stack" style={{ gap: '.25rem', flex: 2, minWidth: 160 }}>
              <span className="small muted">Add someone</span>
              <select className="select" value={pick} onChange={(e) => setPick(e.target.value)}>
                {available.map((s) => <option key={s.staff_id} value={s.staff_id}>{s.full_name}</option>)}
                {available.length === 0 && <option value="">Everyone is already on board</option>}
              </select>
            </label>
            <label className="stack" style={{ gap: '.25rem', width: 140 }}>
              <span className="small muted">As</span>
              <select className="select" value={role} onChange={(e) => setRole(e.target.value)}>
                {ROLES.map((r) => <option key={r} value={r}>{r.toLowerCase()}</option>)}
              </select>
            </label>
            <button className="btn btn-brand" disabled={busy || !pick} onClick={add}>Add</button>
          </div>

          {error && <p className="small" style={{ color: 'var(--danger, #b3261e)' }}>{error}</p>}
          <div className="row" style={{ justifyContent: 'flex-end' }}>
            <button className="btn btn-ghost" disabled={busy} onClick={onClose}>Done</button>
          </div>
        </div>
      </div>
    </div>
  );
}
