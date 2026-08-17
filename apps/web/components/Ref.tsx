'use client';

import { useState } from 'react';
import { useT } from './LangProvider';

/**
 * A machine reference: PNR, QR token, transaction id, journal id.
 *
 * Two rules, both learned from what these become at a counter window.
 *
 * ALWAYS LATIN DIGITS, in both languages. A passenger reads a PNR aloud to a
 * clerk and types it on a Latin keypad; ৭ভি… is unusable at the window. This
 * is why the numerals policy exempts references from localisation.
 *
 * TRUNCATE IN THE MIDDLE, never the head. The ticket page used to render
 * `token.slice(0, 22) + '…'`, which shows a passenger twenty-two characters of
 * an HMAC — the least informative part of the string, and identical across
 * every row for tokens that share a prefix. The tail is what distinguishes
 * them, so both ends survive.
 */
export function Ref({
  value, truncate, copyable = false, className = '',
}: {
  value: string;
  /** Total characters to show; the middle is replaced with an ellipsis. */
  truncate?: number;
  copyable?: boolean;
  className?: string;
}) {
  const t = useT();
  const [said, setSaid] = useState('');

  if (!value) return <span className="muted">—</span>;

  let shown = value;
  if (truncate && value.length > truncate) {
    const head = Math.ceil((truncate - 1) / 2);
    const tail = Math.floor((truncate - 1) / 2);
    shown = `${value.slice(0, head)}…${value.slice(-tail)}`;
  }

  if (!copyable) {
    return <span className={`ref ${className}`} title={value}>{shown}</span>;
  }

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setSaid(t('ticket.copied'));
    } catch {
      // Reported rather than swallowed: a copy that silently failed leaves the
      // passenger pasting whatever was on the clipboard before.
      setSaid(t('ticket.copyFailed'));
    }
    setTimeout(() => setSaid(''), 1800);
  };

  return (
    <button type="button" className={`ref ref-copy ${className}`} onClick={copy} title={value}>
      {shown}
      <span className="ref-said" aria-live="polite">{said}</span>
    </button>
  );
}
