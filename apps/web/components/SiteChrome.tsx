'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { NavLinks } from './NavLinks';
import { MobileNav } from './MobileNav';
import { LanguageSwitcher, useLang } from './LangProvider';

// The passenger site's header and footer.
//
// Staff workplaces get their own chrome from StaffShell, so this steps out of
// the way on those routes rather than stacking two navigations on top of each
// other. Keeping the decision in one client component means the root layout
// stays a server component.

const STAFF_PREFIXES = ['/staff', '/counter', '/agent', '/operator', '/admin', '/helpdesk', '/driver'];

export function SiteChrome({ children }: { children: React.ReactNode }) {
  const pathname = usePathname() ?? '/';
  const { t, lang } = useLang();
  const isStaff = STAFF_PREFIXES.some((p) => pathname === p || pathname.startsWith(p + '/'));

  if (isStaff) return <>{children}</>;

  return (
    <>
      <header className="site-header">
        <div className="container inner">
          <Link href="/" className="brandmark" aria-label={`${t('brand.name')} — ${t('nav.main')}`}>
            <BusMark />
            <span>{t('brand.name')}</span>
          </Link>
          <NavLinks />
          <LanguageSwitcher compact />
        </div>
      </header>

      <main>{children}</main>

      <footer className="site-footer">
        <div className="container">
          <div className="row-between">
            <div>
              <strong style={{ color: 'var(--ink)' }}>{t('brand.name')}</strong> — {t('brand.tagline')}
              <div className="small" style={{ marginTop: '.2rem' }}>
                {lang === 'bn'
                  ? 'প্রতিটি চ্যানেল একই কেন্দ্রীয় আসন তালিকা থেকে বুক করে।'
                  : 'Every channel books from one central seat inventory.'}
              </div>
            </div>
            <div className="row" style={{ gap: '1rem' }}>
              <Link href="/offers">{t('nav.offers')}</Link>
              <Link href="/support">{t('nav.support')}</Link>
              <Link href="/manage">{t('nav.manage')}</Link>
              <Link href="/staff/login">{t('nav.staff')}</Link>
            </div>
          </div>
          <p className="small" style={{ marginTop: '1rem', marginBottom: 0 }}>
            {lang === 'bn'
              ? 'ডেভেলপমেন্ট বিল্ড। পেমেন্ট স্যান্ডবক্সে চলে, কোনো আসল টাকা লেনদেন হয় না।'
              : 'Development build. Payments run against a sandbox provider and no money moves.'}
          </p>
        </div>
      </footer>

      <MobileNav />
    </>
  );
}

/**
 * The mark sits on the enamel fascia, so its body is drawn in the fascia's own
 * foreground — currentColor — rather than in the brand green it used to use,
 * which is now the colour of the plane behind it. Only the headlamps are chrome
 * yellow, which is the one place the mark colour is allowed outside an action:
 * a coach's lining picked out on a painted flank.
 */
function BusMark() {
  return (
    <svg width="26" height="26" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <rect x="3" y="3" width="18" height="14" rx="2.5" fill="currentColor" />
      <rect x="5.5" y="5.8" width="5.2" height="4.2" rx=".8" fill="var(--field)" />
      <rect x="13.3" y="5.8" width="5.2" height="4.2" rx=".8" fill="var(--field)" />
      <circle cx="7.5" cy="13.6" r="1.15" fill="var(--mark)" />
      <circle cx="16.5" cy="13.6" r="1.15" fill="var(--mark)" />
      <rect x="5" y="17" width="3" height="3.2" rx="1" fill="currentColor" />
      <rect x="16" y="17" width="3" height="3.2" rx="1" fill="currentColor" />
    </svg>
  );
}
