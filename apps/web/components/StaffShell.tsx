'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { can, logout, me, token, type Session } from '@/lib/staff';

// The staff chrome, shared by all six workplaces.
//
// The nav is filtered by permission — but that is a courtesy so a Dispatcher is
// not shown a Finance link they cannot open. The server checks the same
// permission again on every request, so hiding a link is never the control.

export interface NavItem {
  href: string;
  label: string;
  perm?: string;
}

export interface AppDef {
  key: string;
  name: string;
  tagline: string;
  hue: string;
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
    hue: '#B45309', entry: 'counter.sell',
    nav: [
      { href: '/counter', label: 'Sell a ticket', perm: 'counter.sell' },
      { href: '/counter/quota', label: 'Offline quota', perm: 'counter.quota' },
      { href: '/counter/sales', label: "Today's sales", perm: 'counter.sell' },
      { href: '/counter/shift', label: 'Drawer & shift', perm: 'counter.shift' },
    ],
  },
  agent: {
    key: 'agent', name: 'Agent Portal', tagline: 'Sell against your wallet',
    hue: '#6D28D9', entry: 'wallet.sell',
    nav: [
      { href: '/agent', label: 'Wallet', perm: 'agent.read' },
      { href: '/agent/sell', label: 'Sell a ticket', perm: 'wallet.sell' },
      { href: '/agent/bookings', label: 'Bookings', perm: 'booking.read' },
      { href: '/agent/commissions', label: 'Commission', perm: 'agent.read' },
      { href: '/agent/recharge', label: 'Recharge', perm: 'agent.read' },
    ],
  },
  operator: {
    key: 'operator', name: 'Operator ERP', tagline: 'Run the fleet and the network',
    hue: '#0B6E4F', entry: 'trip.read',
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
    hue: '#1D4ED8', entry: 'operator.read', platformOnly: true,
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
    hue: '#0E7490', entry: 'support.read', platformOnly: true,
    nav: [
      { href: '/helpdesk', label: 'Find a booking', perm: 'support.read' },
      { href: '/helpdesk/cases', label: 'Cases', perm: 'support.read' },
    ],
  },
  driver: {
    key: 'driver', name: 'Driver & Crew', tagline: 'Your trips, your manifest',
    hue: '#374151', entry: 'driver.trip',
    nav: [
      { href: '/driver', label: 'My trips', perm: 'driver.trip' },
      { href: '/driver/scan', label: 'Board passengers', perm: 'boarding.scan' },
      { href: '/driver/incidents', label: 'Incidents', perm: 'driver.trip' },
    ],
  },
};

export function StaffShell({ app, children }: { app: string; children: React.ReactNode }) {
  const def = APPS[app];
  const router = useRouter();
  const pathname = usePathname();
  const [session, setSession] = useState<Session | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'denied'>('loading');

  useEffect(() => {
    if (!token.get()) {
      router.replace('/staff/login?next=' + encodeURIComponent(pathname));
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
      .catch(() => router.replace('/staff/login?next=' + encodeURIComponent(pathname)));
  }, [def, pathname, router]);

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
    <div className="staff" style={{ ['--app' as string]: def.hue }}>
      <aside className="staff-rail">
        <div className="staff-brand">
          <span className="staff-dot" aria-hidden="true" />
          <div>
            <strong>{def.name}</strong>
            <div className="small muted">{def.tagline}</div>
          </div>
        </div>

        <nav className="staff-nav">
          {nav.map((n) => {
            const active = pathname === n.href || (n.href !== '/' + app && pathname.startsWith(n.href));
            return (
              <Link key={n.href} href={n.href} aria-current={active ? 'page' : undefined}>
                {n.label}
              </Link>
            );
          })}
        </nav>

        <div className="staff-foot">
          <div className="small muted">Signed in as</div>
          <strong>{id.full_name}</strong>
          <div className="small muted">{scope}</div>
          <div className="row" style={{ gap: '.3rem', marginTop: '.4rem' }}>
            {id.roles.map((r) => (
              <span className="pill" key={r} style={{ fontSize: '.68rem' }}>{r.replace(/_/g, ' ')}</span>
            ))}
          </div>
          <div className="row" style={{ gap: '.4rem', marginTop: '.7rem' }}>
            <Link className="btn btn-ghost btn-sm" href="/staff">Switch</Link>
            <button
              className="btn btn-ghost btn-sm"
              onClick={async () => { await logout(); router.replace('/staff/login'); }}
            >
              Sign out
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
