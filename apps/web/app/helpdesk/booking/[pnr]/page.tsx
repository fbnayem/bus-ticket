'use client';

import { use, useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { ApiError } from '@/lib/api';
import { sget, spost } from '@/lib/staff';
import { ErrorNotice, Loading, StatusPill } from '@/components/ui';
import { PageHead, Money } from '@/components/staff-ui';
import { dateTimeOf } from '@/lib/format';

// The booking timeline.
//
// Assembled from the tables that actually recorded what happened — inventory
// events, booking history, payments, webhook deliveries, tickets, boarding
// scans, cancellations, refunds — and each entry names the table it came from.
// A support agent can therefore say "the provider told us at 14:32" and be
// telling the truth, rather than reading a summary somebody wrote.

interface Booking {
  pnr: string; booking_id: string; status: string; channel: string;
  total_poisha: number; created_at: string; operator: string;
  depart_at: string; phone: string; email: string;
}
interface Event { at: string; kind: string; title: string; detail?: string; source: string }

const KIND_HUE: Record<string, string> = {
  inventory: '#0B6E4F', booking: '#1D4ED8', payment: '#B45309',
  webhook: '#6D28D9', ticket: '#0E7490', boarding: '#374151',
  cancellation: '#B3261E', refund: '#B3261E',
};

export default function TimelinePage({ params }: { params: Promise<{ pnr: string }> }) {
  const { pnr } = use(params);
  const [booking, setBooking] = useState<Booking | null>(null);
  const [events, setEvents] = useState<Event[]>([]);
  const [gaps, setGaps] = useState<string[]>([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [caseOpen, setCaseOpen] = useState(false);
  const [subject, setSubject] = useState('');
  const [note, setNote] = useState('');
  const [flash, setFlash] = useState('');

  const load = useCallback(() => {
    sget<{ booking: Booking; timeline: Event[]; gaps: string[] }>(`/helpdesk/timeline/${pnr}`)
      .then((r) => { setBooking(r.booking); setEvents(r.timeline); setGaps(r.gaps); })
      .catch((e: ApiError) => setError(e.message))
      .finally(() => setLoading(false));
  }, [pnr]);

  useEffect(() => { load(); }, [load]);

  const openCase = async () => {
    try {
      const r = await spost<{ reference: string }>('/helpdesk/cases', {
        pnr, subject, note, category: 'BOOKING', phone: booking?.phone ?? '',
      });
      setFlash(`Case ${r.reference} opened.`);
      setCaseOpen(false); setSubject(''); setNote('');
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'The case could not be opened.');
    }
  };

  if (loading) return <Loading rows={3} />;
  if (error) return <ErrorNotice message={error} />;
  if (!booking) return null;

  return (
    <div className="stack">
      <PageHead
        title={booking.pnr}
        sub={`${booking.operator} · ${dateTimeOf(booking.depart_at)}`}
        actions={
          <>
            <Link className="btn btn-ghost" href={`/manage/${pnr}`}>Manage booking</Link>
            <button className="btn btn-brand" onClick={() => setCaseOpen((v) => !v)}>Open a case</button>
            <Link className="btn btn-ghost" href="/helpdesk">New search</Link>
          </>
        }
      />

      {flash && <div className="notice notice-info">{flash}</div>}

      {caseOpen && (
        <div className="card card-pad stack" style={{ maxWidth: 520 }}>
          <div className="field">
            <label className="label" htmlFor="subj">What is this about?</label>
            <input id="subj" className="input" value={subject} onChange={(e) => setSubject(e.target.value)}
                   placeholder="Passenger wants to change departure" />
          </div>
          <div className="field">
            <label className="label" htmlFor="cnote">First note</label>
            <input id="cnote" className="input" value={note} onChange={(e) => setNote(e.target.value)}
                   placeholder="What they told you, in their words" />
          </div>
          <div className="row">
            <button className="btn btn-primary" disabled={!subject} onClick={openCase}>Open case</button>
            <button className="btn btn-ghost" onClick={() => setCaseOpen(false)}>Cancel</button>
          </div>
        </div>
      )}

      <div className="card card-pad">
        <dl className="kv">
          <dt>Status</dt><dd><StatusPill status={booking.status} /></dd>
          <dt>Sold via</dt><dd>{booking.channel.replace(/_/g, ' ').toLowerCase()}</dd>
          <dt>Paid</dt><dd><Money poisha={booking.total_poisha} decimals /></dd>
          <dt>Contact</dt><dd className="mono">{booking.phone}{booking.email ? ` · ${booking.email}` : ''}</dd>
          <dt>Booked</dt><dd>{dateTimeOf(booking.created_at)}</dd>
        </dl>
      </div>

      <div className="card card-pad">
        <h3 style={{ marginBottom: '.7rem' }}>Everything that happened</h3>
        <ul className="timeline">
          {events.map((e, i) => (
            <li key={i} style={{ ['--app' as string]: KIND_HUE[e.kind] ?? 'var(--brand)' }}>
              <div className="row-between" style={{ alignItems: 'flex-start' }}>
                <div>
                  <strong>{e.title}</strong>
                  {e.detail && <div className="muted small">{e.detail}</div>}
                  <div className="t-src">{e.source}</div>
                </div>
                <span className="small muted tnum" style={{ whiteSpace: 'nowrap' }}>
                  {dateTimeOf(e.at)}
                </span>
              </div>
            </li>
          ))}
          {events.length === 0 && <li className="muted">Nothing recorded.</li>}
        </ul>
      </div>

      {gaps.length > 0 && (
        <div className="notice notice-warn">
          <strong>Not recorded anywhere:</strong>
          <ul style={{ margin: '.3rem 0 0', paddingLeft: '1.1rem' }}>
            {gaps.map((g) => <li key={g}>{g}</li>)}
          </ul>
          <p className="small" style={{ margin: '.4rem 0 0' }}>
            Listed so nobody tells a passenger their SMS was sent when no system
            exists that could have sent it.
          </p>
        </div>
      )}
    </div>
  );
}
