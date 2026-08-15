import { cookies } from 'next/headers';
import { DEFAULT_LANG, LANG_COOKIE, isLang, translator, type Lang, type T } from './i18n';

/**
 * Translation for server components.
 *
 * Kept separate from lib/i18n.ts because this imports next/headers, which a
 * client component may not touch — importing it from the shared module would
 * poison every client bundle that wanted a single string.
 *
 * Pages should reach for this rather than becoming client components in order
 * to translate. Rendering the funnel on the server is the reason readable text
 * appears on a slow phone before the JavaScript lands, and that advantage is
 * lost one 'use client' at a time.
 */

export async function getLang(): Promise<Lang> {
  const raw = (await cookies()).get(LANG_COOKIE)?.value;
  return isLang(raw) ? raw : DEFAULT_LANG;
}

export async function getT(): Promise<{ lang: Lang; t: T }> {
  const lang = await getLang();
  return { lang, t: translator(lang) };
}
