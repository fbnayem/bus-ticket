'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ApiError, type AccountBooking, type SavedPassenger } from '@/lib/api';
import { authed, isSignedIn, sessions, signOut, signOutEverywhere, updateProfile,
  type DeviceSession } from '@/lib/auth';
import { Empty, ErrorNotice, Loading, StatusPill } from '@/components/ui';
import { Ref } from '@/components/Ref';
import { Glyph } from '@/components/Glyph';
import { useLang } from '@/components/LangProvider';
import { LANGS, LANG_NAME } from '@/lib/i18n';

/**
 * The account area.
 *
 * The heading used to say "My account", which is a place; it now says "My
 * trips", which is a reason to come here. Nobody opens a bus app to visit their
 * account.
 *
 * The tab row was six buttons styled with inline borders that wrapped onto two
 * lines in Bangla and had no `role`, so a screen reader met six unrelated
 * buttons rather than a tab strip. It is now a real tablist that scrolls
 * sideways instead of wrapping, and the labels say what is behind them:
 * "Devices" — a word that means nothing to most readers — became "Where you are
 * signed in".
 */

type Tab = 'upcoming' | 'past' | 'passengers' | 'referrals' | 'devices' | 'profile';

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
  const { t, fmt } = useLang();
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
        <h1>{t('ac.title')}</h1>
        <Empty title={t('ac.signInTitle')}>
          <p className="muted" style={{ maxWidth: 460, margin: '0 auto' }}>{t('ac.signInBody')}</p>
          <Link className="btn btn-primary btn-lg" href="/login?next=/account"
                style={{ marginTop: '.9rem' }}>
            {t('li.title')}
          </Link>
        </Empty>
      </div>
    );
  }

  const TABS: { id: Tab; label: string; count?: number }[] = [
    { id: 'upcoming',   label: t('ac.tab.upcoming'),   count: upcoming.length },
    { id: 'past',       label: t('ac.tab.past'),       count: past.length },
    { id: 'passengers', label: t('ac.tab.passengers'), count: passengers.length },
    { id: 'referrals',  label: t('ac.tab.referrals') },
    { id: 'devices',    label: t('ac.tab.devices'),    count: devices.length },
    { id: 'profile',    label: t('ac.tab.profile') },
  ];

  return (
    <div className="page container">
      <div className="row-between" style={{ alignItems: 'flex-start' }}>
        <div>
          <h1 style={{ marginBottom: '.2rem' }}>{t('ac.title')}</h1>
          <p className="muted small" data-testid="account-identity" style={{ margin: 0 }}>
            {t('ac.signedInAs', { phone: profile?.phone ?? '' })}
            {profile?.display_name ? ` · ${profile.display_name}` : ''}
          </p>
        </div>
        <button className="btn btn-ghost btn-sm"
                onClick={async () => { await signOut(); router.push('/'); }}>
          {t('ac.signOut')}
        </button>
      </div>

      <div className="tabstrip" role="tablist" aria-label={t('ac.title')}>
        {TABS.map((x) => (
          <button
            key={x.id}
            role="tab"
            id={`tab-${x.id}`}
            aria-selected={tab === x.id}
            aria-controls={`panel-${x.id}`}
            onClick={() => setTab(x.id)}
          >
            {x.label}
            {typeof x.count === 'number' && <span className="t-count">{x.count}</span>}
          </button>
        ))}
      </div>

      {error && <ErrorNotice message={error} onRetry={load} />}

      <div role="tabpanel" id={`panel-${tab}`} aria-labelledby={`tab-${tab}`}>
        {tab === 'upcoming' && <TripList rows={upcoming} empty={t('ac.noUpcoming')} cta />}
        {tab === 'past' && <TripList rows={past} empty={t('ac.noPast')} />}

        {tab === 'passengers' && (
          passengers.length === 0
            ? <Empty title={t('ac.noPassengers')}>
                <p className="muted" style={{ maxWidth: 420, margin: '0 auto' }}>
                  {t('ac.passengersBody')}
                </p>
              </Empty>
            : <div className="stack-sm">
                {passengers.map((p) => (
                  <div className="pick" key={p.id} style={{ cursor: 'default' }}>
                    <span className="pick-glyph"><Glyph name="person" /></span>
                    <span className="pick-body">
                      <span className="pick-title">{p.full_name}</span>
                      <span className="pick-note">
                        {[p.gender, p.age ? String(p.age) : '', p.id_number ? `${p.id_type} ${p.id_number}` : '']
                          .filter(Boolean).join(' · ') || '—'}
                      </span>
                    </span>
                  </div>
                ))}
              </div>
        )}

        {tab === 'referrals' && referral && (
          <div className="stack">
            <div className="card card-pad stack-sm" style={{ maxWidth: 560 }}>
              <h2 style={{ marginBottom: 0, fontSize: '1.05rem' }}>{t('ac.inviteCode')}</h2>
              <p className="muted small" style={{ marginBottom: '.5rem' }}>
                {t('ac.inviteBody', { amount: fmt.taka(referral.reward_poisha) })}
              </p>
              <div className="coupon-code" style={{ fontSize: '1.7rem' }}>
                <Ref value={referral.code} copyable />
              </div>
            </div>
            {history.length > 0 && (
              <div className="card">
                <div className="card-head">{t('ac.inviteHistory')}</div>
                <div className="table-wrap">
                  <table className="data">
                    <thead>
                      <tr><th>{t('ac.inviteCode')}</th><th>{t('common.status')}</th><th /></tr>
                    </thead>
                    <tbody>
                      {history.map((r) => (
                        <tr key={r.code}>
                          <td><Ref value={r.code} /></td>
                          <td><StatusPill status={r.status} /></td>
                          <td className="tnum">{fmt.taka(r.reward_poisha)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </div>
        )}

        {tab === 'devices' && (
          <div className="stack">
            <p className="muted small" style={{ maxWidth: 560 }}>{t('ac.devicesBody')}</p>
            <div className="stack-sm">
              {devices.map((d) => (
                <div className="pick" key={d.session_id} style={{ cursor: 'default' }}>
                  <span className="pick-glyph"><Glyph name="phone" /></span>
                  <span className="pick-body">
                    <span className="pick-title">
                      {d.device}
                      {d.current && (
                        <span className="pill pill-ok" style={{ marginLeft: '.45rem' }}>
                          {t('ac.thisDevice')}
                        </span>
                      )}
                    </span>
                    {/*
                      The IP address used to be a column of its own, which told a
                      passenger nothing and looked like a leak. What answers
                      "should I be worried about this one?" is when it was last
                      used, so that is what the row says.
                    */}
                    <span className="pick-note">
                      {t('ac.lastUsed', { when: fmt.dateTime(d.last_seen_at) })}
                    </span>
                  </span>
                </div>
              ))}
            </div>
            <div>
              <button
                className="btn btn-ghost btn-sm"
                onClick={async () => { await signOutEverywhere(); await signOut(); router.push('/'); }}
              >
                {t('ac.signOutAll')}
              </button>
            </div>
          </div>
        )}

        {tab === 'profile' && profile && <ProfileForm profile={profile} onSaved={load} />}
      </div>
    </div>
  );
}

function ProfileForm({ profile, onSaved }: { profile: Profile; onSaved: () => void }) {
  const { t } = useLang();
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
      <div className="field">
        <span className="label">{t('ac.mobile')}</span>
        <Ref value={profile.phone} />
      </div>

      <div className="field">
        <label className="label" htmlFor="name">{t('ac.name')}</label>
        <input className="input" id="name" value={name} onChange={(e) => setName(e.target.value)} />
      </div>

      <div className="field">
        <label className="label" htmlFor="email">{t('ac.email')}</label>
        <input className="input" id="email" type="email" inputMode="email"
               value={email} onChange={(e) => setEmail(e.target.value)} />
      </div>

      <div className="field">
        <label className="label" htmlFor="lang">{t('ac.msgLang')}</label>
        <select className="select" id="lang" value={lang} onChange={(e) => setLang(e.target.value)}>
          {LANGS.map((l) => <option key={l} value={l}>{LANG_NAME[l]}</option>)}
        </select>
        <span className="hint">{t('ac.msgLangNote')}</span>
      </div>

      <button className="btn btn-primary" disabled={busy} type="submit">
        {busy ? t('ac.saving') : t('ac.save')}
      </button>
      {saved && <div className="notice notice-info small" role="status">{t('ac.saved')}</div>}
    </form>
  );
}

function TripList({ rows, empty, cta }: { rows: AccountBooking[]; empty: string; cta?: boolean }) {
  const { t, fmt } = useLang();

  if (rows.length === 0) {
    return (
      <Empty title={empty}>
        {cta && (
          <Link className="btn btn-primary btn-lg" href="/search" style={{ marginTop: '.7rem' }}>
            {t('ac.findBus')}
          </Link>
        )}
      </Empty>
    );
  }

  return (
    <div className="stack-sm">
      {rows.map((b) => (
        <div className="card card-pad" key={b.pnr}>
          <div className="row-between" style={{ alignItems: 'flex-start' }}>
            <div style={{ minWidth: 0 }}>
              <div className="row" style={{ gap: '.5rem' }}>
                <strong style={{ fontSize: '1.02rem' }}>{b.origin} → {b.destination}</strong>
                <StatusPill status={b.status} />
              </div>
              <div className="small muted" style={{ marginTop: '.15rem' }}>
                {fmt.dateTime(b.board_at)} · {b.brand} · {b.seat_count === 1 ? t('ac.seat1') : t('ac.seatsN', { count: b.seat_count })}
              </div>
              <div className="small muted">
                {t('find.label')} <Ref value={b.pnr} />
              </div>
            </div>
            <span className="tnum" style={{ fontWeight: 700, fontSize: '1.05rem' }}>
              {fmt.taka(b.total_poisha)}
            </span>
          </div>
          <div className="row" style={{ gap: '.5rem', marginTop: '.7rem' }}>
            <Link className="btn btn-ghost btn-sm" href={`/tickets/${b.pnr}`}>{t('ac.ticket')}</Link>
            <Link className="btn btn-ghost btn-sm" href={`/manage/${b.pnr}`}>{t('ac.manage')}</Link>
          </div>
        </div>
      ))}
    </div>
  );
}
