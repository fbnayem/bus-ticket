'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { isSignedIn } from '@/lib/auth';
import { useT } from './LangProvider';
import type { Key } from '@/lib/i18n';

const LINKS: { href: string; key: Key }[] = [
  { href: '/search', key: 'nav.search' },
  { href: '/offers', key: 'nav.offers' },
  { href: '/manage', key: 'nav.manage' },
  { href: '/support', key: 'nav.support' },
];

export function NavLinks() {
  const pathname = usePathname();
  const t = useT();
  // Read on the client after mount. Deciding this during render would make the
  // server and the browser disagree about the last link and hydrate badly.
  const [signedIn, setSignedIn] = useState(false);
  useEffect(() => setSignedIn(isSignedIn()), [pathname]);

  return (
    <nav className="site-nav" aria-label={t('nav.main')}>
      {LINKS.map((l) => (
        <Link
          key={l.href}
          href={l.href}
          aria-current={pathname === l.href || pathname.startsWith(l.href + '/') ? 'page' : undefined}
        >
          {t(l.key)}
        </Link>
      ))}
      {signedIn ? (
        <Link href="/account" aria-current={pathname.startsWith('/account') ? 'page' : undefined}>
          {t('nav.account')}
        </Link>
      ) : (
        <Link href="/login" aria-current={pathname.startsWith('/login') ? 'page' : undefined}>
          {t('nav.signin')}
        </Link>
      )}
    </nav>
  );
}
