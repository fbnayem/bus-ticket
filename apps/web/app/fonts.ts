import localFont from 'next/font/local';

/**
 * The two faces, loaded through next/font/local.
 *
 * Anek Latin and Anek Bangla are one superfamily from Ek Type: shared vertical
 * metrics, shared stroke contrast, shared skeleton. That is what makes a
 * bilingual line — "আসন 4A · ৳1,200 · 22:30" — sit on one baseline without
 * per-component tuning, and it is why equal dignity between the scripts is a
 * property of the typeface rather than something we hand-correct forever.
 *
 * Both are subset and axis-clipped at build time from the upstream releases:
 *   Latin   448 KB → 69 KB   (wght 400–800, wdth 75–100, Latin + punctuation)
 *   Bangla  448 KB → 129 KB  (wght 400–800, width pinned, the whole Bengali block)
 * See scripts/build-fonts.sh. The Bengali subset deliberately keeps every
 * Bengali codepoint rather than only the strings in the catalogue, because
 * operator and place names arrive from the API — subsetting to known text would
 * render শ্যামলী পরিবহন in a fallback face.
 */

/**
 * Latin is preloaded on every page in both languages. It is not the "English
 * font": fares, seat numbers, PNRs, phone numbers and clock times are Latin in
 * BOTH locales, so a Bangla page needs it just as immediately.
 */
export const latin = localFont({
  src: './fonts/anek-latin-subset.woff2',
  variable: '--font-latin',
  display: 'swap',
  weight: '400 800',
  style: 'normal',
  preload: true,
  // Metrics of the system fallback, adjusted to Anek Latin, so the swap when
  // the webfont lands does not reflow the page on a slow connection.
  adjustFontFallback: 'Arial',
  declarations: [
    { prop: 'font-stretch', value: '75% 100%' },
    {
      prop: 'unicode-range',
      value: 'U+0000-00FF, U+0131, U+0152-0153, U+2000-206F, U+20AC, U+2122, U+2190-2193, U+2212',
    },
  ],
});

/**
 * Bengali is NOT preloaded, deliberately. A preload downloads regardless of
 * use, so preloading it would bill every English reader 129 KB they will never
 * render. Left to the @font-face, the browser discovers it while parsing CSS —
 * early enough on a Bangla page — and never requests it at all on an English
 * one, because no glyph in its unicode-range is ever painted.
 */
export const bangla = localFont({
  src: './fonts/anek-bangla-subset.woff2',
  variable: '--font-bangla',
  display: 'swap',
  weight: '400 800',
  style: 'normal',
  preload: false,
  adjustFontFallback: false,
  declarations: [
    // U+09F3 (৳) is the reason this range reaches past the Bengali block: the
    // taka sign is a Bengali codepoint that appears on every money figure in
    // both locales. Without it here, every price on the English site falls out
    // of this face and sits at the wrong cap height beside its own digits.
    { prop: 'unicode-range', value: 'U+0964-0965, U+0980-09FE, U+200C-200D, U+25CC' },
  ],
});

/** Applied to <html> so both families are in scope for the token stack. */
export const fontVars = `${latin.variable} ${bangla.variable}`;
