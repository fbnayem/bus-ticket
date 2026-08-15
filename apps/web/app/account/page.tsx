'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ApiError, type AccountBooking, type SavedPassenger } from '@/lib/api';
import { authed, isSignedIn, sessions, signOut, signOutEverywhere, updateProfile,
  type DeviceSession } from '@/lib/auth';
import { Empty, ErrorNotice, Loading, StatusPill } from '@/components/ui';
import { dateTimeOf, taka } from '@/lib/format';

// The account area is now behind a real sign-in, so every call here carries a
// bearer token and the server decides what belongs to this passenger. A visitor
// who is not signed in gets an invitation, not an empty list.

type Tab = 'upcoming' | 'past' | 'passengers' | 'profile' | 'devices' | 'referrals';

interface Profile {
  display_name: string;
  phone: string;
  email: string;
  authenticated: boolean;
  lang: string;
}

interface Referral {
  code: string;
  status: string;
  reward_poisha: number;
  reward_code?: string;
  invitee?: string;
}

export default function AccountPage() {
  const router = useRouter();
  const [tab, setTab] = useState<Tab>('upcoming');
  const [upcoming, setUpcoming] = useState<AccountBooking[]>([]);
  const [past, setPast] = useState<AccountBooking[]>([]);
  const [passengers, setPassengers] = useState<SavedPassenger[]>([]);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [devices, setDevices] = useState<DeviceSession[]>([]);
  const [referral, setReferral] = useState<Referral | null>(null);
  const [history, setHistory] = useState<Referral[]>([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [signedIn, setSignedIn] = useState(true);

  const load = useCallback(() => {
    if (!isSignedIn()) { setSignedIn(false); setLoading(false); return; }
    Promise.all([
      authed<{ upcoming: AccountBooking[]; past: AccountBooking[] }>('/account/bookings'),
      authed<{ passengers: SavedPassenger[] }>('/account/passengers'),
      authed<Profile>('/account/profile'),
      sessions(),
      authed<{ referral: Referral; history: Referral[] }>('/referrals/me'),
    ])
      .then(([b, p, pr, s, ref]) => {
        setUpcoming(b.upcoming); setPast(b.past);
        setPassengers(p.passengers); setProfile(pr);
        setDevices(s.sessions);
        setReferral(ref.referral); setHistory(ref.history);
        setSignedIn(true);
      })
      .catch((e: ApiError) => {
        if (e.status === 401) setSignedIn(false);
        else setError(e.message);
      })
      .finally(() => setLoading(false));
  }, []);

  useEffect(load, [load]);

  if (loading) return <div className="page container"><Loading rows={3} /></div>;

  if (!signedIn) {
    return (
      <div className="page container">
        <h1>My account</h1>
        <Empty title="Sign in to see your trips">
          <p className="muted" style={{ maxWidth: 460 }}>
            Your bookings live against your mobile number. Sign in with a one-time
            code and anything you already booked on that number appears here.
          </p>
          <Link className="btn btn-primary" href="/login?next=/account" style={{ marginTop: '.6rem' }}>
            Sign in
          </Link>
        </Empty>
      </div>
    );
  }

  const TABS: { id: Tab; label: string; count?: number }[] = [
    { id: 'upcoming', label: 'Upcoming trips', count: upcoming.length },
    { id: 'past', label: 'Past trips', count: past.length },
    { id: 'passengers', label: 'Saved passengers', count: passengers.length },
    { id: 'referrals', label: 'Invite a friend' },
    { id: 'devices', label: 'Devices', count: devices.length },
    { id: 'profile', label: 'Profile' },
  ];

  return (
    <div className="page container">
      <div className="row-between" style={{ alignItems: 'flex-start' }}>
        <div>
          <h1 style={{ marginBottom: '.3rem' }}>My account</h1>
          <p className="muted small" data-testid="account-identity">
            Signed in as <span className="mono">{profile?.phone}</span>
            {profile?.display_name ? ` · ${profile.display_name}` : ''}
          </p>
        </div>
        <button
          className="btn btn-ghost btn-sm"
          onClick={async () => { await signOut(); router.push('/'); }}
        >
          Sign out
        </button>
      </div>

      <div className="row" style={{ gap: '.3rem', margin: '1rem 0', borderBottom: '1px solid var(--line)', flexWrap: 'wrap' }}>
        {TABS.map((t) => (
          <button
            key={t.id}
            className="btn btn-ghost btn-sm"
            onClick={() => setTab(t.id)}
            style={{
              border: 0, borderRadius: 0, borderBottom: '2px solid',
              borderBottomColor: tab === t.id ? 'var(--brand)' : 'transparent',
              color: tab === t.id ? 'var(--ink)' : 'var(--muted)',
              fontWeight: tab === t.id ? 650 : 550,
            }}
          >
            {t.label}{typeof t.count === 'number' ? ` (${t.count})` : ''}
          </button>
        ))}
      </div>

      {error && <ErrorNotice message={error} onRetry={load} />}

      {tab === 'upcoming' && <TripList rows={upcoming} empty="No upcoming trips" cta />}
      {tab === 'past' && <TripList rows={past} empty="No past trips yet" />}

      {tab === 'passengers' && (
        passengers.length === 0
          ? <Empty title="No saved passengers" />
          : <div className="card">
              <table className="data">
                <thead><tr><th>Name</th><th>Gender</th><th>Age</th><th>ID</th></tr></thead>
                <tbody>
                  {passengers.map((p) => (
                    <tr key={p.id}>
                      <td><strong>{p.full_name}</strong></td>
                      <td>{p.gender || '—'}</td>
                      <td className="tnum">{p.age || '—'}</td>
                      <td className="mono small">{p.id_type} {p.id_number}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
      )}

      {tab === 'referrals' && referral && (
        <div className="stack">
          <div className="card card-pad stack" style={{ maxWidth: 560 }}>
            <h2 style={{ marginBottom: 0 }}>Your invite code</h2>
            <p className="muted small" style={{ marginBottom: '.4rem' }}>
              Share it. When someone signs up with it and takes their first paid
              trip, you get {taka(referral.reward_poisha)} off your next ticket.
            </p>
            <div className="mono" style={{ fontSize: '1.6rem', letterSpacing: '.12em' }}>
              {referral.code}
            </div>
          </div>
          {history.length > 0 && (
            <div className="card">
              <table className="data">
                <thead><tr><th>Code</th><th>Status</th><th>Reward</th><th>Coupon</th></tr></thead>
                <tbody>
                  {history.map((r) => (
                    <tr key={r.code}>
                      <td className="mono">{r.code}</td>
                      <td><StatusPill status={r.status} /></td>
                      <td className="tnum">{taka(r.reward_poisha)}</td>
                      <td className="mono small">{r.reward_code || '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {tab === 'devices' && (
        <div className="stack">
          <p className="muted small">
            Every sign-in is a session. Ending them all revokes the refresh tokens
            too, so a phone you no longer have cannot quietly renew itself.
          </p>
          <div className="card">
            <table className="data">
              <thead><tr><th>Device</th><th>Signed in</th><th>Last used</th><th /></tr></thead>
              <tbody>
                {devices.map((d) => (
                  <tr key={d.session_id}>
                    <td>{d.device}{d.current && <span className="pill pill-ok" style={{ marginLeft: '.4rem' }}>This one</span>}</td>
                    <td className="small muted">{dateTimeOf(d.created_at)}</td>
                    <td className="small muted">{dateTimeOf(d.last_seen_at)}</td>
                    <td className="mono small">{d.ip}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div>
            <button
              className="btn btn-ghost btn-sm"
              onClick={async () => { await signOutEverywhere(); await signOut(); router.push('/'); }}
            >
              Sign out everywhere
            </button>
          </div>
        </div>
      )}

      {tab === 'profile' && profile && <ProfileForm profile={profile} onSaved={load} />}
    </div>
  );
}

function ProfileForm({ profile, onSaved }: { profile: Profile; onSaved: () => void }) {
  const [name, setName] = useState(profile.display_name ?? '');
  const [email, setEmail] = useState(profile.email ?? '');
  const [lang, setLang] = useState(profile.lang ?? 'bn');
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);

  return (
    <form
      className="card card-pad stack"
      style={{ maxWidth: 520 }}
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true); setSaved(false);
        try {
          await updateProfile({ display_name: name, email, lang });
          setSaved(true);
          onSaved();
        } finally { setBusy(false); }
      }}
    >
      <dl className="kv">
        <dt>Mobile</dt><dd className="mono">{profile.phone}</dd>
      </dl>
      <label htmlFor="name">Name</label>
      <input id="name" value={name} onChange={(e) => setName(e.target.value)} />
      <label htmlFor="email">Email</label>
      <input id="email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
      <label htmlFor="lang">Language for messages</label>
      <select id="lang" value={lang} onChange={(e) => setLang(e.target.value)}>
        <option value="bn">বাংলা</option>
        <option value="en">English</option>
      </select>
      <p className="small muted" style={{ marginBottom: 0 }}>
        Your ticket confirmation, cancellation and refund messages are sent in this
        language.
      </p>
      <button className="btn btn-primary" disabled={busy} type="submit">
        {busy ? 'Saving…' : 'Save'}
      </button>
      {saved && <div className="notice notice-info small">Saved.</div>}
    </form>
  );
}

function TripList({ rows, empty, cta }: { rows: AccountBooking[]; empty: string; cta?: boolean }) {
  if (rows.length === 0) {
    return (
      <Empty title={empty}>
        {cta && <Link className="btn btn-primary" href="/search" style={{ marginTop: '.6rem' }}>Find a bus</Link>}
      </Empty>
    );
  }
  return (
    <div className="stack">
      {rows.map((b) => (
        <div className="card card-pad row-between" key={b.pnr}>
          <div>
            <div className="row" style={{ gap: '.5rem' }}>
              <strong>{b.origin} → {b.destination}</strong>
              <StatusPill status={b.status} />
            </div>
            <div className="small muted">
              {b.brand} · {dateTimeOf(b.depart_at)} · {b.seat_count} seat{b.seat_count > 1 ? 's' : ''} ·{' '}
              <span className="mono">{b.pnr}</span>
            </div>
          </div>
          <div className="row" style={{ gap: '.4rem' }}>
            <span className="tnum" style={{ fontWeight: 700 }}>{taka(b.total_poisha)}</span>
            <Link className="btn btn-ghost btn-sm" href={`/tickets/${b.pnr}`}>Ticket</Link>
            <Link className="btn btn-ghost btn-sm" href={`/manage/${b.pnr}`}>Manage</Link>
          </div>
        </div>
      ))}
    </div>
  );
}
