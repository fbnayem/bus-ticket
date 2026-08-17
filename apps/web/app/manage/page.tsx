'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { api, ApiError } from '@/lib/api';
import { ErrorNotice } from '@/components/ui';
import { useT } from '@/components/LangProvider';
import { Glyph } from '@/components/Glyph';

/**
 * The door back in.
 *
 * This page used to ask for a "Booking reference (PNR)". PNR is a word from
 * airline reservation systems that arrived here because the products this
 * market copied were themselves copies. A passenger holding a printed stub
 * calls the six characters on it the ticket number, so that is what the label
 * says; the letters PNR appear once, in the hint, so that someone reading them
 * off the stub can tell the two are the same thing.
 *
 * The other half of the fix is that a lost number is no longer a dead end. It
 * always had a second route — sign in on the mobile number you booked with —
 * and that route was a footnote in small grey text under the form.
 */
export default function FindBookingPage() {
  const router = useRouter();
  const t = useT();
  const [ref, setRef] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const find = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const b = await api.booking(ref.trim().toUpperCase());
      router.push(`/manage/${b.pnr}`);
    } catch (err) {
      setError((err as ApiError).message);
      setBusy(false);
    }
  };

  return (
    <div className="page container-narrow">
      <h1 style={{ marginBottom: '.4rem' }}>{t('find.title')}</h1>
      <p className="muted">{t('find.lead')}</p>

      <form className="card card-pad stack" onSubmit={find}>
        <div className="field">
          <label className="label" htmlFor="ref" style={{ fontSize: '.92rem' }}>
            {t('find.label')}
          </label>
          <input
            id="ref"
            className="input numplate"
            required
            value={ref}
            maxLength={6}
            placeholder="7VAFHL"
            autoComplete="off"
            autoCapitalize="characters"
            spellCheck={false}
            // Letters and digits both, so a numeric keypad would be wrong; the
            // uppercasing happens here rather than only in CSS so that what is
            // submitted matches what is shown.
            onChange={(e) => setRef(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ''))}
          />
        </div>

        {/* Where the number is, drawn. Cheaper to understand than a sentence. */}
        <div className="stub-hint">
          <span className="stub-mini" aria-hidden="true">
            <b>7VAFHL</b>
            <i /><i /><i />
          </span>
          <span className="small muted">{t('find.hint')}</span>
        </div>

        {error && <ErrorNotice message={error} />}

        <button className="btn btn-primary btn-lg" type="submit" disabled={busy || ref.length < 6}>
          {busy ? t('find.working') : t('find.action')}
        </button>
      </form>

      <div className="card card-pad stack-sm" style={{ marginTop: '1rem' }}>
        <div className="row" style={{ gap: '.5rem' }}>
          <Glyph name="person" size={18} />
          <strong>{t('find.orSignIn')}</strong>
        </div>
        <p className="muted small" style={{ margin: 0 }}>{t('find.orSignInBody')}</p>
        <div>
          <Link className="btn btn-ghost" href="/login?next=/account">{t('find.signIn')}</Link>
        </div>
      </div>

      <p className="small muted" style={{ marginTop: '1rem' }}>
        <Link href="/support">{t('nav.support')}</Link>
      </p>
    </div>
  );
}
