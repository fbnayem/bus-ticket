'use client';

import { Suspense, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { login } from '@/lib/staff';
import { ApiError } from '@/lib/api';
import { ErrorNotice } from '@/components/ui';

// Six applications, one door. Where you land afterwards is decided by the
// server from your permissions, not by a role name hardcoded here.

const DEMO = [
  ['admin@jatra.test', 'Super Admin — the whole platform'],
  ['finance@jatra.test', 'Finance Admin — ledger and settlements'],
  ['auditor@jatra.test', 'Auditor — reads everything, changes nothing'],
  ['support@jatra.test', 'Support Agent — booking timelines and cases'],
  ['owner@greenline.test', 'Operator Owner — Green Line'],
  ['dispatch@greenline.test', 'Dispatcher — trips only, no finance'],
  ['counter.dhaka@greenline.test', 'Counter clerk — Arambagh'],
  ['driver@greenline.test', 'Driver — trips and boarding'],
  ['agent@shafi.test', 'Agent — Shafi Travels wallet'],
];

function LoginForm() {
  const router = useRouter();
  const params = useSearchParams();
  const next = params.get('next');

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [totp, setTotp] = useState('');
  // The code field only appears once the server says this account has one. It
  // is not shown speculatively, because most demo accounts do not.
  const [needCode, setNeedCode] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const session = await login(email, password, totp);
      router.replace(next && next !== '/staff/login' ? next : session.home);
    } catch (err) {
      const api = err instanceof ApiError ? err : null;
      if (api && (api.code === 'mfa_required' || api.code === 'mfa_invalid' || api.code === 'mfa_replayed')) {
        setNeedCode(true);
        setTotp('');
      }
      setError(api ? api.message : 'Sign-in failed.');
      setBusy(false);
    }
  };

  return (
    <div className="login-page">
      <div className="login-card stack">
        <div>
          <h1 style={{ marginBottom: '.2rem' }}>Staff sign in</h1>
          <p className="muted">
            Counter, agent, operator, admin, support and crew all sign in here.
          </p>
        </div>

        <form className="card card-pad stack" onSubmit={submit}>
          {error && <ErrorNotice message={error} />}

          <div className="field">
            <label className="label" htmlFor="email">Work email</label>
            <input
              id="email" className="input" type="email" autoComplete="username" required
              value={email} onChange={(e) => setEmail(e.target.value)}
              placeholder="you@operator.test"
            />
          </div>

          <div className="field">
            <label className="label" htmlFor="password">Password</label>
            <input
              id="password" className="input" type="password" autoComplete="current-password" required
              value={password} onChange={(e) => setPassword(e.target.value)}
            />
          </div>

          {needCode && (
            <div className="field">
              <label className="label" htmlFor="totp">Six-digit code</label>
              <input
                id="totp" className="input" inputMode="numeric" autoComplete="one-time-code"
                maxLength={6} required value={totp}
                onChange={(e) => setTotp(e.target.value.replace(/\D/g, ''))}
                placeholder="••••••"
              />
              <p className="small muted" style={{ marginBottom: 0 }}>
                From your authenticator app. Each code works once.
              </p>
            </div>
          )}

          <button className="btn btn-primary btn-block btn-lg" type="submit" disabled={busy}>
            {busy ? 'Signing in…' : 'Sign in'}
          </button>

          <p className="small muted" style={{ marginBottom: 0 }}>
            Sessions last 12 hours. Eight wrong passwords lock the account.
          </p>
        </form>

        <div className="card card-pad stack-sm">
          <strong className="small">Demo accounts — password <code className="mono">Jatra#2026</code></strong>
          <p className="small muted" style={{ marginBottom: '.2rem' }}>
            Fixtures for this local build. Pick one to see how differently the
            platform behaves for each role.
          </p>
          <div className="demo-list">
            {DEMO.map(([addr, who]) => (
              <button key={addr} type="button" onClick={() => { setEmail(addr); setPassword('Jatra#2026'); }}>
                <span className="mono">{addr}</span> — <span className="muted">{who}</span>
              </button>
            ))}
          </div>
        </div>

        <Link className="small" href="/">← Back to the passenger site</Link>
      </div>
    </div>
  );
}

export default function StaffLoginPage() {
  return (
    <Suspense fallback={<div className="login-page"><div className="skeleton" style={{ width: 220, height: 14 }} /></div>}>
      <LoginForm />
    </Suspense>
  );
}
