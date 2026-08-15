'use client';

import { Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { ApiError } from '@/lib/api';
import { sget, spost } from '@/lib/staff';
import { ErrorNotice, Loading } from '@/components/ui';
import { PageHead } from '@/components/staff-ui';
import { timeOf } from '@/lib/format';

// The boarding scanner.
//
// Built for a helper standing in a doorway with a queue behind them and a
// patchy signal. Two consequences shape everything here:
//
//   Every scan carries a client_ref minted on THIS device before the scan is
//   sent, so a queue flushed twice does not board anyone twice.
//
//   A scan that cannot reach the server is queued against the manifest cached
//   before departure, and the verdict says plainly that it is provisional. It
//   never claims a passenger is cleared when nothing has confirmed it.

interface Trip { trip_id: string; depart_at: string; route: string; registration: string; status: string }
interface Manifest {
  trip: { depart_at: string; route: string; operator: string; registration: string };
  passengers: { seat_no: string; pnr: string; passenger: string; ticket_status: string }[];
  total: number; boarded: number;
}
interface ScanResult { result: string; seat_no: string; pnr: string; passenger?: string; message: string; queued?: boolean }

const QUEUE_KEY = 'jatra.scan.queue';

export default function ScanPage() {
  return (
    <Suspense fallback={<Loading rows={2} />}>
      <Scanner />
    </Suspense>
  );
}

function Scanner() {
  const params = useSearchParams();
  const [tripId, setTripId] = useState(params.get('trip') ?? '');
  const [trips, setTrips] = useState<Trip[]>([]);
  const [manifest, setManifest] = useState<Manifest | null>(null);
  const [code, setCode] = useState('');
  const [seat, setSeat] = useState('');
  const [last, setLast] = useState<ScanResult | null>(null);
  const [history, setHistory] = useState<ScanResult[]>([]);
  const [error, setError] = useState('');
  const [queued, setQueued] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    sget<{ trips: Trip[] }>('/driver/trips')
      .then((r) => { setTrips(r.trips); if (!tripId && r.trips[0]) setTripId(r.trips[0].trip_id); })
      .catch((e: ApiError) => setError(e.message));
    setQueued(readQueue().length);
  }, [tripId]);

  const loadManifest = useCallback(() => {
    if (!tripId) return;
    sget<Manifest>(`/driver/trips/${tripId}/manifest`)
      .then((m) => {
        setManifest(m);
        // Cache it: this is what an offline scan validates against.
        localStorage.setItem('jatra.manifest.' + tripId, JSON.stringify(m));
      })
      .catch(() => {
        const cached = localStorage.getItem('jatra.manifest.' + tripId);
        if (cached) setManifest(JSON.parse(cached));
      });
  }, [tripId]);

  useEffect(() => { loadManifest(); }, [loadManifest]);

  const flush = useCallback(async () => {
    const q = readQueue();
    if (q.length === 0) return;
    const done: string[] = [];
    for (const s of q) {
      try { await spost('/driver/scan', s); done.push(s.client_ref); } catch { /* still offline */ }
    }
    writeQueue(readQueue().filter((s) => !done.includes(s.client_ref)));
    setQueued(readQueue().length);
    if (done.length) loadManifest();
  }, [loadManifest]);

  useEffect(() => {
    const on = () => void flush();
    window.addEventListener('online', on);
    void flush();
    return () => window.removeEventListener('online', on);
  }, [flush]);

  const scan = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!code || !tripId) return;
    setError('');

    // Minted before anything is sent. This is the identity the server
    // deduplicates on, which is what makes a repeated flush harmless.
    const clientRef = `scan-${deviceId()}-${Date.now()}`;
    const payload = {
      client_ref: clientRef, trip_id: tripId,
      pnr: code.trim().toUpperCase(), seat_no: seat.trim().toUpperCase(),
      device_ref: deviceId(), scanned_at: new Date().toISOString(),
    };

    try {
      const res = await spost<ScanResult>('/driver/scan', payload);
      setLast(res);
      setHistory((h) => [res, ...h].slice(0, 12));
      loadManifest();
    } catch (err) {
      const e = err as ApiError;
      if (e.status === 409 && e.body) {
        // A refusal is a real answer, not a failure — the crew needs to see
        // "already boarded" or "wrong trip" in the same place as a success.
        const verdict = e.body as ScanResult;
        setLast(verdict);
        setHistory((h) => [verdict, ...h].slice(0, 12));
        loadManifest();
      } else if (e.status === 0) {
        // No line. Validate against the cached manifest and queue the mark.
        const row = manifest?.passengers.find(
          (p) => p.pnr === payload.pnr && (!payload.seat_no || p.seat_no === payload.seat_no));
        const local: ScanResult = row
          ? {
              result: row.ticket_status === 'BOARDED' ? 'ALREADY_BOARDED' : 'BOARDED',
              seat_no: row.seat_no, pnr: row.pnr, passenger: row.passenger, queued: true,
              message: row.ticket_status === 'BOARDED'
                ? `Already marked boarded before we lost the line — seat ${row.seat_no}.`
                : `Seat ${row.seat_no}. Queued — this will be confirmed when the signal returns.`,
            }
          : {
              result: 'NOT_FOUND', seat_no: '', pnr: payload.pnr, queued: true,
              message: 'Not on the manifest we downloaded before departure. Check by hand.',
            };
        if (local.result === 'BOARDED') {
          writeQueue([...readQueue(), payload]);
          setQueued(readQueue().length);
        }
        setLast(local);
        setHistory((h) => [local, ...h].slice(0, 12));
      } else {
        setError(e.message);
      }
    }
    setCode(''); setSeat('');
    inputRef.current?.focus();
  };

  const tone = (r: string) => (r === 'BOARDED' ? 'ok' : r === 'ALREADY_BOARDED' ? 'warn' : 'bad');

  return (
    <div className="stack">
      <PageHead
        title="Board passengers"
        sub="Type or scan the PNR. Works with no signal against the manifest downloaded before departure."
        actions={
          <select className="select" style={{ width: 240 }} value={tripId}
                  onChange={(e) => setTripId(e.target.value)} aria-label="Trip">
            {trips.map((t) => (
              <option key={t.trip_id} value={t.trip_id}>
                {timeOf(t.depart_at)} · {t.route}
              </option>
            ))}
          </select>
        }
      />

      {error && <ErrorNotice message={error} />}
      {queued > 0 && (
        <div className="offline-bar">
          <span>{queued} scan{queued === 1 ? '' : 's'} recorded offline, waiting to sync.</span>
          <button className="btn btn-sm btn-primary" onClick={() => void flush()}>Sync now</button>
        </div>
      )}

      <form className="card card-pad" onSubmit={scan}>
        <div className="row" style={{ gap: '.6rem', alignItems: 'flex-end' }}>
          <div className="field" style={{ flex: '1 1 200px' }}>
            <label className="label" htmlFor="code">PNR</label>
            <input id="code" ref={inputRef} className="input mono" autoFocus value={code}
                   onChange={(e) => setCode(e.target.value)} placeholder="K7W4VP"
                   style={{ fontSize: '1.2rem', letterSpacing: '.08em' }} />
          </div>
          <div className="field" style={{ flex: '0 1 130px' }}>
            <label className="label" htmlFor="seat">Seat (optional)</label>
            <input id="seat" className="input mono" value={seat} onChange={(e) => setSeat(e.target.value)}
                   placeholder="A1" />
          </div>
          <button className="btn btn-primary btn-lg" type="submit">Check in</button>
        </div>
      </form>

      {last && (
        <div className={`verdict ${tone(last.result)}`}>
          <div>
            <strong>{last.result.replace(/_/g, ' ')}</strong>
            <div>{last.message}</div>
            {last.passenger && <div className="small">{last.passenger}</div>}
            {last.queued && <div className="small">Recorded on this device — not yet confirmed centrally.</div>}
          </div>
        </div>
      )}

      {manifest && (
        <div className="card card-pad stack-sm">
          <div className="row-between">
            <h3 style={{ marginBottom: 0 }}>{manifest.trip.route}</h3>
            <span className="small muted">{manifest.boarded} of {manifest.total} boarded</span>
          </div>
          <div className="table-wrap" style={{ maxHeight: 320, overflowY: 'auto' }}>
            <table className="data">
              <thead><tr><th>Seat</th><th>Passenger</th><th>PNR</th><th>Boarded</th></tr></thead>
              <tbody>
                {manifest.passengers.map((p) => (
                  <tr key={p.seat_no + p.pnr}>
                    <td className="mono"><strong>{p.seat_no}</strong></td>
                    <td>{p.passenger || '—'}</td>
                    <td className="mono small">{p.pnr}</td>
                    <td>
                      {p.ticket_status === 'BOARDED'
                        ? <span className="pill pill-ok">yes</span>
                        : <span className="pill">—</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {history.length > 0 && (
        <div className="card card-pad stack-sm">
          <h3 style={{ marginBottom: 0 }}>Recent scans on this device</h3>
          <table className="data">
            <tbody>
              {history.map((h, i) => (
                <tr key={i}>
                  <td className="mono">{h.pnr}</td>
                  <td className="mono">{h.seat_no}</td>
                  <td>
                    <span className={`pill ${h.result === 'BOARDED' ? 'pill-ok' : h.result === 'ALREADY_BOARDED' ? 'pill-warn' : 'pill-danger'}`}>
                      {h.result.replace(/_/g, ' ').toLowerCase()}
                    </span>
                  </td>
                  <td className="small muted">{h.queued ? 'queued' : 'confirmed'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

type QueuedScan = { client_ref: string; trip_id: string; pnr: string; seat_no: string; device_ref: string; scanned_at: string };

const readQueue = (): QueuedScan[] => {
  try { return JSON.parse(localStorage.getItem(QUEUE_KEY) ?? '[]'); } catch { return []; }
};
const writeQueue = (q: QueuedScan[]) => localStorage.setItem(QUEUE_KEY, JSON.stringify(q));

function deviceId(): string {
  const KEY = 'jatra.scan.device';
  let id = localStorage.getItem(KEY);
  if (!id) {
    id = 'DEV-' + Math.random().toString(36).slice(2, 7).toUpperCase();
    localStorage.setItem(KEY, id);
  }
  return id;
}
