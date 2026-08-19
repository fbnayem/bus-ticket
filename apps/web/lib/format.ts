// Money is stored and transported as integer poisha (1/100 BDT). It is only
// ever divided at the moment of display — never in arithmetic.

export function taka(poisha: number, opts: { decimals?: boolean } = {}): string {
  const v = poisha / 100;
  return '৳' + v.toLocaleString('en-BD', {
    minimumFractionDigits: opts.decimals ? 2 : 0,
    maximumFractionDigits: opts.decimals ? 2 : 0,
  });
}

const DHAKA = 'Asia/Dhaka';

export function timeOf(iso: string): string {
  return new Date(iso).toLocaleTimeString('en-GB', {
    hour: '2-digit', minute: '2-digit', timeZone: DHAKA,
  });
}

export function dateOf(iso: string): string {
  return new Date(iso).toLocaleDateString('en-GB', {
    weekday: 'short', day: 'numeric', month: 'short', timeZone: DHAKA,
  });
}

export function dateTimeOf(iso: string): string {
  return `${dateOf(iso)}, ${timeOf(iso)}`;
}

export function duration(minutes: number): string {
  if (!minutes) return '—';
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return h ? (m ? `${h}h ${m}m` : `${h}h`) : `${m}m`;
}

export function isoDate(d: Date): string {
  // Local calendar date, not UTC — a 1am Dhaka departure must not shift a day.
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function relativeDay(iso: string): string {
  const target = new Date(iso);
  const today = new Date();
  const days = Math.round(
    (new Date(isoDate(target)).getTime() - new Date(isoDate(today)).getTime()) / 864e5);
  if (days === 0) return 'Today';
  if (days === 1) return 'Tomorrow';
  if (days === -1) return 'Yesterday';
  return dateOf(iso);
}

// The sales channels, in the words a person uses. A passenger reading their
// booking history and a clerk reading a manifest should both see "On the bus",
// never the enum ONBOARD. Defined once so the dashboard, the manifest and every
// booking list say the same thing.
export const CHANNEL_LABEL: Record<string, string> = {
  WEB: 'Website',
  APP: 'Mobile app',
  COUNTER: 'Counter',
  COUNTER_OFFLINE: 'Counter (offline)',
  ONBOARD: 'On the bus',
  AGENT: 'Agent',
  PARTNER: 'Partner API',
};

export function channelLabel(code: string): string {
  return CHANNEL_LABEL[code] ?? code.replace(/_/g, ' ').toLowerCase();
}

export const AMENITY_LABEL: Record<string, string> = {
  WIFI: 'Wi-Fi',
  CHARGING: 'Charging point',
  WATER: 'Water bottle',
  BLANKET: 'Blanket',
  SNACK: 'Snack',
};

export const SEAT_TYPE_LABEL: Record<string, string> = {
  NORMAL: 'Standard',
  BUSINESS: 'Business',
  SLEEPER: 'Sleeper berth',
  PREMIUM: 'Premium',
  FEMALE_RESERVED: 'Reserved for women',
  ACCESSIBLE: 'Accessible',
  BLOCKED: 'Not for sale',
  CREW: 'Crew',
};

/**
 * Booking states, mapped to the pill styles in globals.css.
 *
 * PAYMENT_PENDING and REFUND_PENDING used to be amber. They are not warnings —
 * nothing has gone wrong and nobody needs to act. They are waiting on something
 * external: a provider webhook that has not landed yet. Rendering them amber
 * told a passenger their money might be in trouble at exactly the moment the
 * honest message was "we are still hearing back from bKash", which is the one
 * screen where this product either earns its 1,200 taka of trust or does not.
 *
 * They are now 'inflight'. Amber is left for the cases where a human really is
 * needed, which is what makes amber worth noticing again.
 */
export type Tone = 'ok' | 'warn' | 'danger' | 'brand' | 'inflight' | '';

export function statusTone(status: string): Tone {
  switch (status) {
    case 'TICKETED':
    case 'CONFIRMED':
    case 'COMPLETED':
      return 'ok';
    case 'PAYMENT_PENDING':
    case 'CREATED':
    case 'REFUND_PENDING':
      return 'inflight';
    case 'CANCELLED':
    case 'FAILED':
    case 'EXPIRED':
      return 'danger';
    case 'REFUNDED':
    case 'PARTIALLY_REFUNDED':
      return 'brand';
    default:
      return '';
  }
}

export function statusLabel(status: string): string {
  return status.replace(/_/g, ' ').toLowerCase().replace(/^./, (c) => c.toUpperCase());
}
