'use client';

import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { api, type Location } from '@/lib/api';
import { useLang } from './LangProvider';

/**
 * A place field that suggests instead of accepting.
 *
 * The field it replaces was an `<input list="...">` over a datalist of seven
 * cities. Two things were wrong with that, and only one of them was the seven.
 *
 * A datalist is a *hint*: the browser will happily submit whatever was typed,
 * so "Chittagon" left the form as "Chittagon" and came back as "we don't
 * recognise that departure city" — the passenger spelled their own city
 * nearly right and the product told them they were wrong. This is a combobox:
 * the value that leaves it is always a place the platform knows, because it
 * is only ever set by choosing one.
 *
 * What the list shows, and why:
 *
 *   - The name in the reader's own language, with the other one beside it.
 *     Somebody typing চট্টগ্রাম should see চট্টগ্রাম; somebody who only knows
 *     it as Chittagong needs to see it is the same row.
 *   - The district under a terminal, so Mohipal is Mohipal · Feni and the
 *     several -ganj towns are told apart without local knowledge.
 *   - An honest "no buses yet" on places we do not serve. We show them anyway.
 *     Hiding Bandarban from a person who lives in Bandarban makes the field
 *     look broken; saying we don't go there yet is a fact they can act on.
 *
 * The query goes to the platform on every keystroke (debounced), not to a
 * cached copy of the gazetteer. 113 places is small enough to ship to the
 * browser, but it will not stay 113, and a stale local list that silently
 * omits a new terminal is the kind of bug nobody finds for a year.
 */
/**
 * Canonical name → Bangla name, learned from every answer the platform gives.
 *
 * The committed value of a place field is always the canonical name — it is
 * what goes into the URL, the API call and the saved route, and it must not
 * change with the reader's language. But a Bangla reader should see ঢাকা in
 * the box, not Dhaka, and the value alone does not say what ঢাকা is.
 *
 * Module scope rather than component state on purpose: both ends of a journey
 * and every page that mounts a picker share one table, so the second field
 * costs nothing and a navigation does not re-ask.
 */
const bnNames = new Map<string, string>();

export function LocationPicker({
  id,
  label,
  value,
  onChange,
  placeholder,
  inputRef,
  required = true,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (name: string) => void;
  placeholder?: string;
  inputRef?: React.RefObject<HTMLInputElement | null>;
  required?: boolean;
}) {
  const { t, lang } = useLang();
  const listId = useId();

  // `text` is what is in the box; `value` is the committed place. They differ
  // only while somebody is typing, and typing without choosing reverts.
  const [text, setText] = useState(value);
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<Location[]>([]);
  const [active, setActive] = useState(0);
  const [loading, setLoading] = useState(false);

  const boxRef = useRef<HTMLDivElement>(null);
  const ownRef = useRef<HTMLInputElement>(null);
  const field = inputRef ?? ownRef;
  // Guards a slow response from overwriting a newer one — without it, a laggy
  // reply for "ch" can land after "chattogram" and repopulate the old list.
  const seq = useRef(0);

  /** What to show for a committed place, in the reader's own language. */
  const shown = useCallback(
    (name: string) => (lang === 'bn' ? bnNames.get(name) ?? name : name),
    [lang],
  );

  const learn = (ls: Location[]) => {
    for (const l of ls) if (l.name_bn) bnNames.set(l.name, l.name_bn);
  };

  useEffect(() => { setText(shown(value)); }, [value, shown]);

  // A Bangla reader arriving with a place already chosen — from the URL, or a
  // saved route — has a canonical name and no Bangla for it yet. One lookup
  // fills it in; after that the table above answers for the whole session.
  useEffect(() => {
    if (lang !== 'bn' || !value || bnNames.has(value)) return;
    let live = true;
    api.locations(value, 1)
      .then((r) => {
        learn(r.locations);
        if (live && bnNames.has(value)) setText(bnNames.get(value)!);
      })
      .catch(() => {});
    return () => { live = false; };
  }, [value, lang]);

  const fetchFor = useCallback(async (q: string) => {
    const mine = ++seq.current;
    setLoading(true);
    try {
      const r = await api.locations(q, 8);
      if (mine === seq.current) { learn(r.locations); setItems(r.locations); setActive(0); }
    } catch {
      if (mine === seq.current) setItems([]);
    } finally {
      if (mine === seq.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    const h = setTimeout(() => { void fetchFor(text.trim()); }, 140);
    return () => clearTimeout(h);
  }, [text, open, fetchFor]);

  // A click anywhere else commits nothing and puts the chosen place back.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) {
        setOpen(false);
        setText(shown(value));
      }
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open, value, shown]);

  const choose = (l: Location) => {
    if (l.name_bn) bnNames.set(l.name, l.name_bn);
    // The canonical name is what leaves the field; the box shows whichever
    // name this reader reads.
    onChange(l.name);
    setText(lang === 'bn' && l.name_bn ? l.name_bn : l.name);
    setOpen(false);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (!open && (e.key === 'ArrowDown' || e.key === 'Enter')) { setOpen(true); return; }
    if (!open) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive((i) => Math.min(i + 1, items.length - 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((i) => Math.max(i - 1, 0)); }
    else if (e.key === 'Enter') {
      // Enter inside an open list picks; it must not also submit the form,
      // or choosing a city would fire the search with the previous one.
      if (items[active]) { e.preventDefault(); choose(items[active]); }
    } else if (e.key === 'Escape') { e.preventDefault(); setOpen(false); setText(shown(value)); }
    else if (e.key === 'Tab') { if (items[active]) choose(items[active]); }
  };

  const empty = open && !loading && text.trim() !== '' && items.length === 0;

  return (
    <div className="field place-field" ref={boxRef}>
      <label className="label" htmlFor={id}>{label}</label>
      <input
        ref={field}
        id={id}
        className="input"
        value={text}
        autoComplete="off"
        spellCheck={false}
        role="combobox"
        aria-expanded={open}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={open && items[active] ? `${listId}-${active}` : undefined}
        placeholder={placeholder ?? t('place.search')}
        required={required}
        // Selecting the existing value on focus is what stops the classic
        // "DhakaChattogram" — the field already holds a place, and somebody
        // changing their mind types the new one straight over it.
        onFocus={(e) => { e.currentTarget.select(); setOpen(true); void fetchFor(text.trim()); }}
        onChange={(e) => { setText(e.target.value); setOpen(true); }}
        onKeyDown={onKeyDown}
      />

      {open && (items.length > 0 || empty) && (
        <ul className="place-list" id={listId} role="listbox" aria-label={label}>
          {items.map((l, i) => (
            <li
              key={l.id}
              id={`${listId}-${i}`}
              role="option"
              aria-selected={i === active}
              className={`place-opt${i === active ? ' is-active' : ''}`}
              onMouseEnter={() => setActive(i)}
              // mousedown, not click: the input's blur would close the list
              // first and the click would land on nothing.
              onMouseDown={(e) => { e.preventDefault(); choose(l); }}
            >
              <span className="place-main">
                <span className="place-name">{lang === 'bn' && l.name_bn ? l.name_bn : l.name}</span>
                <span className="place-alt muted small">
                  {lang === 'bn' ? l.name : l.name_bn}
                </span>
              </span>
              <span className="place-meta small muted">
                {l.kind === 'TERMINAL' && <span className="place-kind">{t('place.terminal')}</span>}
                {l.parent && <span className="place-parent">{l.parent}</span>}
                {!l.served && <span className="place-cold">{t('place.noBuses')}</span>}
              </span>
            </li>
          ))}
          {empty && (
            <li className="place-empty">
              <strong>{t('place.noMatch')}</strong>
              <span className="muted small">{t('place.noMatchHint')}</span>
            </li>
          )}
        </ul>
      )}
    </div>
  );
}
