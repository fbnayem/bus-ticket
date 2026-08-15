'use client';

import { createContext, useCallback, useContext, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import {
  DEFAULT_LANG, LANG_COOKIE, LANGS, LANG_NAME,
  dateIn, durationIn, relativeDayIn, takaIn, timeIn, translator,
  type Lang, type T,
} from '@/lib/i18n';

/**
 * The language a passenger reads, available everywhere.
 *
 * The value is decided on the SERVER from a cookie and handed down, so the very
 * first HTML byte is already in the right language. Switching writes the cookie
 * and asks Next to re-render on the server rather than swapping strings in the
 * browser — that keeps one source of truth and means a shared link opens in the
 * language the reader chose, not the language the writer had.
 */

interface Ctx {
  lang: Lang;
  t: T;
  setLang: (l: Lang) => void;
  /** Formatters bound to the current language, so callers never pass it twice. */
  fmt: {
    date: (iso: string) => string;
    time: (iso: string) => string;
    dateTime: (iso: string) => string;
    day: (iso: string) => string;
    duration: (minutes: number) => string;
    taka: (poisha: number, opts?: { decimals?: boolean }) => string;
  };
}

const LangCtx = createContext<Ctx | null>(null);

export function LangProvider({ lang, children }: { lang: Lang; children: React.ReactNode }) {
  const router = useRouter();

  const setLang = useCallback((next: Lang) => {
    // A year, path-wide, lax: this is a display preference, not a credential.
    document.cookie = `${LANG_COOKIE}=${next}; path=/; max-age=31536000; samesite=lax`;
    document.documentElement.lang = next;
    router.refresh();
  }, [router]);

  const value = useMemo<Ctx>(() => {
    const t = translator(lang);
    return {
      lang,
      t,
      setLang,
      fmt: {
        date: (iso) => dateIn(lang, iso),
        time: (iso) => timeIn(lang, iso),
        dateTime: (iso) => `${dateIn(lang, iso)}, ${timeIn(lang, iso)}`,
        day: (iso) => relativeDayIn(lang, iso),
        duration: (m) => durationIn(lang, m),
        taka: (p, opts) => takaIn(lang, p, opts),
      },
    };
  }, [lang, setLang]);

  return <LangCtx.Provider value={value}>{children}</LangCtx.Provider>;
}

/**
 * Falls back to the default language rather than throwing when a component is
 * rendered outside the provider. A missing provider should never be the reason
 * a passenger cannot see their ticket.
 */
export function useLang(): Ctx {
  const ctx = useContext(LangCtx);
  if (ctx) return ctx;
  const lang = DEFAULT_LANG;
  const t = translator(lang);
  return {
    lang, t, setLang: () => {},
    fmt: {
      date: (iso) => dateIn(lang, iso),
      time: (iso) => timeIn(lang, iso),
      dateTime: (iso) => `${dateIn(lang, iso)}, ${timeIn(lang, iso)}`,
      day: (iso) => relativeDayIn(lang, iso),
      duration: (m) => durationIn(lang, m),
      taka: (p, opts) => takaIn(lang, p, opts),
    },
  };
}

/** Shorthand for the common case. */
export function useT(): T {
  return useLang().t;
}

/* ------------------------------------------------------------------ switcher */

/**
 * Two languages, both always visible. A dropdown would hide Bangla behind a tap
 * and imply English is the default state of the product; a visible pair says
 * neither is a fallback for the other. Bangla sits first because it is the
 * default and the majority reading.
 */
export function LanguageSwitcher({ compact = false }: { compact?: boolean }) {
  const { lang, setLang, t } = useLang();

  return (
    <div className="langswitch" role="group" aria-label={t('nav.language')}>
      {LANGS.map((l) => (
        <button
          key={l}
          type="button"
          lang={l}
          className="langswitch-opt"
          aria-pressed={lang === l}
          onClick={() => setLang(l)}
        >
          {compact ? (l === 'bn' ? 'বাং' : 'EN') : LANG_NAME[l]}
        </button>
      ))}
    </div>
  );
}
