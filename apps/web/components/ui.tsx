'use client';

import { useEffect, useState } from 'react';
import { statusLabel, statusTone } from '@/lib/format';
import { useT } from './LangProvider';
import { STRINGS, type Key } from '@/lib/i18n';

/* --------------------------------------------------------------- stepper */

const FLOW = ['Search', 'Seats', 'Passengers', 'Payment', 'Ticket'] as const;
export type FlowStep = (typeof FLOW)[number];

const STEP_KEY: Record<FlowStep, Key> = {
  Search: 'step.search',
  Seats: 'step.seats',
  Passengers: 'step.passengers',
  Payment: 'step.payment',
  Ticket: 'step.ticket',
};

export function Stepper({ current }: { current: FlowStep }) {
  const t = useT();
  const idx = FLOW.indexOf(current);
  return (
    <ol className="stepper" aria-label={t('common.step')}>
      {FLOW.map((s, i) => (
        <li key={s} className={`step ${i < idx ? 'done' : ''} ${i === idx ? 'active' : ''}`}>
          <span className="step-dot" aria-hidden="true">{i < idx ? '✓' : i + 1}</span>
          <span>{t(STEP_KEY[s])}</span>
          {i < FLOW.length - 1 && <span className="step-line" aria-hidden="true" />}
        </li>
      ))}
    </ol>
  );
}

/* ---------------------------------------------------------------- status */

/**
 * A booking status in the reader's language.
 *
 * Falls back to the server's own wording for any status the catalogue does not
 * yet carry — a state we have not translated should still be shown, not
 * swallowed, because a passenger seeing "REFUND_REJECTED" is better served
 * than one seeing an empty pill.
 */
export function StatusPill({ status }: { status: string }) {
  const t = useT();
  const tone = statusTone(status);
  const key = `status.${status}` as Key;
  const label = key in STRINGS ? t(key) : statusLabel(status);
  return <span className={`pill ${tone ? 'pill-' + tone : ''}`}>{label}</span>;
}

/* ------------------------------------------------------------- countdown */

/**
 * Seat holds expire server-side; this only mirrors that deadline so the
 * passenger is never surprised. When it hits zero we say so plainly rather
 * than letting them fill in a form that will be rejected.
 */
export function HoldCountdown({ expiresAt, onExpire }: { expiresAt: string; onExpire?: () => void }) {
  const t = useT();
  const [left, setLeft] = useState(() => Math.max(0, new Date(expiresAt).getTime() - Date.now()));

  useEffect(() => {
    const timer = setInterval(() => {
      const ms = Math.max(0, new Date(expiresAt).getTime() - Date.now());
      setLeft(ms);
      if (ms === 0) onExpire?.();
    }, 1000);
    return () => clearInterval(timer);
  }, [expiresAt, onExpire]);

  if (left === 0) {
    return <span className="countdown urgent">{t('hold.expired')}</span>;
  }
  const mins = Math.floor(left / 60000);
  const secs = Math.floor((left % 60000) / 1000);
  return (
    <span className={`countdown ${left < 60000 ? 'urgent' : ''}`}>
      {mins}:{String(secs).padStart(2, '0')}
    </span>
  );
}

/* ------------------------------------------------------------ the fascia */

/**
 * The sticky bar carrying the money, the deadline and the one action.
 *
 * Three things live here and nothing else. The money is whatever the SERVER
 * said — this component takes a formatted string rather than a fare and a fee
 * to add up, so the hardcoded service charge that used to be summed on two
 * different screens cannot be written into it.
 *
 * The deadline is not digits in a card header that scrolled away ten minutes
 * ago. It is a rule along the top edge that drains, so it stays on screen for
 * as long as the hold exists.
 */
export function Fascia({
  total, note, action, holdExpiresAt, holdSeconds,
}: {
  total: string;
  note?: string;
  action: React.ReactNode;
  holdExpiresAt?: string;
  /** The hold window the SERVER granted. Never assume ten minutes. */
  holdSeconds?: number;
}) {
  const [frac, setFrac] = useState(1);

  useEffect(() => {
    if (!holdExpiresAt || !holdSeconds) return;
    const tick = () => {
      const left = new Date(holdExpiresAt).getTime() - Date.now();
      setFrac(Math.max(0, Math.min(1, left / (holdSeconds * 1000))));
    };
    tick();
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, [holdExpiresAt, holdSeconds]);

  const urgent = holdExpiresAt ? new Date(holdExpiresAt).getTime() - Date.now() < 60000 : false;

  return (
    <div className="actionbar">
      {holdExpiresAt && (
        <span
          className={`drain${urgent ? ' urgent' : ''}`}
          style={{ transform: `scaleX(${frac})` }}
          aria-hidden="true"
        />
      )}
      <div className="ab-figures">
        <span className="ab-total">{total}</span>
        <span className="ab-note">
          {holdExpiresAt && (
            <>
              <HoldCountdown expiresAt={holdExpiresAt} />
              {note ? ' · ' : ''}
            </>
          )}
          {note}
        </span>
      </div>
      {action}
    </div>
  );
}

/* ------------------------------------------------------------ misc bits */

export function ErrorNotice({ message, onRetry }: { message: string; onRetry?: () => void }) {
  const t = useT();
  return (
    <div className="notice notice-danger row-between" role="alert">
      <span>{message}</span>
      {onRetry && (
        <button className="btn btn-sm btn-ghost" onClick={onRetry}>
          {t('common.retry')}
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
  const t = useT();
  return (
    <div className="stack" aria-busy="true" aria-live="polite">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="skeleton" style={{ height: 84 }} />
      ))}
      <span className="small muted">{t('common.loading')}</span>
    </div>
  );
}
