'use client';

import { useCallback, useEffect, useState } from 'react';
import { ApiError } from '@/lib/api';
import { sget, spost, can } from '@/lib/staff';
import { useSession } from '@/components/StaffShell';
import { ErrorNotice, Loading } from '@/components/ui';
import { PageHead } from '@/components/staff-ui';
import { AMENITY_LABEL } from '@/lib/format';
import SeatLayoutBuilder from '@/components/SeatLayoutBuilder';

interface Bus {
  bus_id: string; registration: string; bus_type: string; is_ac: boolean;
  class: string; status: string; layout: string; seats: number; amenities: string;
}
interface BusType { bus_type_id: string; name: string; is_ac: boolean; class: string; custom?: boolean; }
const BUS_CLASSES = ['ECONOMY', 'BUSINESS', 'PREMIUM', 'SLEEPER'];
interface Layout { layout_id: string; name: string; version: number; decks: number; seats: number; buses: number; editable: boolean; }

const STATUSES = ['ACTIVE', 'MAINTENANCE', 'OUT_OF_SERVICE', 'RESERVED', 'DECOMMISSIONED'];

export default function FleetPage() {
  const session = useSession();
  const [buses, setBuses] = useState<Bus[]>([]);
  const [types, setTypes] = useState<BusType[]>([]);
  const [layouts, setLayouts] = useState<Layout[]>([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [addingBus, setAddingBus] = useState(false);
  const [buildingLayout, setBuildingLayout] = useState(false);
  const [addingType, setAddingType] = useState(false);

  const mayWrite = can(session?.identity ?? null, 'fleet.write');

  const load = useCallback(() => {
    Promise.all([
      sget<{ buses: Bus[] }>('/operator/buses'),
      sget<{ bus_types: BusType[] }>('/operator/bus-types'),
      sget<{ layouts: Layout[] }>('/operator/layouts'),
    ])
      .then(([b, t, l]) => { setBuses(b.buses); setTypes(t.bus_types); setLayouts(l.layouts); })
      .catch((e: ApiError) => setError(e.message))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { load(); }, [load]);

  if (loading) return <Loading rows={2} />;

  return (
    <div className="stack">
      <PageHead title="Fleet" sub="Buses, their seat layouts and what is fitted"
        actions={mayWrite && (
          <div className="row" style={{ gap: '.4rem' }}>
            <button className="btn btn-ghost" onClick={() => setAddingType(true)}>New bus type</button>
            <button className="btn btn-ghost" onClick={() => setBuildingLayout(true)}>New layout</button>
            <button className="btn btn-brand" disabled={layouts.length === 0}
                    onClick={() => setAddingBus(true)}>Add bus</button>
          </div>
        )} />
      {error && <ErrorNotice message={error} />}
      {mayWrite && layouts.length === 0 && (
        <p className="small muted">Create a seat layout first — a bus needs one before it can be added.</p>
      )}

      <div className="table-wrap">
        <table className="data">
          <thead>
            <tr>
              <th>Registration</th><th>Type</th><th>Class</th>
              <th>Seat layout</th><th className="num">Seats</th><th>Fitted</th><th>Status</th>
            </tr>
          </thead>
          <tbody>
            {buses.map((b) => (
              <tr key={b.bus_id}>
                <td className="mono"><strong>{b.registration}</strong></td>
                <td>{b.bus_type} {b.is_ac && <span className="pill pill-brand">AC</span>}</td>
                <td className="muted small">{b.class}</td>
                <td>{b.layout}</td>
                <td className="num">{b.seats}</td>
                <td className="small muted">
                  {b.amenities
                    ? b.amenities.split(', ').map((a) => AMENITY_LABEL[a] ?? a).join(' · ')
                    : '—'}
                </td>
                <td><span className={`pill ${b.status === 'ACTIVE' ? 'pill-ok' : 'pill-warn'}`}>{b.status.toLowerCase()}</span></td>
              </tr>
            ))}
            {buses.length === 0 && (
              <tr><td colSpan={7} className="muted center">No buses registered.</td></tr>
            )}
          </tbody>
        </table>
      </div>

      <h3 style={{ marginBottom: 0 }}>Seat layouts</h3>
      <div className="table-wrap">
        <table className="data">
          <thead>
            <tr><th>Name</th><th className="num">Version</th><th className="num">Seats</th><th className="num">On buses</th><th /></tr>
          </thead>
          <tbody>
            {layouts.map((l) => (
              <tr key={l.layout_id}>
                <td>{l.name}</td>
                <td className="num">v{l.version}</td>
                <td className="num">{l.seats}</td>
                <td className="num">{l.buses}</td>
                <td>
                  {l.editable
                    ? <span className="small muted">editable</span>
                    : <span className="pill" title="A trip has been sold against this layout, so its seats are fixed.">locked</span>}
                </td>
              </tr>
            ))}
            {layouts.length === 0 && (
              <tr><td colSpan={5} className="muted center">No seat layouts yet.</td></tr>
            )}
          </tbody>
        </table>
      </div>

      <p className="small muted">
        A seat layout is frozen once a trip references it. Changing the layout of
        a bus that has already run would rewrite what every historical ticket
        meant, so a new version is created instead.
      </p>

      {addingBus && (
        <AddBusSheet types={types} layouts={layouts}
                     onClose={() => setAddingBus(false)}
                     onSaved={() => { setAddingBus(false); load(); }} />
      )}
      {buildingLayout && (
        <SeatLayoutBuilder onClose={() => setBuildingLayout(false)}
                           onSaved={() => { setBuildingLayout(false); load(); }} />
      )}
      {addingType && (
        <NewBusTypeSheet onClose={() => setAddingType(false)}
                         onSaved={() => { setAddingType(false); load(); }} />
      )}
    </div>
  );
}

function NewBusTypeSheet({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState('');
  const [isAC, setIsAC] = useState(true);
  const [cls, setCls] = useState('BUSINESS');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function save() {
    if (!name.trim()) { setError('Give the bus type a name.'); return; }
    setBusy(true); setError('');
    try {
      await spost('/operator/bus-types', { name: name.trim(), is_ac: isAC, class: cls });
      onSaved();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'The bus type could not be added.');
    } finally { setBusy(false); }
  }

  return (
    <div className="sheet-backdrop" onClick={() => !busy && onClose()}>
      <div className="sheet" role="dialog" aria-modal="true" aria-label="New bus type"
           style={{ maxWidth: 440 }} onClick={(e) => e.stopPropagation()}>
        <div className="sheet-grip" />
        <div className="stack" style={{ gap: '.9rem', padding: '0 .25rem' }}>
          <h2 style={{ margin: 0 }}>New bus type</h2>
          <p className="small muted" style={{ margin: 0 }}>
            A coach model of your own — added to the shared platform types, visible
            only to you.
          </p>
          <label className="stack" style={{ gap: '.25rem' }}>
            <span className="small muted">Name</span>
            <input className="input" value={name} autoFocus placeholder="e.g. Hyundai Universe AC Business"
                   onChange={(e) => setName(e.target.value)} />
          </label>
          <div className="row" style={{ gap: '.6rem', alignItems: 'flex-end' }}>
            <label className="stack" style={{ gap: '.25rem', flex: '1 1 160px' }}>
              <span className="small muted">Class</span>
              <select className="select" value={cls} onChange={(e) => setCls(e.target.value)}>
                {BUS_CLASSES.map((c) => <option key={c} value={c}>{c.toLowerCase()}</option>)}
              </select>
            </label>
            <label className="row" style={{ gap: '.4rem', alignItems: 'center', paddingBottom: '.55rem' }}>
              <input type="checkbox" checked={isAC} onChange={(e) => setIsAC(e.target.checked)} />
              <span className="small">Air-conditioned</span>
            </label>
          </div>
          {error && <p className="small" style={{ color: 'var(--danger, #b3261e)' }}>{error}</p>}
          <div className="row" style={{ gap: '.5rem', justifyContent: 'flex-end' }}>
            <button className="btn btn-ghost" disabled={busy} onClick={onClose}>Cancel</button>
            <button className="btn btn-brand" disabled={busy} onClick={save}>
              {busy ? 'Adding…' : 'Add bus type'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function AddBusSheet({ types, layouts, onClose, onSaved }: {
  types: BusType[]; layouts: Layout[]; onClose: () => void; onSaved: () => void;
}) {
  const [registration, setRegistration] = useState('');
  const [busType, setBusType] = useState(types[0]?.bus_type_id ?? '');
  const [layout, setLayout] = useState(layouts[0]?.layout_id ?? '');
  const [status, setStatus] = useState('ACTIVE');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function save() {
    if (!registration.trim()) { setError('Enter the bus registration.'); return; }
    if (!busType) { setError('Choose a bus type.'); return; }
    if (!layout) { setError('Choose a seat layout.'); return; }
    setBusy(true); setError('');
    try {
      await spost('/operator/buses', {
        registration: registration.trim(), bus_type_id: busType, layout_id: layout, status,
      });
      onSaved();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'The bus could not be added.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="sheet-backdrop" onClick={() => !busy && onClose()}>
      <div className="sheet" role="dialog" aria-modal="true" aria-label="Add a bus"
           onClick={(e) => e.stopPropagation()}>
        <div className="sheet-grip" />
        <div className="stack" style={{ gap: '.9rem', padding: '0 .25rem' }}>
          <h2 style={{ margin: 0 }}>Add a bus</h2>
          <label className="stack" style={{ gap: '.25rem' }}>
            <span className="small muted">Registration</span>
            <input className="input" value={registration} autoFocus placeholder="e.g. Dhaka Metro-Ba 11-2233"
                   onChange={(e) => setRegistration(e.target.value)} />
          </label>
          <label className="stack" style={{ gap: '.25rem' }}>
            <span className="small muted">Bus type</span>
            <select className="select" value={busType} onChange={(e) => setBusType(e.target.value)}>
              {types.map((t) => <option key={t.bus_type_id} value={t.bus_type_id}>{t.name}{t.is_ac ? ' · AC' : ''}</option>)}
            </select>
          </label>
          <label className="stack" style={{ gap: '.25rem' }}>
            <span className="small muted">Seat layout</span>
            <select className="select" value={layout} onChange={(e) => setLayout(e.target.value)}>
              {layouts.map((l) => <option key={l.layout_id} value={l.layout_id}>{l.name} (v{l.version}, {l.seats} seats)</option>)}
            </select>
          </label>
          <label className="stack" style={{ gap: '.25rem' }}>
            <span className="small muted">Status</span>
            <select className="select" value={status} onChange={(e) => setStatus(e.target.value)}>
              {STATUSES.map((s) => <option key={s} value={s}>{s.replace(/_/g, ' ').toLowerCase()}</option>)}
            </select>
          </label>
          {error && <p className="small" style={{ color: 'var(--danger, #b3261e)' }}>{error}</p>}
          <div className="row" style={{ gap: '.5rem', justifyContent: 'flex-end' }}>
            <button className="btn btn-ghost" disabled={busy} onClick={onClose}>Cancel</button>
            <button className="btn btn-brand" disabled={busy} onClick={save}>
              {busy ? 'Adding…' : 'Add bus'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
