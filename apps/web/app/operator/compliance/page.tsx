'use client';

import { useCallback, useEffect, useState } from 'react';
import { ApiError } from '@/lib/api';
import { sget, spost, staffCall, can } from '@/lib/staff';
import { useSession } from '@/components/StaffShell';
import { ErrorNotice, Loading } from '@/components/ui';
import { PageHead } from '@/components/staff-ui';
import { dateOf } from '@/lib/format';

interface Doc {
  document_id: string; doc_type: string; doc_number: string;
  issued_on: string | null; expires_on: string; days_left: number;
  status: string; subject_kind: string; subject: string; note: string;
}
interface BusOpt { bus_id: string; registration: string }
interface StaffOpt { staff_id: string; full_name: string; status: string }

const TYPE_LABEL: Record<string, string> = {
  REGISTRATION: 'Registration', FITNESS: 'Fitness certificate', TAX_TOKEN: 'Tax token',
  ROUTE_PERMIT: 'Route permit', INSURANCE: 'Insurance', DRIVING_LICENSE: 'Driving licence',
};
const VEHICLE_TYPES = ['REGISTRATION', 'FITNESS', 'TAX_TOKEN', 'ROUTE_PERMIT', 'INSURANCE'];

function statusPill(status: string) {
  const cls = status === 'EXPIRED' ? 'pill-danger' : status === 'EXPIRING' ? 'pill-warn' : 'pill-ok';
  return <span className={`pill ${cls}`}>{status.toLowerCase()}</span>;
}

export default function CompliancePage() {
  const session = useSession();
  const [docs, setDocs] = useState<Doc[]>([]);
  const [buses, setBuses] = useState<BusOpt[]>([]);
  const [staff, setStaff] = useState<StaffOpt[]>([]);
  const [alerts, setAlerts] = useState({ expired: 0, expiring: 0 });
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [adding, setAdding] = useState(false);
  const [renewing, setRenewing] = useState<Doc | null>(null);

  const mayWrite = can(session?.identity ?? null, 'compliance.write');

  const load = useCallback(() => {
    Promise.all([
      sget<{ documents: Doc[] }>('/operator/documents'),
      sget<{ expired: number; expiring: number }>('/operator/documents/alerts'),
      mayWrite ? sget<{ buses: BusOpt[] }>('/operator/buses') : Promise.resolve({ buses: [] }),
      mayWrite ? sget<{ staff: StaffOpt[] }>('/operator/staff') : Promise.resolve({ staff: [] }),
    ])
      .then(([d, a, b, s]) => {
        setDocs(d.documents); setAlerts({ expired: a.expired, expiring: a.expiring });
        setBuses(b.buses); setStaff(s.staff);
      })
      .catch((e: ApiError) => setError(e.message))
      .finally(() => setLoading(false));
  }, [mayWrite]);

  useEffect(() => { load(); }, [load]);

  const remove = async (d: Doc) => {
    setError('');
    try {
      await staffCall(`/operator/documents/${d.document_id}`, { method: 'DELETE' });
      load();
    } catch (e) { setError(e instanceof ApiError ? e.message : 'Could not remove the document.'); }
  };

  if (loading) return <Loading rows={2} />;

  return (
    <div className="stack">
      <PageHead title="Compliance" sub="The papers every bus and driver must carry, and when they lapse"
        actions={mayWrite && <button className="btn btn-brand" onClick={() => setAdding(true)}>Add document</button>} />
      {error && <ErrorNotice message={error} />}

      {(alerts.expired > 0 || alerts.expiring > 0) && (
        <div className="card card-pad" style={{ borderColor: alerts.expired > 0 ? 'var(--danger, #b3261e)' : 'var(--warn, #b26b00)' }}>
          <strong>
            {alerts.expired > 0 && `${alerts.expired} document${alerts.expired === 1 ? '' : 's'} expired`}
            {alerts.expired > 0 && alerts.expiring > 0 && ', '}
            {alerts.expiring > 0 && `${alerts.expiring} expiring within a month`}.
          </strong>
          <span className="small muted"> An expired document is a bus stopped at a check-post — renew before the date, not after.</span>
        </div>
      )}

      <div className="table-wrap">
        <table className="data">
          <thead>
            <tr>
              <th>For</th><th>Document</th><th>Number</th><th>Expires</th><th>Status</th>{mayWrite && <th />}
            </tr>
          </thead>
          <tbody>
            {docs.map((d) => (
              <tr key={d.document_id}>
                <td><span className="muted small">{d.subject_kind === 'BUS' ? '🚌' : '👤'}</span> {d.subject}</td>
                <td>{TYPE_LABEL[d.doc_type] ?? d.doc_type}</td>
                <td className="mono small">{d.doc_number || '—'}</td>
                <td className="small">
                  {dateOf(d.expires_on)}
                  <div className="muted" style={{ fontSize: '.72rem' }}>
                    {d.days_left < 0 ? `${-d.days_left} days ago` : d.days_left === 0 ? 'today' : `in ${d.days_left} days`}
                  </div>
                </td>
                <td>{statusPill(d.status)}</td>
                {mayWrite && (
                  <td>
                    <div className="row" style={{ gap: '.3rem' }}>
                      <button className="btn btn-sm btn-ghost" onClick={() => setRenewing(d)}>Renew</button>
                      <button className="btn btn-sm btn-ghost" onClick={() => remove(d)}>Delete</button>
                    </div>
                  </td>
                )}
              </tr>
            ))}
            {docs.length === 0 && (
              <tr><td colSpan={mayWrite ? 6 : 5} className="muted center">No documents recorded yet.</td></tr>
            )}
          </tbody>
        </table>
      </div>

      {adding && (
        <AddDocument buses={buses} staff={staff.filter((s) => s.status === 'ACTIVE')}
                     onClose={() => setAdding(false)} onSaved={() => { setAdding(false); load(); }} />
      )}
      {renewing && (
        <RenewDocument doc={renewing} onClose={() => setRenewing(null)}
                       onSaved={() => { setRenewing(null); load(); }} />
      )}
    </div>
  );
}

function AddDocument({ buses, staff, onClose, onSaved }: {
  buses: BusOpt[]; staff: StaffOpt[]; onClose: () => void; onSaved: () => void;
}) {
  const [kind, setKind] = useState<'BUS' | 'DRIVER'>('BUS');
  const [busId, setBusId] = useState(buses[0]?.bus_id ?? '');
  const [staffId, setStaffId] = useState(staff[0]?.staff_id ?? '');
  const [docType, setDocType] = useState('FITNESS');
  const [docNumber, setDocNumber] = useState('');
  const [issued, setIssued] = useState('');
  const [expires, setExpires] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  function setKindAndType(k: 'BUS' | 'DRIVER') {
    setKind(k);
    setDocType(k === 'BUS' ? 'FITNESS' : 'DRIVING_LICENSE');
  }

  async function save() {
    if (!expires) { setError('Enter the expiry date.'); return; }
    if (kind === 'BUS' && !busId) { setError('Choose a bus.'); return; }
    if (kind === 'DRIVER' && !staffId) { setError('Choose a driver.'); return; }
    setBusy(true); setError('');
    try {
      await spost('/operator/documents', {
        bus_id: kind === 'BUS' ? busId : '', staff_id: kind === 'DRIVER' ? staffId : '',
        doc_type: docType, doc_number: docNumber, issued_on: issued, expires_on: expires,
      });
      onSaved();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'The document could not be saved.');
    } finally { setBusy(false); }
  }

  return (
    <div className="sheet-backdrop" onClick={() => !busy && onClose()}>
      <div className="sheet" role="dialog" aria-modal="true" aria-label="Add document" onClick={(e) => e.stopPropagation()}>
        <div className="sheet-grip" />
        <div className="stack" style={{ gap: '.9rem', padding: '0 .25rem' }}>
          <h2 style={{ margin: 0 }}>Add a document</h2>
          <div className="row" style={{ gap: '.3rem' }}>
            <button className={`btn btn-sm ${kind === 'BUS' ? 'btn-brand' : 'btn-ghost'}`} onClick={() => setKindAndType('BUS')}>For a bus</button>
            <button className={`btn btn-sm ${kind === 'DRIVER' ? 'btn-brand' : 'btn-ghost'}`} onClick={() => setKindAndType('DRIVER')}>For a driver</button>
          </div>

          {kind === 'BUS' ? (
            <label className="stack" style={{ gap: '.25rem' }}>
              <span className="small muted">Bus</span>
              <select className="select" value={busId} onChange={(e) => setBusId(e.target.value)}>
                {buses.map((b) => <option key={b.bus_id} value={b.bus_id}>{b.registration}</option>)}
              </select>
            </label>
          ) : (
            <label className="stack" style={{ gap: '.25rem' }}>
              <span className="small muted">Driver</span>
              <select className="select" value={staffId} onChange={(e) => setStaffId(e.target.value)}>
                {staff.map((s) => <option key={s.staff_id} value={s.staff_id}>{s.full_name}</option>)}
              </select>
            </label>
          )}

          <label className="stack" style={{ gap: '.25rem' }}>
            <span className="small muted">Document</span>
            <select className="select" value={docType} onChange={(e) => setDocType(e.target.value)}>
              {(kind === 'BUS' ? VEHICLE_TYPES : ['DRIVING_LICENSE']).map((t) =>
                <option key={t} value={t}>{TYPE_LABEL[t]}</option>)}
            </select>
          </label>
          <label className="stack" style={{ gap: '.25rem' }}>
            <span className="small muted">Number (optional)</span>
            <input className="input" value={docNumber} onChange={(e) => setDocNumber(e.target.value)} />
          </label>
          <div className="row" style={{ gap: '.6rem' }}>
            <label className="stack" style={{ gap: '.25rem', flex: 1 }}>
              <span className="small muted">Issued (optional)</span>
              <input className="input" type="date" value={issued} onChange={(e) => setIssued(e.target.value)} />
            </label>
            <label className="stack" style={{ gap: '.25rem', flex: 1 }}>
              <span className="small muted">Expires</span>
              <input className="input" type="date" value={expires} onChange={(e) => setExpires(e.target.value)} />
            </label>
          </div>
          {error && <p className="small" style={{ color: 'var(--danger, #b3261e)' }}>{error}</p>}
          <div className="row" style={{ gap: '.5rem', justifyContent: 'flex-end' }}>
            <button className="btn btn-ghost" disabled={busy} onClick={onClose}>Cancel</button>
            <button className="btn btn-brand" disabled={busy} onClick={save}>{busy ? 'Saving…' : 'Save document'}</button>
          </div>
        </div>
      </div>
    </div>
  );
}

function RenewDocument({ doc, onClose, onSaved }: { doc: Doc; onClose: () => void; onSaved: () => void }) {
  const [docNumber, setDocNumber] = useState(doc.doc_number);
  const [issued, setIssued] = useState('');
  const [expires, setExpires] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function save() {
    if (!expires) { setError('Enter the new expiry date.'); return; }
    setBusy(true); setError('');
    try {
      await staffCall(`/operator/documents/${doc.document_id}`, {
        method: 'PATCH',
        body: { doc_number: docNumber, issued_on: issued, expires_on: expires },
      });
      onSaved();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'The renewal could not be saved.');
    } finally { setBusy(false); }
  }

  return (
    <div className="sheet-backdrop" onClick={() => !busy && onClose()}>
      <div className="sheet" role="dialog" aria-modal="true" aria-label="Renew document" onClick={(e) => e.stopPropagation()}>
        <div className="sheet-grip" />
        <div className="stack" style={{ gap: '.9rem', padding: '0 .25rem' }}>
          <h2 style={{ margin: 0 }}>Renew document</h2>
          <p className="small muted" style={{ margin: 0 }}>
            {TYPE_LABEL[doc.doc_type] ?? doc.doc_type} · {doc.subject}
          </p>
          <label className="stack" style={{ gap: '.25rem' }}>
            <span className="small muted">New number (optional)</span>
            <input className="input" value={docNumber} onChange={(e) => setDocNumber(e.target.value)} />
          </label>
          <div className="row" style={{ gap: '.6rem' }}>
            <label className="stack" style={{ gap: '.25rem', flex: 1 }}>
              <span className="small muted">Issued (optional)</span>
              <input className="input" type="date" value={issued} onChange={(e) => setIssued(e.target.value)} />
            </label>
            <label className="stack" style={{ gap: '.25rem', flex: 1 }}>
              <span className="small muted">New expiry</span>
              <input className="input" type="date" value={expires} onChange={(e) => setExpires(e.target.value)} />
            </label>
          </div>
          {error && <p className="small" style={{ color: 'var(--danger, #b3261e)' }}>{error}</p>}
          <div className="row" style={{ gap: '.5rem', justifyContent: 'flex-end' }}>
            <button className="btn btn-ghost" disabled={busy} onClick={onClose}>Cancel</button>
            <button className="btn btn-brand" disabled={busy} onClick={save}>{busy ? 'Saving…' : 'Save renewal'}</button>
          </div>
        </div>
      </div>
    </div>
  );
}
