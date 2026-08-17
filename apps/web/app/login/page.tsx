'use client';

import { Suspense, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { ApiError } from '@/lib/api';
import { requestCode, verifyCode, signInWithPassword } from '@/lib/auth';
import { useT } from '@/components/LangProvider';

/**
 * Passenger sign-in.
 *
 * A phone number and a six-digit code, because that is how people in this
 * market sign in to everything else. A password is offered as a second route
 * for the minority who set one, and neither is required to buy a ticket —
 * guest checkout is still the default path, and signing in later claims those
 * bookings.
 *
 * The code field gets the same number-plate treatment as the ticket number:
 * a six-digit code typed off an SMS notification, often by someone squinting,
 * is the wrong place to save vertical space.
 */

export default function LoginPage() {
  return (
    <Suspense fallback={
      <div className="container section"><div className="skeleton" style={{ height: 240 }} /></div>
    }>
      <LoginForm />
    </Suspense>
  );
}

function LoginForm() {
  const router = useRouter();
  const params = useSearchParams();
  const t = useT();
  const next = params.get('next') ?? '/account';

  const [mode, setMode] = useState<'code' | 'password'>('code');
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [stage, setStage] = useState<'phone' | 'code'>('phone');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [claimed, setClaimed] = useState<number | null>(null);

  async function sendCode(e?: React.FormEvent) {
    e?.preventDefault();
    setBusy(true); setError(''); setNotice('');
    try {
      const r = await requestCode(phone);
      setStage('code');
      setNotice(
        r.debug_code
          ? t('li.codeShown', { code: r.debug_code })
          : t('li.codeSent', { phone, minutes: Math.round(r.expires_in_seconds / 60) }));
      if (r.debug_code) setCode(r.debug_code);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t('li.sendFailed'));
    } finally {
      setBusy(false);
    }
  }

  async function submitCode(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setError('');
    try {
      const r = await verifyCode(phone, code);
      setClaimed(r.bookings_claimed);
      router.push(next);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t('li.codeFailed'));
    } finally {
      setBusy(false);
    }
  }

  async function submitPassword(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setError('');
    try {
      await signInWithPassword(phone, password);
      router.push(next);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t('li.pwFailed'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="container section" style={{ maxWidth: 480 }}>
      <h1>{t('li.title')}</h1>
      <p className="muted">{t('li.lead')}</p>

      <div className="card card-pad stack">
        <div className="row" style={{ gap: '.4rem' }}>
          <button
            type="button"
            className={`btn btn-sm ${mode === 'code' ? 'btn-primary' : 'btn-ghost'}`}
            aria-pressed={mode === 'code'}
            onClick={() => { setMode('code'); setError(''); }}
          >
            {t('li.byCode')}
          </button>
          <button
            type="button"
            className={`btn btn-sm ${mode === 'password' ? 'btn-primary' : 'btn-ghost'}`}
            aria-pressed={mode === 'password'}
            onClick={() => { setMode('password'); setError(''); }}
          >
            {t('li.byPassword')}
          </button>
        </div>

        {error && <div className="notice notice-danger" role="alert">{error}</div>}
        {notice && <div className="notice notice-info small" role="status">{notice}</div>}
        {claimed !== null && claimed > 0 && (
          <div className="notice notice-info small" role="status">
            {t('li.claimed', { count: claimed })}
          </div>
        )}

        {mode === 'code' && stage === 'phone' && (
          <form className="stack" onSubmit={sendCode}>
            <div className="field">
              <label className="label" htmlFor="phone">{t('li.mobile')}</label>
              <input
                className="input" id="phone" name="phone" inputMode="tel" autoComplete="tel"
                placeholder="01XXXXXXXXX" value={phone} required
                onChange={(e) => setPhone(e.target.value)}
              />
            </div>
            <button className="btn btn-primary btn-lg" disabled={busy} type="submit">
              {busy ? t('li.sending') : t('li.sendCode')}
            </button>
          </form>
        )}

        {mode === 'code' && stage === 'code' && (
          <form className="stack" onSubmit={submitCode}>
            <div className="field">
              <label className="label" htmlFor="code">{t('li.codeLabel')}</label>
              <input
                className="input numplate" id="code" name="code"
                inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]*"
                maxLength={6} placeholder="000000" value={code} required
                onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
              />
            </div>
            <button className="btn btn-primary btn-lg" disabled={busy || code.length !== 6} type="submit">
              {busy ? t('li.verifying') : t('li.verify')}
            </button>
            <div className="row" style={{ gap: '.5rem' }}>
              <button type="button" className="btn btn-ghost btn-sm" disabled={busy}
                      onClick={() => sendCode()}>
                {t('li.resend')}
              </button>
              <button type="button" className="btn btn-ghost btn-sm"
                      onClick={() => { setStage('phone'); setCode(''); setNotice(''); }}>
                {t('li.otherNumber')}
              </button>
            </div>
          </form>
        )}

        {mode === 'password' && (
          <form className="stack" onSubmit={submitPassword}>
            <div className="field">
              <label className="label" htmlFor="login">{t('li.loginId')}</label>
              <input className="input" id="login" name="login" autoComplete="username"
                     value={phone} required onChange={(e) => setPhone(e.target.value)} />
            </div>
            <div className="field">
              <label className="label" htmlFor="password">{t('li.password')}</label>
              <input className="input" id="password" name="password" type="password"
                     autoComplete="current-password" value={password} required
                     onChange={(e) => setPassword(e.target.value)} />
            </div>
            <button className="btn btn-primary btn-lg" disabled={busy} type="submit">
              {busy ? t('li.signingIn') : t('li.verify')}
            </button>
          </form>
        )}
      </div>

      <p className="small muted" style={{ marginTop: '1rem' }}>
        <Link href="/staff/login">{t('li.staffDoor')}</Link>
      </p>
    </div>
  );
}
