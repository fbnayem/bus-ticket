// Typed client for the platform REST API.
//
// Errors from the API carry a machine-readable `error` code and a `message`
// written for a passenger. We surface the message verbatim rather than
// inventing our own copy, so the API stays the single source of wording.

export const API_BASE =
  process.env.NEXT_PUBLIC_API_BASE ?? 'http://localhost:8080/api/v1';

export class ApiError extends Error {
  code: string;
  status: number;
  // The full response body. Some refusals are answers, not failures — a
  // boarding scan that returns ALREADY_BOARDED is exactly the verdict the crew
  // needs to see, and it arrives with a non-2xx status.
  body?: unknown;
  constructor(status: number, code: string, message: string, body?: unknown) {
    super(message);
    this.code = code;
    this.status = status;
    this.body = body;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(API_BASE + path, {
      ...init,
      cache: 'no-store',
      headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
    });
  } catch {
    throw new ApiError(0, 'network', 'We could not reach the booking service. Check your connection and try again.');
  }
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  let body: unknown;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    throw new ApiError(res.status, 'bad_response', 'The booking service returned something unexpected.');
  }
  if (!res.ok) {
    const e = body as { error?: string; message?: string };
    throw new ApiError(res.status, e.error ?? 'error', e.message ?? 'Something went wrong. Please try again.');
  }
  return body as T;
}

const get = <T,>(p: string) => request<T>(p);
const post = <T,>(p: string, body?: unknown) =>
  request<T>(p, { method: 'POST', body: body ? JSON.stringify(body) : undefined });
const del = <T,>(p: string) => request<T>(p, { method: 'DELETE' });

/* ----------------------------------------------------------------- types */

export interface Location { id: string; name: string; kind: string }

export interface SearchResult {
  trip_id: string;
  operator_id: string;
  brand: string;
  bus_type: string;
  is_ac: boolean;
  class: string;
  registration: string;
  depart_at: string;
  arrive_at: string;
  duration_min: number;
  board_seq: number;
  drop_seq: number;
  origin: string;
  destination: string;
  fare_poisha: number;
  available_seats: number;
  total_seats: number;
  amenities: string[];
}

export interface SearchResponse {
  origin: string; destination: string; date: string;
  count: number; results: SearchResult[];
}

export interface Stop { seq: number; name: string; at: string }

export interface Trip {
  trip_id: string; brand: string; operator_id: string;
  bus_type: string; is_ac: boolean; class: string; registration: string;
  route_name: string; depart_at: string; segment_count: number;
  amenities: string[]; stops: Stop[];
  fare_poisha: number; board_seq: number; drop_seq: number; duration_min: number;
}

export interface Seat {
  seat_no: string; seat_type: string; deck: number; row: number; col: number;
  available: boolean; sold: boolean; held: boolean; blocked: boolean;
}

export interface SeatMap {
  trip_id: string; segment_count: number;
  board_seq: number; drop_seq: number; seats: Seat[];
}

export interface Price {
  fare_poisha: number; seat_count: number; base_poisha: number;
  service_fee_poisha: number; discount_poisha: number; total_poisha: number;
  coupon_code?: string;
}

export interface Hold {
  hold_id: string; trip_id: string; seats: string[];
  board_seq: number; drop_seq: number; expires_at: string; price: Price;
}

export interface Passenger {
  seat_no: string; full_name: string; gender?: string; age?: number;
  id_type?: string; id_number?: string;
}

export interface BookingCreated {
  booking_id: string; pnr: string; price: Price; seats: string[]; trip_id: string;
}

export interface Ticket {
  ticket_id: string; seat_no: string; qr_token: string; status: string; passenger: string;
}

export interface Booking {
  pnr: string; booking_id: string; status: string; total_poisha: number;
  channel: string; created_at: string; trip_id: string;
  brand: string; bus_type: string; registration: string; depart_at: string;
  origin: string; destination: string; board_seq: number; drop_seq: number;
  phone: string; email: string; seats: string[]; tickets: Ticket[];
  refund?: { status: string; amount_poisha: number };
}

export interface CancellationQuote {
  pnr: string; total_poisha: number; depart_at: string;
  hours_before: number; refund_pct: number; refund_poisha: number;
  fee_poisha: number; cancellable: boolean; reason?: string;
}

export interface TrackingStop extends Stop { passed: boolean; lat: number; lng: number }

export interface Tracking {
  pnr: string; trip_id: string; state: string;
  depart_at: string; arrive_at: string; progress: number;
  stops: TrackingStop[]; position: { lat: number; lng: number };
  source: string; source_note: string;
  next_stop?: string; eta?: string;
}

export interface Offer {
  code: string; title: string; description: string;
  discount_pct: number; discount_poisha: number;
  max_discount_poisha: number; min_amount_poisha: number; ends_at: string | null;
}

export interface AccountBooking {
  pnr: string; status: string; total_poisha: number; depart_at: string;
  brand: string; origin: string; destination: string; seat_count: number; upcoming: boolean;
}

export interface RescheduleOption {
  trip_id: string; brand: string; bus_type: string; depart_at: string;
  board_seq: number; drop_seq: number; fare_poisha: number;
  available_seats: number; eligible: boolean;
}

export interface SavedPassenger {
  id: string; full_name: string; gender: string; age: number;
  id_type: string; id_number: string;
}

/* --------------------------------------------------------------- endpoints */

export const api = {
  locations: (q = '') => get<{ locations: Location[] }>(`/locations?q=${encodeURIComponent(q)}`),

  search: (from: string, to: string, date: string) =>
    get<SearchResponse>(`/search?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&date=${date}`),

  trip: (id: string, board: number, drop: number) =>
    get<Trip>(`/trips/${id}?board=${board}&drop=${drop}`),

  seatmap: (id: string, board: number, drop: number) =>
    get<SeatMap>(`/trips/${id}/seatmap?board=${board}&drop=${drop}`),

  createHold: (b: { trip_id: string; seats: string[]; board_seq: number; drop_seq: number }) =>
    post<Hold>('/holds', { ...b, channel: 'WEB' }),

  getHold: (id: string) =>
    get<{ hold_id: string; trip_id: string; status: string; expires_at: string; seats: string[]; expired: boolean }>(`/holds/${id}`),

  releaseHold: (id: string) => del<void>(`/holds/${id}`),

  createBooking: (b: {
    hold_id: string; passengers: Passenger[];
    phone: string; email?: string; coupon_code?: string;
  }) => post<BookingCreated>('/bookings', b),

  booking: (pnr: string) => get<Booking>(`/bookings/${pnr}`),

  paymentIntent: (booking_id: string, provider: string) =>
    post<{ payment_ref: string; provider: string; amount_poisha: number; pnr: string; redirect_url: string }>(
      '/payments/intent', { booking_id, provider }),

  completeSandboxPayment: (payment_ref: string, outcome: 'success' | 'failure') =>
    post<{ status: string; pnr: string; confirmed: boolean; first_delivery: boolean }>(
      '/payments/sandbox/complete', { payment_ref, outcome }),

  cancellationQuote: (pnr: string) => get<CancellationQuote>(`/bookings/${pnr}/cancellation-quote`),
  cancel: (pnr: string, reason: string) => post<CancellationQuote>(`/bookings/${pnr}/cancel`, { reason }),
  settleRefund: (pnr: string) => post<{ status: string }>(`/bookings/${pnr}/settle-refund`),

  rescheduleOptions: (pnr: string) =>
    get<{ seat_count: number; options: RescheduleOption[] }>(`/bookings/${pnr}/reschedule-options`),

  reschedule: (pnr: string, b: { trip_id: string; seats: string[]; board_seq: number; drop_seq: number }) =>
    post<{
      old_pnr: string; new_pnr: string; new_booking_id: string; hold_id: string;
      old_total_poisha: number; new_total_poisha: number; difference_poisha: number;
      payable: boolean; refundable: boolean;
    }>(`/bookings/${pnr}/reschedule`, b),

  tracking: (pnr: string) => get<Tracking>(`/tracking/${pnr}`),
  offers: () => get<{ offers: Offer[] }>('/offers'),

  accountBookings: (phone?: string) =>
    get<{ upcoming: AccountBooking[]; past: AccountBooking[]; phone: string }>(
      `/account/bookings${phone ? `?phone=${encodeURIComponent(phone)}` : ''}`),

  savedPassengers: () => get<{ passengers: SavedPassenger[] }>('/account/passengers'),

  profile: () => get<{ display_name: string; phone: string; email: string; authenticated: boolean; note: string }>(
    '/account/profile'),
};
