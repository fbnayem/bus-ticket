'use client';

import { useCallback, useEffect, useState } from 'react';
import { ApiError } from '@/lib/api';
import { sget, spost, staffCall, can } from '@/lib/staff';
import { useSession } from '@/components/StaffShell';
import { ErrorNotice, Loading } from '@/components/ui';
import { PageHead, Money } from '@/components/staff-ui';
import { dateOf } from '@/lib/format';

interface Operator {
  operator_id: string; brand: string; legal_name: string; status: string;
  created_at: string; vat_bin: string; vat_rate_bp: number;
  buses: number; routes: number; counters: number; gmv_poisha: number;
}

const STATUSES = ['PENDING', 'ACTIVE', 'SUSPENDED', 'BLOCKED', 'TERMINATED'];

export default function AdminOperatorsPage() {
  const session = useSession();
  const [rows, setRows] = useState<Operator[]>([]);
  const [error, setError] = useState('');
  const [flash, setFlash] = useState('');
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<Operator | null>(null);

  const load = useCallback(() => {
    sget<{ operators: Operator[] }>('/admin/operators')
      .then((r) => setRows(r.operators))
      .catch((e: ApiError) => setError(e.message))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { load(); }, [load]);

  const setStatus = async (o: Operator, status: string) => {
    setError('');
    try {
      await spost(`/admin/operators/${o.operator_id}/status`, { status });
      setFlash(
        status === 'ACTIVE'
          ? `${o.brand} can sell again.`
          : `${o.brand} is now ${status.toLowerCase()}. Existing tickets are unaffected.`);
      load();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'The status could not be changed.');
    }
  };

  const mayWrite = can(session?.identity ?? null, 'operator.write');

  if (loading) return <Loading rows={2} />;

  return (
    <div className="stack">
      <PageHead
        title="Operators"
        sub="Bus companies selling on the platform"
        actions={mayWrite ? <button className="btn btn-brand" onClick={() => setCreating(true)}>New operator</button> : undefined}
      />
      {error && <ErrorNotice message={error} />}
      {flash && <div className="notice notice-info">{flash}</div>}

      <div className="table-wrap">
        <table className="data">
          <thead>
            <tr>
              <th>Brand</th><th>Legal name</th><th>VAT</th><th className="num">Buses</th>
              <th className="num">Routes</th><th className="num">Counters</th>
              <th className="num">Gross sales</th><th>Joined</th><th>Status</th>
              {mayWrite && <th />}
            </tr>
          </thead>
          <tbody>
            {rows.map((o) => (
              <tr key={o.operator_id}>
                <td><strong>{o.brand}</strong></td>
                <td className="muted small">{o.legal_name}</td>
                <td className="muted small">
                  {o.vat_bin
                    ? <>{o.vat_bin} <span className="pill pill-brand" style={{ marginLeft: 4 }}>{(o.vat_rate_bp / 100).toFixed(o.vat_rate_bp % 100 ? 2 : 0)}%</span></>
                    : <span className="muted">—</span>}
                </td>
                <td className="num">{o.buses}</td>
                <td className="num">{o.routes}</td>
                <td className="num">{o.counters}</td>
                <td className="num"><Money poisha={o.gmv_poisha} /></td>
                <td className="muted small">{dateOf(o.created_at)}</td>
                <td>
                  <span className={`pill ${o.status === 'ACTIVE' ? 'pill-ok' : o.status === 'PENDING' ? 'pill-warn' : 'pill-danger'}`}>
                    {o.status.toLowerCase()}
                  </span>
                </td>
                {mayWrite && (
                  <td>
                    <div className="row" style={{ gap: '.35rem' }}>
                      <select className="select" style={{ width: 120, padding: '.25rem .4rem', fontSize: '.8rem' }}
                              value={o.status} onChange={(e) => setStatus(o, e.target.value)}
                              aria-label={`Status for ${o.brand}`}>
                        {STATUSES.map((s) => <option key={s} value={s}>{s.toLowerCase()}</option>)}
                      </select>
                      <button className="btn btn-ghost btn-sm" onClick={() => setEditing(o)}>Edit</button>
                    </div>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <p className="small muted">
        A new operator starts <strong>pending</strong>: its owner can sign in and set up
        fleet, routes and fares, but it cannot sell a seat until you move it to
        <strong> active</strong>. Suspending an operator stops new sales but never
        invalidates a ticket a passenger already holds.
      </p>

      {creating && (
        <NewOperatorSheet
          onClose={() => setCreating(false)}
          onSaved={(brand, email) => {
            setCreating(false);
            setFlash(`${brand} onboarded (pending). Owner signs in as ${email}. Move to active when they're ready to sell.`);
            load();
          }}
        />
      )}
      {editing && (
        <EditOperatorSheet
          op={editing}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); setFlash('Operator details updated.'); load(); }}
        />
      )}
    </div>
  );
}

// ---- New operator: the tenant record + its first owner login, in one action ---

function NewOperatorSheet({ onClose, onSaved }: { onClose: () => void; onSaved: (brand: string, email: string) => void }) {
  const [legalName, setLegalName] = useState('');
  const [brand, setBrand] = useState('');
  const [vatBin, setVatBin] = useState('');
  const [vatPct, setVatPct] = useState('');
  const [email, setEmail] = useState('');
  const [fullName, setFullName] = useState('');
  const [phone, setPhone] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function save() {
    if (!legalName.trim() || !brand.trim()) { setError('A legal name and a brand are required.'); return; }
    if (!email.includes('@')) { setError('Enter a valid owner email.'); return; }
    if (!fullName.trim()) { setError("Enter the owner's name."); return; }
    if (password.length < 8) { setError('The owner password must be at least 8 characters.'); return; }
    setBusy(true); setError('');
    try {
      await spost('/admin/operators', {
        legal_name: legalName.trim(),
        brand: brand.trim(),
        vat_bin: vatBin.trim(),
        vat_rate_bp: vatPct ? Math.round(Number(vatPct) * 100) : 0,
        owner: { email: email.trim().toLowerCase(), full_name: fullName.trim(), phone: phone.trim(), password },
      });
      onSaved(brand.trim(), email.trim().toLowerCase());
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'The operator could not be created.');
    } finally { setBusy(false); }
  }

  return (
    <div className="sheet-backdrop" onClick={() => !busy && onClose()}>
      <div className="sheet" role="dialog" aria-modal="true" aria-label="New operator"
           style={{ maxWidth: 560 }} onClick={(e) => e.stopPropagation()}>
        <div className="sheet-grip" />
        <div className="stack" style={{ gap: '.9rem', padding: '0 .25rem' }}>
          <h2 style={{ margin: 0 }}>Onboard an operator</h2>
          <p className="small muted" style={{ margin: 0 }}>
            Creates the company and its first owner login together. The operator starts
            pending — it can be set up but cannot sell until you activate it.
          </p>

          <fieldset className="stack" style={{ gap: '.6rem', border: '1px solid var(--line)', borderRadius: 12, padding: '.75rem' }}>
            <legend className="small muted" style={{ padding: '0 .35rem' }}>Company</legend>
            <label className="stack" style={{ gap: '.25rem' }}>
              <span className="small muted">Legal name</span>
              <input className="input" value={legalName} placeholder="Green Line Paribahan Ltd."
                     onChange={(e) => setLegalName(e.target.value)} />
            </label>
            <label className="stack" style={{ gap: '.25rem' }}>
              <span className="small muted">Brand</span>
              <input className="input" value={brand} placeholder="Green Line"
                     onChange={(e) => setBrand(e.target.value)} />
            </label>
            <div className="row" style={{ gap: '.6rem' }}>
              <label className="stack" style={{ gap: '.25rem', flex: '2 1 200px' }}>
                <span className="small muted">VAT BIN (optional)</span>
                <input className="input" value={vatBin} placeholder="000123456-0201"
                       onChange={(e) => setVatBin(e.target.value)} />
              </label>
              <label className="stack" style={{ gap: '.25rem', width: 120 }}>
                <span className="small muted">VAT rate %</span>
                <input className="input tnum" type="number" min={0} max={100} step="0.01" value={vatPct}
                       placeholder="15" onChange={(e) => setVatPct(e.target.value)} />
              </label>
            </div>
          </fieldset>

          <fieldset className="stack" style={{ gap: '.6rem', border: '1px solid var(--line)', borderRadius: 12, padding: '.75rem' }}>
            <legend className="small muted" style={{ padding: '0 .35rem' }}>Owner login</legend>
            <label className="stack" style={{ gap: '.25rem' }}>
              <span className="small muted">Full name</span>
              <input className="input" value={fullName} onChange={(e) => setFullName(e.target.value)} />
            </label>
            <div className="row" style={{ gap: '.6rem' }}>
              <label className="stack" style={{ gap: '.25rem', flex: '2 1 200px' }}>
                <span className="small muted">Email</span>
                <input className="input" type="email" value={email} autoComplete="off"
                       onChange={(e) => setEmail(e.target.value)} />
              </label>
              <label className="stack" style={{ gap: '.25rem', width: 150 }}>
                <span className="small muted">Phone</span>
                <input className="input" value={phone} onChange={(e) => setPhone(e.target.value)} />
              </label>
            </div>
            <label className="stack" style={{ gap: '.25rem' }}>
              <span className="small muted">Temporary password</span>
              <input className="input" type="text" value={password} autoComplete="off"
                     placeholder="at least 8 characters" onChange={(e) => setPassword(e.target.value)} />
            </label>
          </fieldset>

          {error && <p className="small" style={{ color: 'var(--danger, #b3261e)' }}>{error}</p>}

          <div className="row" style={{ gap: '.5rem', justifyContent: 'flex-end' }}>
            <button className="btn btn-ghost" disabled={busy} onClick={onClose}>Cancel</button>
            <button className="btn btn-brand" disabled={busy} onClick={save}>
              {busy ? 'Creating…' : 'Onboard operator'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ---- Edit identity / VAT (platform-governed, not self-service) ----------------

function EditOperatorSheet({ op, onClose, onSaved }: { op: Operator; onClose: () => void; onSaved: () => void }) {
  const [legalName, setLegalName] = useState(op.legal_name);
  const [brand, setBrand] = useState(op.brand);
  const [vatBin, setVatBin] = useState(op.vat_bin);
  const [vatPct, setVatPct] = useState(op.vat_rate_bp ? String(op.vat_rate_bp / 100) : '');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function save() {
    if (!legalName.trim() || !brand.trim()) { setError('Legal name and brand cannot be blank.'); return; }
    setBusy(true); setError('');
    try {
      await staffCall(`/admin/operators/${op.operator_id}`, {
        method: 'PATCH',
        body: {
          legal_name: legalName.trim(),
          brand: brand.trim(),
          vat_bin: vatBin.trim(),
          vat_rate_bp: vatPct ? Math.round(Number(vatPct) * 100) : 0,
        },
      });
      onSaved();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'The operator could not be updated.');
    } finally { setBusy(false); }
  }

  return (
    <div className="sheet-backdrop" onClick={() => !busy && onClose()}>
      <div className="sheet" role="dialog" aria-modal="true" aria-label={`Edit ${op.brand}`}
           style={{ maxWidth: 480 }} onClick={(e) => e.stopPropagation()}>
        <div className="sheet-grip" />
        <div className="stack" style={{ gap: '.9rem', padding: '0 .25rem' }}>
          <h2 style={{ margin: 0 }}>Edit {op.brand}</h2>
          <p className="small muted" style={{ margin: 0 }}>
            Legal identity and VAT registration. Status is changed separately.
          </p>
          <label className="stack" style={{ gap: '.25rem' }}>
            <span className="small muted">Legal name</span>
            <input className="input" value={legalName} onChange={(e) => setLegalName(e.target.value)} />
          </label>
          <label className="stack" style={{ gap: '.25rem' }}>
            <span className="small muted">Brand</span>
            <input className="input" value={brand} onChange={(e) => setBrand(e.target.value)} />
          </label>
          <div className="row" style={{ gap: '.6rem' }}>
            <label className="stack" style={{ gap: '.25rem', flex: '2 1 200px' }}>
              <span className="small muted">VAT BIN</span>
              <input className="input" value={vatBin} placeholder="not registered"
                     onChange={(e) => setVatBin(e.target.value)} />
            </label>
            <label className="stack" style={{ gap: '.25rem', width: 120 }}>
              <span className="small muted">VAT rate %</span>
              <input className="input tnum" type="number" min={0} max={100} step="0.01" value={vatPct}
                     placeholder="0" onChange={(e) => setVatPct(e.target.value)} />
            </label>
          </div>
          {error && <p className="small" style={{ color: 'var(--danger, #b3261e)' }}>{error}</p>}
          <div className="row" style={{ gap: '.5rem', justifyContent: 'flex-end' }}>
            <button className="btn btn-ghost" disabled={busy} onClick={onClose}>Cancel</button>
            <button className="btn btn-brand" disabled={busy} onClick={save}>
              {busy ? 'Saving…' : 'Save changes'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
