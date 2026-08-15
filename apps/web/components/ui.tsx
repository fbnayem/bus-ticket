'use client';

import { useEffect, useState } from 'react';
import { statusLabel, statusTone } from '@/lib/format';

/* --------------------------------------------------------------- stepper */

const FLOW = ['Search', 'Seats', 'Passengers', 'Payment', 'Ticket'] as const;
export type FlowStep = (typeof FLOW)[number];

export function Stepper({ current }: { current: FlowStep }) {
  const idx = FLOW.indexOf(current);
  return (
    <ol className="stepper" aria-label="Booking progress">
      {FLOW.map((s, i) => (
        <li key={s} className={`step ${i < idx ? 'done' : ''} ${i === idx ? 'active' : ''}`}>
          <span className="step-dot" aria-hidden="true">{i < idx ? '✓' : i + 1}</span>
          <span>{s}</span>
          {i < FLOW.length - 1 && <span className="step-line" aria-hidden="true" />}
        </li>
      ))}
    </ol>
  );
}

/* ---------------------------------------------------------------- status */

export function StatusPill({ status }: { status: string }) {
  const tone = statusTone(status);
  return <span className={`pill ${tone ? 'pill-' + tone : ''}`}>{statusLabel(status)}</span>;
}

/* ------------------------------------------------------------- countdown */

/**
 * Seat holds expire server-side; this only mirrors that deadline so the
 * passenger is never surprised. When it hits zero we say so plainly rather
 * than letting them fill in a form that will be rejected.
 */
export function HoldCountdown({ expiresAt, onExpire }: { expiresAt: string; onExpire?: () => void }) {
  const [left, setLeft] = useState(() => Math.max(0, new Date(expiresAt).getTime() - Date.now()));

  useEffect(() => {
    const t = setInterval(() => {
      const ms = Math.max(0, new Date(expiresAt).getTime() - Date.now());
      setLeft(ms);
      if (ms === 0) onExpire?.();
    }, 1000);
    return () => clearInterval(t);
  }, [expiresAt, onExpire]);

  if (left === 0) {
    return <span className="countdown urgent">Hold expired</span>;
  }
  const mins = Math.floor(left / 60000);
  const secs = Math.floor((left % 60000) / 1000);
  return (
    <span className={`countdown ${left < 60000 ? 'urgent' : ''}`}>
      {mins}:{String(secs).padStart(2, '0')}
    </span>
  );
}

/* ------------------------------------------------------------ misc bits */

export function ErrorNotice({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="notice notice-danger row-between" role="alert">
      <span>{message}</span>
      {onRetry && (
        <button className="btn btn-sm btn-ghost" onClick={onRetry}>
          Try again
        </button>
      )}
    </div>
  );
}

export function Empty({ title, children }: { title: string; children?: React.ReactNode }) {
  return (
    <div className="empty">
      <h3>{title}</h3>
      {children}
    </div>
  );
}

export function Loading({ rows = 3 }: { rows?: number }) {
  return (
    <div className="stack" aria-busy="true" aria-live="polite">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="skeleton" style={{ height: 84 }} />
      ))}
      <span className="small muted">Loading…</span>
    </div>
  );
}
