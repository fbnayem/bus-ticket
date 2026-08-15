'use client';

import { Suspense, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { ApiError } from '@/lib/api';
import { requestCode, verifyCode, signInWithPassword } from '@/lib/auth';

// Passenger sign-in.
//
// A phone number and a six-digit code, because that is how people in this
// market sign in to everything else. A password is offered as a second route
// for the minority who set one, and neither is required to buy a ticket —
// guest checkout is still the default path, and signing in later claims those
// bookings.

export default function LoginPage() {
  return (
    <Suspense fallback={<div className="container section"><div className="skeleton" style={{ height: 240 }} /></div>}>
      <LoginForm />
    </Suspense>
  );
}

function LoginForm() {
  const router = useRouter();
  const params = useSearchParams();
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

  async function sendCode(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setError(''); setNotice('');
    try {
      const r = await requestCode(phone);
      setStage('code');
      setNotice(
        r.debug_code
          ? `Your code is ${r.debug_code}. It is shown here only because this build has SHOW_OTP on; a real deployment sends it by SMS and never returns it.`
          : `We sent a code to ${phone}. It expires in ${Math.round(r.expires_in_seconds / 60)} minutes.`);
      if (r.debug_code) setCode(r.debug_code);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not send a code.');
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
      setError(err instanceof ApiError ? err.message : 'That code did not work.');
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
      setError(err instanceof ApiError ? err.message : 'Sign-in failed.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="container section" style={{ maxWidth: 480 }}>
      <h1>Sign in</h1>
      <p className="muted">
        You do not need an account to buy a ticket. Signing in keeps your trips,
        your saved passengers and your refunds in one place — and picks up any
        booking you already made on this number.
      </p>

      <div className="card stack" style={{ padding: '1.4rem' }}>
        <div className="row" style={{ gap: '.4rem' }}>
          <button
            type="button"
            className={`btn btn-sm ${mode === 'code' ? 'btn-primary' : 'btn-ghost'}`}
            onClick={() => { setMode('code'); setError(''); }}
          >
            One-time code
          </button>
          <button
            type="button"
            className={`btn btn-sm ${mode === 'password' ? 'btn-primary' : 'btn-ghost'}`}
            onClick={() => { setMode('password'); setError(''); }}
          >
            Password
          </button>
        </div>

        {error && <div className="notice notice-danger">{error}</div>}
        {notice && <div className="notice notice-info small">{notice}</div>}
        {claimed !== null && claimed > 0 && (
          <div className="notice notice-info small">
            {claimed} earlier booking{claimed === 1 ? '' : 's'} on this number
            {claimed === 1 ? ' is' : ' are'} now in your account.
          </div>
        )}

        {mode === 'code' && stage === 'phone' && (
          <form className="stack" onSubmit={sendCode}>
            <label htmlFor="phone">Mobile number</label>
            <input
              id="phone" name="phone" inputMode="tel" autoComplete="tel"
              placeholder="01XXXXXXXXX" value={phone} required
              onChange={(e) => setPhone(e.target.value)}
            />
            <button className="btn btn-primary" disabled={busy} type="submit">
              {busy ? 'Sending…' : 'Send me a code'}
            </button>
          </form>
        )}

        {mode === 'code' && stage === 'code' && (
          <form className="stack" onSubmit={submitCode}>
            <label htmlFor="code">Six-digit code</label>
            <input
              id="code" name="code" inputMode="numeric" autoComplete="one-time-code"
              maxLength={6} placeholder="••••••" value={code} required
              onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
            />
            <button className="btn btn-primary" disabled={busy || code.length !== 6} type="submit">
              {busy ? 'Checking…' : 'Sign in'}
            </button>
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => setStage('phone')}>
              Use a different number
            </button>
          </form>
        )}

        {mode === 'password' && (
          <form className="stack" onSubmit={submitPassword}>
            <label htmlFor="login">Mobile number or email</label>
            <input
              id="login" name="login" autoComplete="username"
              value={phone} required onChange={(e) => setPhone(e.target.value)}
            />
            <label htmlFor="password">Password</label>
            <input
              id="password" name="password" type="password" autoComplete="current-password"
              value={password} required onChange={(e) => setPassword(e.target.value)}
            />
            <button className="btn btn-primary" disabled={busy} type="submit">
              {busy ? 'Signing in…' : 'Sign in'}
            </button>
          </form>
        )}
      </div>

      <p className="small muted" style={{ marginTop: '1rem' }}>
        Staff sign in at <Link href="/staff/login">the staff door</Link>.
      </p>
    </div>
  );
}
