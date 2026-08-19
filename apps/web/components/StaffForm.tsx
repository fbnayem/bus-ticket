'use client';

import { useState } from 'react';
import { ApiError } from '@/lib/api';
import { spost, staffCall } from '@/lib/staff';

export interface RoleOpt { role_id: string; role_key: string }
export interface Person {
  staff_id: string; full_name: string; email: string; phone: string;
  status: string; roles: string;
}

interface Props {
  roles: RoleOpt[];
  person?: Person;      // present = edit mode
  onSaved: () => void;
  onClose: () => void;
}

// One form for both hiring and editing. On create it takes an email and an
// initial password; on edit it changes name, phone, status and the role set —
// but never the email or password, which are the person's own to change.
export default function StaffForm({ roles, person, onSaved, onClose }: Props) {
  const editing = !!person;
  const [email, setEmail] = useState(person?.email ?? '');
  const [fullName, setFullName] = useState(person?.full_name ?? '');
  const [phone, setPhone] = useState(person?.phone ?? '');
  const [password, setPassword] = useState('');
  const [status, setStatus] = useState(person?.status ?? 'ACTIVE');
  const [chosen, setChosen] = useState<Set<string>>(
    new Set((person?.roles ?? '').split(', ').map((r) => r.trim()).filter(Boolean)),
  );
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  function toggle(key: string) {
    const next = new Set(chosen);
    if (next.has(key)) next.delete(key); else next.add(key);
    setChosen(next);
  }

  async function save() {
    const roleList = [...chosen];
    if (!editing) {
      if (!email.includes('@')) { setError('Enter a valid email.'); return; }
      if (!fullName.trim()) { setError('Enter their name.'); return; }
      if (password.length < 8) { setError('The password must be at least 8 characters.'); return; }
      if (roleList.length === 0) { setError('Give them at least one role.'); return; }
    }
    setBusy(true); setError('');
    try {
      if (editing) {
        await staffCall(`/operator/staff/${person!.staff_id}`, {
          method: 'PATCH',
          body: { full_name: fullName, phone, status, roles: roleList },
        });
      } else {
        await spost('/operator/staff', {
          email: email.trim(), full_name: fullName.trim(), phone, password, roles: roleList,
        });
      }
      onSaved();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'The account could not be saved.');
    } finally { setBusy(false); }
  }

  return (
    <div className="sheet-backdrop" onClick={() => !busy && onClose()}>
      <div className="sheet" role="dialog" aria-modal="true" aria-label={editing ? 'Edit staff' : 'New staff'}
           onClick={(e) => e.stopPropagation()}>
        <div className="sheet-grip" />
        <div className="stack" style={{ gap: '.9rem', padding: '0 .25rem' }}>
          <h2 style={{ margin: 0 }}>{editing ? 'Edit account' : 'New staff account'}</h2>

          <label className="stack" style={{ gap: '.25rem' }}>
            <span className="small muted">Email {editing && '(fixed)'}</span>
            <input className="input" value={email} disabled={editing}
                   onChange={(e) => setEmail(e.target.value)} placeholder="name@company.test" />
          </label>
          <div className="row" style={{ gap: '.6rem' }}>
            <label className="stack" style={{ gap: '.25rem', flex: 2 }}>
              <span className="small muted">Full name</span>
              <input className="input" value={fullName} onChange={(e) => setFullName(e.target.value)} />
            </label>
            <label className="stack" style={{ gap: '.25rem', flex: 1 }}>
              <span className="small muted">Phone</span>
              <input className="input" value={phone} onChange={(e) => setPhone(e.target.value)} />
            </label>
          </div>

          {!editing && (
            <label className="stack" style={{ gap: '.25rem' }}>
              <span className="small muted">Initial password</span>
              <input className="input" type="text" value={password}
                     onChange={(e) => setPassword(e.target.value)}
                     placeholder="They should change it on first sign-in" />
            </label>
          )}

          {editing && (
            <label className="stack" style={{ gap: '.25rem' }}>
              <span className="small muted">Status</span>
              <select className="select" value={status} onChange={(e) => setStatus(e.target.value)}>
                <option value="ACTIVE">Active</option>
                <option value="SUSPENDED">Suspended — cannot sign in</option>
              </select>
            </label>
          )}

          <div className="stack" style={{ gap: '.3rem' }}>
            <span className="small muted">Roles</span>
            <div className="row" style={{ gap: '.3rem', flexWrap: 'wrap' }}>
              {roles.map((r) => (
                <button key={r.role_id} type="button"
                        className={`btn btn-sm ${chosen.has(r.role_key) ? 'btn-brand' : 'btn-ghost'}`}
                        onClick={() => toggle(r.role_key)}>
                  {r.role_key.replace(/_/g, ' ').toLowerCase()}
                </button>
              ))}
            </div>
          </div>

          {error && <p className="small" style={{ color: 'var(--danger, #b3261e)' }}>{error}</p>}
          <div className="row" style={{ gap: '.5rem', justifyContent: 'flex-end' }}>
            <button className="btn btn-ghost" disabled={busy} onClick={onClose}>Cancel</button>
            <button className="btn btn-brand" disabled={busy} onClick={save}>
              {busy ? 'Saving…' : editing ? 'Save changes' : 'Create account'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
