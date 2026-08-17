import Link from 'next/link';

/**
 * The handful of pictures this product actually needs.
 *
 * Not an icon library. A passenger-facing bus product needs about eight
 * pictures, and shipping a package of nine hundred to get them would cost more
 * bytes than the Bangla font does — on the connection this is read over, that
 * is the difference between seeing your ticket at the bus door and not.
 *
 * They are drawn on a 24-grid with a 1.75 stroke, which is heavy enough to
 * survive the 38px tinted square they sit in without turning into a blob, and
 * they inherit `currentColor` so a glyph in a danger-tinted square is the
 * danger colour without a second copy of the file.
 *
 * Every one of these is decorative: the row it sits in always carries the same
 * meaning in words, because a picture of a bus is not a label and someone using
 * a screen reader is owed the sentence, not the drawing.
 */

export type GlyphName =
  | 'ticket' | 'pin' | 'clock' | 'cross' | 'phone' | 'chat'
  | 'wallet' | 'seat' | 'person' | 'chevron';

const PATHS: Record<GlyphName, React.ReactNode> = {
  // a stub with a torn edge
  ticket: (
    <>
      <path d="M3 8.5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v1.2a2.3 2.3 0 0 0 0 4.6v1.2a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-1.2a2.3 2.3 0 0 0 0-4.6Z" />
      <path d="M14 6.5v11" strokeDasharray="2 2.4" />
    </>
  ),
  // a map pin, for "where is it"
  pin: (
    <>
      <path d="M12 21s6.5-6.1 6.5-10.5a6.5 6.5 0 1 0-13 0C5.5 14.9 12 21 12 21Z" />
      <circle cx="12" cy="10.5" r="2.4" />
    </>
  ),
  // a clock with its hands turned back, for "change the time"
  clock: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 7.2V12l3.4 2" />
    </>
  ),
  cross: <path d="M6.4 6.4 17.6 17.6M17.6 6.4 6.4 17.6" />,
  phone: (
    <path d="M6.2 3.8h3l1.5 3.8-1.9 1.4a12.5 12.5 0 0 0 6.2 6.2l1.4-1.9 3.8 1.5v3a1.8 1.8 0 0 1-2 1.8A16.6 16.6 0 0 1 4.4 5.8a1.8 1.8 0 0 1 1.8-2Z" />
  ),
  chat: (
    <path d="M20.5 12.4c0 4-3.8 7.2-8.5 7.2a9.8 9.8 0 0 1-2.8-.4L4 20.8l1.4-3.6a6.9 6.9 0 0 1-2-4.8C3.4 8.4 7.2 5.2 12 5.2s8.5 3.2 8.5 7.2Z" />
  ),
  wallet: (
    <>
      <path d="M3.5 8.2a2 2 0 0 1 2-2h11.3a2 2 0 0 1 2 2v.6" />
      <path d="M3.5 8.2v8.6a2 2 0 0 0 2 2h13a2 2 0 0 0 2-2v-6a2 2 0 0 0-2-2h-15" />
      <circle cx="16.4" cy="13.1" r="1.05" fill="currentColor" stroke="none" />
    </>
  ),
  seat: (
    <>
      <path d="M7.5 4.5h5a2.5 2.5 0 0 1 2.5 2.5v6.5H7.5Z" />
      <path d="M6 13.5h12a1.5 1.5 0 0 1 1.5 1.5v4.5h-15V15A1.5 1.5 0 0 1 6 13.5Z" />
    </>
  ),
  person: (
    <>
      <circle cx="12" cy="8" r="3.4" />
      <path d="M5.2 20a6.8 6.8 0 0 1 13.6 0" />
    </>
  ),
  chevron: <path d="M9.5 5.5 16 12l-6.5 6.5" />,
};

export function Glyph({ name, size = 20 }: { name: GlyphName; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {PATHS[name]}
    </svg>
  );
}

/**
 * One tappable choice: a picture, what it does, and what happens if you tap it.
 *
 * The note is the point. "Change the time" alone makes a passenger guess
 * whether it costs money; "Move to another departure" answers it before the
 * tap. Rows without a note read as a list of jargon.
 */
export function Pick({
  glyph, title, note, end, danger, chosen, ...rest
}: {
  glyph: GlyphName;
  title: React.ReactNode;
  note?: React.ReactNode;
  end?: React.ReactNode;
  danger?: boolean;
  chosen?: boolean;
} & React.ComponentPropsWithoutRef<'button'>) {
  return (
    <button
      type="button"
      className={`pick${danger ? ' is-danger' : ''}${chosen ? ' is-chosen' : ''}`}
      {...rest}
    >
      <span className="pick-glyph"><Glyph name={glyph} /></span>
      <span className="pick-body">
        <span className="pick-title">{title}</span>
        {note && <span className="pick-note">{note}</span>}
      </span>
      {end ? <span className="pick-end">{end}</span> : <Glyph name="chevron" size={16} />}
    </button>
  );
}

/** The same row when tapping it goes somewhere rather than does something. */
export function PickLink({
  href, glyph, title, note,
}: { href: string; glyph: GlyphName; title: React.ReactNode; note?: React.ReactNode }) {
  return (
    <Link href={href} className="pick">
      <span className="pick-glyph"><Glyph name={glyph} /></span>
      <span className="pick-body">
        <span className="pick-title">{title}</span>
        {note && <span className="pick-note">{note}</span>}
      </span>
      <Glyph name="chevron" size={16} />
    </Link>
  );
}
