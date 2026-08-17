'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { can, logout, me, token, type Session } from '@/lib/staff';
import { LanguageSwitcher, useT } from './LangProvider';
import type { Key } from '@/lib/i18n';

// The staff chrome, shared by all six workplaces.
//
// The nav is filtered by permission — but that is a courtesy so a Dispatcher is
// not shown a Finance link they cannot open. The server checks the same
// permission again on every request, so hiding a link is never the control.

export interface NavItem {
  href: string;
  label: string;
  /** Set on the three frontline workplaces, which are bilingual. */
  labelKey?: Key;
  perm?: string;
}

/**
 * THE WORKPLACE HUE LADDER.
 *
 * Each workplace paints its rail spine, its dot and its bars in one colour, so
 * a person knows at a glance which of the six they are looking at. That colour
 * therefore must not be a colour that already means something.
 *
 * It was. Measured against the semantic palette, four of the six sat within
 * 25° of a status colour, and two were effectively identical to one:
 *
 *   counter   #B45309   6° from --warn      an amber rail in the one workplace
 *                                           that raises drawer warnings all day
 *   operator  #0B6E4F   2° from --field     and 6° from --ok
 *   admin     #1D4ED8  13° from --inflight
 *   driver    #374151  20° from --inflight, and mid-slate reads as disabled —
 *                                           the worst possible choice for a
 *                                           screen used outdoors in daylight
 *
 * The replacements clear every semantic hue by more than 45°, except one that
 * is deliberate: the Operator ERP is painted in --field, the platform's own
 * chrome green, the same colour as the passenger site's header. That is not a
 * near-miss of --ok, it IS the brand, and being unmistakably darker and deeper
 * than the success green is what separates them.
 *
 * `hueDark` exists because a rail spine at 17% lightness disappears against a
 * dark ground. Only the value moves; the hue is the identity and stays put.
 */
export interface AppDef {
  key: string;
  name: string;
  tagline: string;
  hue: string;
  /** The same identity, lifted for a dark ground. */
  hueDark: string;
  /** True for the workplaces used on a phone, out of doors, by one hand. */
  handheld?: boolean;
  /**
   * Bilingual workplaces get the language pair in their rail. The three
   * back-office consoles do not, because offering a switch that changes only
   * the chrome and leaves the ledger in English is worse than not offering it.
   */
  nameKey?: Key;
  taglineKey?: Key;
  // The permission that admits someone to this workplace at all. Kept separate
  // from the first nav item because they are different questions: a Dispatcher
  // legitimately holds operator.read for their own operator, which must not
  // hand them the platform-wide admin console.
  entry: string;
  // True for workplaces that see across operators. Operator- and agency-scoped
  // staff are turned away regardless of which permissions they hold.
  platformOnly?: boolean;
  nav: NavItem[];
}

export const APPS: Record<string, AppDef> = {
  counter: {
    key: 'counter', name: 'Counter POS', tagline: 'Sell, print, balance the drawer',
    nameKey: 'co.app', taglineKey: 'co.appNote',
    hue: '#8E2F72', hueDark: '#D178B4', entry: 'counter.sell',
    nav: [
      { href: '/counter', label: 'Sell a ticket', labelKey: 'co.nav.sell', perm: 'counter.sell' },
      { href: '/counter/quota', label: 'Offline quota', labelKey: 'co.nav.quota', perm: 'counter.quota' },
      { href: '/counter/sales', label: "Today's sales", labelKey: 'co.nav.sales', perm: 'counter.sell' },
      { href: '/counter/shift', label: 'Drawer & shift', labelKey: 'co.nav.shift', perm: 'counter.shift' },
    ],
  },
  agent: {
    key: 'agent', name: 'Agent Portal', tagline: 'Sell against your wallet',
    nameKey: 'ag.app', taglineKey: 'ag.appNote',
    hue: '#7A3AA8', hueDark: '#BC8FE0', entry: 'wallet.sell',
    nav: [
      { href: '/agent', label: 'Wallet', labelKey: 'ag.nav.wallet', perm: 'agent.read' },
      { href: '/agent/sell', label: 'Sell a ticket', labelKey: 'ag.nav.sell', perm: 'wallet.sell' },
      { href: '/agent/bookings', label: 'Bookings', labelKey: 'ag.nav.bookings', perm: 'booking.read' },
      { href: '/agent/commissions', label: 'Commission', labelKey: 'ag.nav.commissions', perm: 'agent.read' },
      { href: '/agent/recharge', label: 'Recharge', labelKey: 'ag.nav.recharge', perm: 'agent.read' },
    ],
  },
  operator: {
    key: 'operator', name: 'Operator ERP', tagline: 'Run the fleet and the network',
    hue: '#0B4A38', hueDark: '#4FBE94', entry: 'trip.read',
    nav: [
      { href: '/operator', label: 'Dashboard', perm: 'trip.read' },
      { href: '/operator/control', label: 'Control centre', perm: 'ops.monitor' },
      { href: '/operator/trips', label: 'Trips', perm: 'trip.read' },
      { href: '/operator/bookings', label: 'Bookings', perm: 'booking.read' },
      { href: '/operator/fleet', label: 'Fleet', perm: 'fleet.read' },
      { href: '/operator/routes', label: 'Routes & fares', perm: 'route.read' },
      { href: '/operator/schedules', label: 'Schedules', perm: 'schedule.read' },
      { href: '/operator/counters', label: 'Counters', perm: 'operator.read' },
      { href: '/operator/staff', label: 'Staff & roles', perm: 'staff.read' },
      { href: '/operator/settlements', label: 'Settlements', perm: 'settlement.read' },
      { href: '/operator/reports', label: 'Reports', perm: 'report.read' },
    ],
  },
  admin: {
    key: 'admin', name: 'Admin Console', tagline: 'The whole platform',
    hue: '#2F4A7A', hueDark: '#8FAEE0', entry: 'operator.read', platformOnly: true,
    nav: [
      { href: '/admin', label: 'Overview', perm: 'operator.read' },
      { href: '/admin/operators', label: 'Operators', perm: 'operator.read' },
      { href: '/admin/agents', label: 'Agencies', perm: 'agent.read' },
      { href: '/admin/recharges', label: 'Wallet recharges', perm: 'wallet.approve' },
      { href: '/admin/bookings', label: 'Bookings', perm: 'booking.read' },
      { href: '/admin/payments', label: 'Payments', perm: 'payment.read' },
      { href: '/admin/ledger', label: 'Ledger', perm: 'ledger.read' },
      { href: '/admin/settlements', label: 'Settlements', perm: 'settlement.read' },
      { href: '/admin/recon', label: 'Reconciliation', perm: 'recon.read' },
      { href: '/admin/campaigns', label: 'Campaigns', perm: 'promo.read' },
      { href: '/admin/notifications', label: 'Notifications', perm: 'notify.read' },
      { href: '/admin/risk', label: 'Risk & fraud', perm: 'risk.read' },
      { href: '/admin/partners', label: 'Partners', perm: 'partner.read' },
      { href: '/admin/events', label: 'Event backbone', perm: 'events.read' },
      { href: '/admin/staff', label: 'Staff & roles', perm: 'staff.read' },
      { href: '/admin/audit', label: 'Audit log', perm: 'audit.read' },
      { href: '/admin/health', label: 'System health', perm: 'system.health' },
    ],
  },
  helpdesk: {
    key: 'helpdesk', name: 'Support Console', tagline: 'Every question about any booking',
    hue: '#0E7490', hueDark: '#5AC0D8', entry: 'support.read', platformOnly: true,
    nav: [
      { href: '/helpdesk', label: 'Find a booking', perm: 'support.read' },
      { href: '/helpdesk/cases', label: 'Cases', perm: 'support.read' },
    ],
  },
  driver: {
    key: 'driver', name: 'Driver & Crew', tagline: 'Your trips, your manifest',
    nameKey: 'dr.app', taglineKey: 'dr.appNote',
    hue: '#2C3138', hueDark: '#C6CEDA', entry: 'driver.trip', handheld: true,
    nav: [
      { href: '/driver', label: 'My trips', labelKey: 'dr.nav.trips', perm: 'driver.trip' },
      { href: '/driver/scan', label: 'Board passengers', labelKey: 'dr.nav.scan', perm: 'boarding.scan' },
      { href: '/driver/incidents', label: 'Incidents', labelKey: 'dr.nav.incidents', perm: 'driver.trip' },
    ],
  },
};

export function StaffShell({ app, children }: { app: string; children: React.ReactNode }) {
  const def = APPS[app];
  const t = useT();
  const router = useRouter();
  const pathname = usePathname();
  const [session, setSession] = useState<Session | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'denied'>('loading');

  // The path is read through a ref so that moving between screens inside a
  // workplace does not re-run the effect below.
  //
  // It used to depend on `pathname`, which meant every click in every staff
  // workplace fired a fresh /staff/session round trip and re-derived the
  // permissions that had not changed. Worse, it made ordinary navigation
  // fragile: a slow or failed session call *during* a page change threw the
  // person back to the login screen mid-task, and the two in-flight
  // navigations occasionally raced and dumped them back on their home screen.
  // A session is established when the workplace is entered, not on every step
  // taken inside it.
  const pathRef = useRef(pathname);
  pathRef.current = pathname;

  useEffect(() => {
    const toLogin = () =>
      router.replace('/staff/login?next=' + encodeURIComponent(pathRef.current));
    if (!token.get()) {
      toLogin();
      return;
    }
    me()
      .then((s) => {
        setSession(s);
        // Landing on a workplace you hold no permission for is a wrong turn,
        // not an error — send the person where they actually work.
        const held = s.identity.permissions.includes(def.entry);
        const scoped = !def.platformOnly || (!s.identity.operator_id && !s.identity.agency_id);
        setState(held && scoped ? 'ready' : 'denied');
      })
      .catch(toLogin);
  }, [def, router]);

  if (state === 'loading') {
    return (
      <div className="staff-boot">
        <div className="skeleton" style={{ width: 200, height: 14 }} />
      </div>
    );
  }

  if (state === 'denied' || !session) {
    return (
      <div className="staff-boot stack" style={{ alignItems: 'center', textAlign: 'center' }}>
        <h2>{def.name} is not open to your role</h2>
        <p className="muted" style={{ maxWidth: 460 }}>
          You are signed in as {session?.identity.full_name} ({session?.identity.roles.join(', ')}).
          That role does not include the permissions this workspace needs.
        </p>
        <Link className="btn btn-primary" href={session?.home ?? '/staff'}>
          Go to your workspace
        </Link>
      </div>
    );
  }

  const id = session.identity;
  const nav = def.nav.filter((n) => !n.perm || can(id, n.perm));
  const scope =
    session.context?.counter_name ??
    session.context?.agency_name ??
    session.context?.operator_brand ??
    'Platform';

  return (
    // Both values are handed to CSS, which picks one per theme. An inline style
    // cannot answer a media query, so the choice has to live in the stylesheet.
    <div
      className="staff"
      data-app={def.key}
      data-handheld={def.handheld ? '' : undefined}
      style={{
        ['--app-light' as string]: def.hue,
        ['--app-dark' as string]: def.hueDark,
      }}
    >
      <aside className="staff-rail">
        <div className="staff-brand">
          <span className="staff-dot" aria-hidden="true" />
          <div style={{ minWidth: 0 }}>
            <strong>{def.nameKey ? t(def.nameKey) : def.name}</strong>
            <div className="small muted">
              {def.taglineKey ? t(def.taglineKey) : def.tagline}
            </div>
          </div>
        </div>

        {/*
          The language pair, on the three workplaces that actually speak both.
          It is deliberately absent from the Admin, Operator and Support
          consoles: a switch that translates the chrome and leaves the ledger
          in English promises something the product does not deliver.
        */}
        {def.nameKey && (
          <div className="staff-lang">
            <LanguageSwitcher />
          </div>
        )}

        <nav className="staff-nav">
          {nav.map((n) => {
            const active = pathname === n.href || (n.href !== '/' + app && pathname.startsWith(n.href));
            return (
              <Link key={n.href} href={n.href} aria-current={active ? 'page' : undefined}>
                {n.labelKey ? t(n.labelKey) : n.label}
              </Link>
            );
          })}
        </nav>

        <div className="staff-foot">
          <div className="small muted">{t('st.signedInAs')}</div>
          <strong>{id.full_name}</strong>
          <div className="small muted">{scope}</div>
          <div className="row" style={{ gap: '.3rem', marginTop: '.4rem' }}>
            {id.roles.map((r) => (
              <span className="pill" key={r} style={{ fontSize: '.68rem' }}>{r.replace(/_/g, ' ')}</span>
            ))}
          </div>
          <div className="row" style={{ gap: '.4rem', marginTop: '.7rem' }}>
            <Link className="btn btn-ghost btn-sm" href="/staff">{t('st.switch')}</Link>
            <button
              className="btn btn-ghost btn-sm"
              onClick={async () => { await logout(); router.replace('/staff/login'); }}
            >
              {t('st.signOut')}
            </button>
          </div>
        </div>
      </aside>

      <div className="staff-main">{children}</div>
    </div>
  );
}

// useSession is for pages that need the identity themselves — the counter needs
// its counter_id, the agent needs their agency.
export function useSession() {
  const [session, setSession] = useState<Session | null>(null);
  useEffect(() => { me().then(setSession).catch(() => setSession(null)); }, []);
  return session;
}
