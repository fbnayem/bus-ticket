'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { logout, me, spost, token, type Session } from '@/lib/staff';
import { ApiError } from '@/lib/api';
import { APPS } from '@/components/StaffShell';
import { Loading } from '@/components/ui';

// The switcher. Most people only ever have one workplace; a supervisor who
// covers a counter and reads reports has two, and this is where they choose.

// Whether a workplace is open to someone is decided in exactly one place —
// the app definition — so this page and the shell can never disagree about it.
const opensFor = (id: { permissions: string[]; operator_id?: string; agency_id?: string },
                  app: { entry: string; platformOnly?: boolean }) =>
  id.permissions.includes(app.entry) &&
  (!app.platformOnly || (!id.operator_id && !id.agency_id));

export default function StaffHome() {
  const router = useRouter();
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!token.get()) { router.replace('/staff/login'); return; }
    me().then(setSession).catch(() => router.replace('/staff/login')).finally(() => setLoading(false));
  }, [router]);

  if (loading || !session) {
    return <div className="page container"><Loading rows={2} /></div>;
  }

  const id = session.identity;
  const open = Object.values(APPS).filter((a) => opensFor(id, a));
  const closed = Object.values(APPS).filter((a) => !opensFor(id, a));

  return (
    <div className="page container" style={{ maxWidth: 900 }}>
      <div className="row-between" style={{ marginBottom: '1.2rem' }}>
        <div>
          <h1 style={{ marginBottom: '.2rem' }}>Hello, {id.full_name.split(' ')[0]}</h1>
          <p className="muted" style={{ marginBottom: 0 }}>
            {id.roles.map((r) => r.replace(/_/g, ' ')).join(' · ')} ·{' '}
            {id.permissions.length} permissions
          </p>
        </div>
        <button className="btn btn-ghost" onClick={async () => { await logout(); router.replace('/staff/login'); }}>
          Sign out
        </button>
      </div>

      <h2 style={{ marginBottom: '.6rem' }}>Your workplaces</h2>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px,1fr))', gap: '.8rem' }}>
        {open.map((a) => (
          <Link className="card card-pad stack-sm" key={a.key} href={'/' + a.key}
                style={{ borderLeft: `4px solid ${a.hue}`, color: 'inherit', textDecoration: 'none' }}>
            <strong>{a.name}</strong>
            <span className="small muted">{a.tagline}</span>
          </Link>
        ))}
      </div>

      {closed.length > 0 && (
        <>
          <h2 style={{ margin: '1.6rem 0 .6rem' }}>Not open to your role</h2>
          <p className="muted small" style={{ maxWidth: 620 }}>
            Listed so nothing is hidden. Opening one of these would be refused by
            the server, not just by this page — every request is re-checked
            against your permissions.
          </p>
          <div className="row" style={{ gap: '.4rem' }}>
            {closed.map((a) => (
              <span className="pill" key={a.key}>{a.name}</span>
            ))}
          </div>
        </>
      )}

      <TwoFactor enabled={!!session.mfa_enabled} onChange={() => me().then(setSession)} />

      <div className="card card-pad" style={{ marginTop: '1.6rem' }}>
        <h3 style={{ marginBottom: '.3rem' }}>One inventory, six front doors</h3>
        <p className="muted small" style={{ marginBottom: 0 }}>
          None of these applications holds seat logic. The counter, the agent
          portal, the website and the crew scanner all call the same inventory
          service, so a seat sold at Arambagh disappears from the website in the
          same instant — and two of them racing for the same seat produces
          exactly one ticket.
        </p>
      </div>
    </div>
  );
}

// Staff second factor.
//
// The plan makes TOTP mandatory for staff. It is not forced on here because
// forcing it on demo fixtures would make the harness unusable — but it is real,
// it is enforced at sign-in, and a code cannot be used twice.
function TwoFactor({ enabled, onChange }: { enabled: boolean; onChange: () => void }) {
  const [setup, setSetup] = useState<{ secret: string; otpauth_uri: string } | null>(null);
  const [code, setCode] = useState('');
  const [msg, setMsg] = useState('');

  return (
    <div className="card card-pad stack" style={{ marginTop: '1.6rem' }}>
      <div className="row-between">
        <div>
          <h3 style={{ marginBottom: '.2rem' }}>Two-factor authentication</h3>
          <p className="muted small" style={{ marginBottom: 0 }}>
            {enabled
              ? 'On. Sign-in asks for a six-digit code, and each code works once.'
              : 'Off. Your password is the only thing between an attacker and this account.'}
          </p>
        </div>
        <span className={`pill ${enabled ? 'pill-ok' : 'pill-warn'}`}>{enabled ? 'On' : 'Off'}</span>
      </div>

      {msg && <div className="notice notice-info small">{msg}</div>}

      {!enabled && !setup && (
        <div>
          <button className="btn btn-ghost btn-sm" onClick={async () => {
            setMsg('');
            try { setSetup(await spost('/staff/mfa/setup')); }
            catch (e) { setMsg((e as ApiError).message); }
          }}>
            Set up an authenticator app
          </button>
        </div>
      )}

      {!enabled && setup && (
        <div className="stack">
          <p className="small" style={{ marginBottom: 0 }}>
            Add this secret to your authenticator app, then type the code it shows.
          </p>
          <code className="mono" style={{ fontSize: '1.1rem', letterSpacing: '.08em' }}>
            {setup.secret}
          </code>
          <div className="row" style={{ gap: '.5rem' }}>
            <input
              inputMode="numeric" maxLength={6} placeholder="••••••" value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
              style={{ maxWidth: 140 }}
            />
            <button className="btn btn-primary btn-sm" disabled={code.length !== 6}
              onClick={async () => {
                setMsg('');
                try {
                  await spost('/staff/mfa/enable', { code });
                  setSetup(null); setCode(''); setMsg('Two-factor authentication is on.');
                  onChange();
                } catch (e) { setMsg((e as ApiError).message); }
              }}>
              Turn it on
            </button>
          </div>
        </div>
      )}

      {enabled && (
        <div className="row" style={{ gap: '.5rem' }}>
          <input
            inputMode="numeric" maxLength={6} placeholder="••••••" value={code}
            onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
            style={{ maxWidth: 140 }}
          />
          <button className="btn btn-ghost btn-sm" disabled={code.length !== 6}
            onClick={async () => {
              setMsg('');
              try {
                await spost('/staff/mfa/disable', { code });
                setCode(''); setMsg('Two-factor authentication is off.');
                onChange();
              } catch (e) { setMsg((e as ApiError).message); }
            }}>
            Turn it off
          </button>
          <span className="small muted">A current code is required to remove it.</span>
        </div>
      )}
    </div>
  );
}
