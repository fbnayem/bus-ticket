'use client';

import { use, useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { ApiError } from '@/lib/api';
import { sget, spost } from '@/lib/staff';
import { ErrorNotice, Loading, StatusPill } from '@/components/ui';
import { PageHead, Money } from '@/components/staff-ui';
import { dateTimeOf, channelLabel } from '@/lib/format';

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
  const [showRefund, setShowRefund] = useState(false);
  const [refundReason, setRefundReason] = useState('');
  const [overrideTk, setOverrideTk] = useState('');
  const [acting, setActing] = useState(false);

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

  const resend = async () => {
    setActing(true); setError('');
    try {
      await spost(`/helpdesk/bookings/${pnr}/resend`, {});
      setFlash('Confirmation resent to the passenger.');
      load();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'The confirmation could not be resent.');
    } finally { setActing(false); }
  };

  const refund = async () => {
    if (!refundReason.trim()) { setError('Give a reason for the refund.'); return; }
    // A non-numeric override used to become NaN, serialise to null, and be read
    // by the server as 0 — a full-policy refund the agent never intended. Reject
    // it here instead of silently changing the amount.
    let override_poisha = 0;
    if (overrideTk.trim()) {
      const n = Number(overrideTk);
      if (!Number.isFinite(n) || n < 0) { setError('Enter a valid refund amount in taka, or leave it blank.'); return; }
      override_poisha = Math.round(n * 100);
    }
    setActing(true); setError('');
    try {
      const r = await spost<{ refund_poisha: number }>(`/helpdesk/bookings/${pnr}/refund`, {
        reason: refundReason, override_poisha,
      });
      setFlash(`Refunded ৳${(r.refund_poisha / 100).toLocaleString('en-IN')} to the gateway.`);
      setShowRefund(false); setRefundReason(''); setOverrideTk('');
      load();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'The refund could not be completed.');
    } finally { setActing(false); }
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
            <button className="btn btn-ghost" disabled={acting} onClick={resend}>Resend ticket</button>
            <button className="btn btn-ghost" onClick={() => setShowRefund((v) => !v)}>Refund</button>
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

      {showRefund && (
        <div className="card card-pad stack" style={{ maxWidth: 520 }}>
          <div>
            <strong>Refund this booking</strong>
            <p className="small muted" style={{ margin: '.2rem 0 0' }}>
              The cancellation policy decides the amount. Leave the override blank
              for the policy figure, or enter a goodwill amount up to what was paid.
              A cash counter sale is refunded at the counter, not here.
            </p>
          </div>
          <div className="field">
            <label className="label" htmlFor="rreason">Reason</label>
            <input id="rreason" className="input" value={refundReason}
                   onChange={(e) => setRefundReason(e.target.value)}
                   placeholder="Bus cancelled, goodwill, duplicate charge…" />
          </div>
          <div className="field">
            <label className="label" htmlFor="rover">Goodwill override (৳, optional)</label>
            <input id="rover" className="input tnum" inputMode="decimal" value={overrideTk}
                   onChange={(e) => setOverrideTk(e.target.value)}
                   placeholder="Leave blank to use the policy" />
          </div>
          <div className="row">
            <button className="btn btn-primary" disabled={acting || !refundReason} onClick={refund}>
              Refund to gateway
            </button>
            <button className="btn btn-ghost" onClick={() => setShowRefund(false)}>Cancel</button>
          </div>
        </div>
      )}

      <div className="card card-pad">
        <dl className="kv">
          <dt>Status</dt><dd><StatusPill status={booking.status} /></dd>
          <dt>Sold via</dt><dd>{channelLabel(booking.channel)}</dd>
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
