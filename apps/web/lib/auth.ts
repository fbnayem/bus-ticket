// Passenger sign-in.
//
// Deliberately separate from lib/staff.ts. A passenger and a staff member are
// different subjects with different token lifetimes and different consequences
// for getting it wrong, and one shared client would let a bug in either one
// reach the other.
//
// The access token is short-lived by design, so the refresh token does the
// work. Refreshing rotates BOTH: presenting a refresh token twice means
// somebody else has a copy, and the server responds by revoking every session
// descended from that sign-in. That is why this file never retries a refresh —
// a second attempt with a spent token is exactly the pattern the server treats
// as theft.

'use client';

import { API_BASE, ApiError } from './api';

const ACCESS = 'jatra.pax.access';
const REFRESH = 'jatra.pax.refresh';

export interface PassengerIdentity {
  user_id: string;
  phone: string;
  email?: string;
  display_name?: string;
  is_guest: boolean;
}

export interface DeviceSession {
  session_id: string;
  device: string;
  ip?: string;
  created_at: string;
  last_seen_at: string;
  current: boolean;
}

const store = {
  access: () => (typeof window === 'undefined' ? null : localStorage.getItem(ACCESS)),
  refresh: () => (typeof window === 'undefined' ? null : localStorage.getItem(REFRESH)),
  set(access: string, refresh: string) {
    localStorage.setItem(ACCESS, access);
    localStorage.setItem(REFRESH, refresh);
  },
  clear() {
    localStorage.removeItem(ACCESS);
    localStorage.removeItem(REFRESH);
  },
};

export const isSignedIn = () => !!store.access();

async function raw<T>(path: string, init: { method?: string; body?: unknown; token?: string | null } = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(API_BASE + path, {
      method: init.method ?? 'GET',
      cache: 'no-store',
      headers: {
        'Content-Type': 'application/json',
        ...(init.token ? { Authorization: 'Bearer ' + init.token } : {}),
      },
      body: init.body ? JSON.stringify(init.body) : undefined,
    });
  } catch {
    throw new ApiError(0, 'network', 'We could not reach the service. Check your connection.');
  }
  const text = await res.text();
  let body: unknown;
  try { body = text ? JSON.parse(text) : {}; } catch { body = {}; }
  if (!res.ok) {
    const e = body as { error?: string; message?: string };
    throw new ApiError(res.status, e.error ?? 'error', e.message ?? 'Something went wrong.', body);
  }
  return body as T;
}

// authed makes a call with the access token, refreshing once if it has expired.
export async function authed<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  try {
    return await raw<T>(path, { ...init, token: store.access() });
  } catch (e) {
    if (!(e instanceof ApiError) || e.status !== 401) throw e;
    const ok = await refresh();
    if (!ok) throw e;
    return raw<T>(path, { ...init, token: store.access() });
  }
}

export async function refresh(): Promise<boolean> {
  const rt = store.refresh();
  if (!rt) return false;
  try {
    const r = await raw<{ access_token: string; refresh_token: string }>(
      '/auth/refresh', { method: 'POST', body: { refresh_token: rt, device: deviceName() } });
    store.set(r.access_token, r.refresh_token);
    return true;
  } catch {
    // Either the token expired, or it was already used and the family has been
    // revoked. Both mean sign in again; neither is worth a second attempt.
    store.clear();
    return false;
  }
}

export function deviceName(): string {
  if (typeof navigator === 'undefined') return 'browser';
  const ua = navigator.userAgent;
  const browser = /Edg\//.test(ua) ? 'Edge'
    : /Chrome\//.test(ua) ? 'Chrome'
    : /Firefox\//.test(ua) ? 'Firefox'
    : /Safari\//.test(ua) ? 'Safari' : 'browser';
  const os = /Windows/.test(ua) ? 'Windows'
    : /Android/.test(ua) ? 'Android'
    : /iPhone|iPad/.test(ua) ? 'iOS'
    : /Mac OS/.test(ua) ? 'macOS'
    : /Linux/.test(ua) ? 'Linux' : '';
  return os ? `${browser} on ${os}` : browser;
}

export async function requestCode(phone: string, lang = 'bn') {
  return raw<{ sent: boolean; expires_in_seconds: number; debug_code?: string; notice?: string }>(
    '/auth/otp/request', { method: 'POST', body: { phone, lang } });
}

export async function verifyCode(phone: string, code: string) {
  const r = await raw<{
    access_token: string; refresh_token: string;
    identity: PassengerIdentity; bookings_claimed: number;
  }>('/auth/otp/verify', { method: 'POST', body: { phone, code, device: deviceName() } });
  store.set(r.access_token, r.refresh_token);
  return r;
}

export async function signInWithPassword(login: string, password: string) {
  const r = await raw<{ access_token: string; refresh_token: string; identity: PassengerIdentity }>(
    '/auth/password/login', { method: 'POST', body: { login, password, device: deviceName() } });
  store.set(r.access_token, r.refresh_token);
  return r;
}

export async function signOut() {
  try { await authed('/auth/logout', { method: 'POST' }); } catch { /* the token is going either way */ }
  store.clear();
}

export const whoAmI = () =>
  authed<{ signed_in: boolean; identity?: PassengerIdentity }>('/auth/me');

export const sessions = () => authed<{ sessions: DeviceSession[] }>('/auth/sessions');
export const signOutEverywhere = () => authed('/auth/sessions/revoke-all', { method: 'POST' });
export const setPassword = (password: string) =>
  authed('/auth/password/set', { method: 'POST', body: { password } });
export const updateProfile = (body: { display_name?: string; email?: string; lang?: string }) =>
  authed('/auth/profile', { method: 'PATCH', body });
