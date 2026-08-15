'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';
import { isSignedIn } from '@/lib/auth';
import { useT } from './LangProvider';
import type { Key } from '@/lib/i18n';

/**
 * The phone navigation.
 *
 * The header nav worked in English and broke in Bangla: five labels plus a
 * language pair do not fit 360px when "Manage booking" is "বুকিং দেখুন", and it
 * wrapped to two lines. Rather than abbreviate the Bangla — which is how a
 * translated product ends up feeling second-class — the navigation moves to
 * where a thumb can reach it and the header keeps only identity and language.
 *
 * It stands down inside the booking funnel. Once a passenger is holding seats
 * against a countdown, the screen should offer one action, not five ways to
 * abandon it; the sticky action bar owns the bottom of the screen there.
 */

const FUNNEL = ['/checkout', '/payment', '/confirmation'];

const TABS: { href: string; key: Key; icon: React.ReactNode }[] = [
  { href: '/search',  key: 'nav.search', icon: <IconSearch /> },
  { href: '/offers',  key: 'nav.offers', icon: <IconTag /> },
  { href: '/manage',  key: 'nav.manage', icon: <IconTicket /> },
];

export function MobileNav() {
  const pathname = usePathname() ?? '/';
  const t = useT();
  const [signedIn, setSignedIn] = useState(false);
  useEffect(() => setSignedIn(isSignedIn()), [pathname]);

  if (FUNNEL.some((p) => pathname.startsWith(p))) return null;

  const last = signedIn
    ? { href: '/account', key: 'nav.account' as Key, icon: <IconUser /> }
    : { href: '/login', key: 'nav.signin' as Key, icon: <IconUser /> };

  return (
    <nav className="mobilenav" aria-label={t('nav.main')}>
      {[...TABS, last].map((tab) => {
        const active = pathname === tab.href || pathname.startsWith(tab.href + '/');
        return (
          <Link
            key={tab.href}
            href={tab.href}
            className="mobilenav-tab"
            aria-current={active ? 'page' : undefined}
          >
            <span className="mobilenav-icon" aria-hidden="true">{tab.icon}</span>
            <span className="mobilenav-label">{t(tab.key)}</span>
          </Link>
        );
      })}
    </nav>
  );
}

/* Inline rather than an icon package: four glyphs do not justify a dependency,
   and every kilobyte here is paid for on a 4G connection. currentColor lets the
   active state drive them without a second set. */

function IconSearch() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9"
         strokeLinecap="round" strokeLinejoin="round">
      <circle cx="11" cy="11" r="7" /><path d="m20 20-3.6-3.6" />
    </svg>
  );
}

function IconTag() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9"
         strokeLinecap="round" strokeLinejoin="round">
      <path d="M3.5 11.4V4.5a1 1 0 0 1 1-1h6.9a1 1 0 0 1 .7.3l8.1 8.1a1 1 0 0 1 0 1.4l-6.9 6.9a1 1 0 0 1-1.4 0L3.8 12.1a1 1 0 0 1-.3-.7Z" />
      <circle cx="7.8" cy="7.8" r="1.4" fill="currentColor" stroke="none" />
    </svg>
  );
}

function IconTicket() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9"
         strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 8.5V6.4a1 1 0 0 1 1-1h16a1 1 0 0 1 1 1v2.1a2.6 2.6 0 0 0 0 7v2.1a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-2.1a2.6 2.6 0 0 0 0-7Z" />
      <path d="M14 6.5v11" strokeDasharray="2 2.6" />
    </svg>
  );
}

function IconUser() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9"
         strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="8" r="3.8" />
      <path d="M4.5 20a7.5 7.5 0 0 1 15 0" />
    </svg>
  );
}
