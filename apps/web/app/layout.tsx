import type { Metadata } from 'next';
import { cookies } from 'next/headers';
import './globals.css';
import { SiteChrome } from '@/components/SiteChrome';
import { LangProvider } from '@/components/LangProvider';
import { fontVars } from './fonts';
import { DEFAULT_LANG, LANG_COOKIE, isLang, translator, type Lang } from '@/lib/i18n';

/**
 * The language is resolved here, on the server, before a single byte is sent.
 *
 * This matters more than it looks. Competing Bangladeshi ticketing sites ship
 * client-rendered shells that show a spinner until their JavaScript arrives —
 * on the low-end Android and 4G that most of this market actually uses, that is
 * seconds of blank screen. Server-rendering readable text immediately is our
 * advantage, and putting the language preference in a cookie rather than
 * localStorage is what keeps it: the server already knows which language to
 * render, so there is no English-then-Bangla flip after hydration.
 */
async function resolveLang(): Promise<Lang> {
  const raw = (await cookies()).get(LANG_COOKIE)?.value;
  return isLang(raw) ? raw : DEFAULT_LANG;
}

export async function generateMetadata(): Promise<Metadata> {
  const lang = await resolveLang();
  const t = translator(lang);
  const title = `${t('brand.name')} — ${t('brand.tagline')}`;
  return {
    title: { default: title, template: `%s · ${t('brand.name')}` },
    description:
      lang === 'bn'
        ? 'সারা বাংলাদেশে বাসের টিকিট খুঁজুন, তুলনা করুন এবং বুক করুন। সরাসরি খালি আসন, তাৎক্ষণিক ই-টিকিট, বিকাশ ও নগদ।'
        : 'Search, compare and book bus tickets across Bangladesh. Live seat availability, instant e-tickets, bKash and Nagad.',
    alternates: { languages: { bn: '/', en: '/' } },
  };
}

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const lang = await resolveLang();

  return (
    <html lang={lang} data-lang={lang} className={fontVars}>
      <body>
        <LangProvider lang={lang}>
          <SiteChrome>{children}</SiteChrome>
        </LangProvider>
      </body>
    </html>
  );
}
