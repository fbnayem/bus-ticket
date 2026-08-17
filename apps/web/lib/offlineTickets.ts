/**
 * Keeping a ticket on the device.
 *
 * The homepage promises, in both languages, that **your ticket works without
 * signal**, and the FAQ repeats it: once the page has been opened it keeps
 * working. The app kept that promise. The website did not — the ticket page
 * fetched `/bookings/{pnr}` on mount and showed an error when that failed, so
 * the one page a passenger needs at a bus door was the one page that needed a
 * bus-door signal.
 *
 * A ticket is the right thing, and close to the only thing, to keep here. The
 * argument the counter's service worker makes against caching the passenger
 * site — a stale seat map is worse than an error — does not apply to a ticket,
 * for a specific reason: **nothing on this page is a claim about seat state.**
 * It is a record of a purchase the platform already made, and the QR on it is a
 * signed token the crew's scanner verifies against the platform at the door. A
 * stale copy cannot get anybody aboard who should not be; the scan decides that,
 * and it decides it somewhere else.
 *
 * Two rules follow, and they are what keep this honest:
 *
 *   - **The freshest answer always wins and is always written down.** A ticket
 *     cancelled since it was last seen overwrites the copy here the moment the
 *     platform says so, so a refund does not leave a valid-looking ticket in a
 *     pocket forever.
 *   - **A copy read from here says it came from here**, on the screen, in
 *     words. A passenger who has been offline for three days should know that
 *     what they are looking at is a photograph rather than a live answer.
 */

import type { Booking } from './api';

const KEY = 'jatra.tickets';

/** Everything remembered, newest first. Never throws — storage may be denied. */
function all(): Booking[] {
  if (typeof localStorage === 'undefined') return [];
  try {
    const raw = localStorage.getItem(KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? (parsed as Booking[]) : [];
  } catch {
    // Private browsing, a full quota, or something else's data under our key.
    // A ticket that cannot be cached is a ticket that needs a signal, which is
    // where we started — not a reason to take the page down.
    return [];
  }
}

/**
 * Write down what the platform just said about this booking.
 *
 * Overwrites any previous copy, deliberately: the point is that the newest
 * truth replaces the old one, including "this was cancelled".
 */
export function rememberTicket(b: Booking): void {
  if (typeof localStorage === 'undefined' || !b?.pnr) return;
  try {
    const kept = [b, ...all().filter((x) => x.pnr !== b.pnr)].slice(0, 20);
    localStorage.setItem(KEY, JSON.stringify(kept));
  } catch {
    /* see all() — storage is a convenience here, never a dependency */
  }
}

/** The copy on this device, if there is one. */
export function recallTicket(pnr: string): Booking | null {
  return all().find((b) => b.pnr === pnr) ?? null;
}
