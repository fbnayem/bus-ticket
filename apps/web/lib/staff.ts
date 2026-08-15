// Staff-side API client and session.
//
// The passenger client in lib/api.ts is deliberately separate. These calls all
// carry a bearer token, all fail closed on 401, and every one of them can be
// refused by the server on a permission the browser does not get to evaluate.
// Anything this file hides from the UI is a courtesy, not a control: the
// server checks the same permission again on every request.

'use client';

import { API_BASE, ApiError } from './api';

const TOKEN_KEY = 'jatra.staff.token';

export interface Identity {
  staff_id: string;
  email: string;
  full_name: string;
  phone?: string;
  operator_id?: string;
  counter_id?: string;
  agency_id?: string;
  roles: string[];
  permissions: string[];
}

export interface Session {
  identity: Identity;
  home: string;
  context?: Record<string, string | boolean>;
  mfa_enabled?: boolean;
}

export const token = {
  get: () => (typeof window === 'undefined' ? null : localStorage.getItem(TOKEN_KEY)),
  set: (t: string) => localStorage.setItem(TOKEN_KEY, t),
  clear: () => localStorage.removeItem(TOKEN_KEY),
};

export async function staffCall<T>(
  path: string,
  init: { method?: string; body?: unknown } = {},
): Promise<T> {
  const t = token.get();
  let res: Response;
  try {
    res = await fetch(API_BASE + path, {
      method: init.method ?? 'GET',
      cache: 'no-store',
      headers: {
        'Content-Type': 'application/json',
        ...(t ? { Authorization: 'Bearer ' + t } : {}),
      },
      body: init.body ? JSON.stringify(init.body) : undefined,
    });
  } catch {
    throw new ApiError(0, 'network', 'The service is unreachable. Check the connection and try again.');
  }
  if (res.status === 401) {
    // The session is gone. Clear it so the next screen asks for a password
    // rather than showing a half-loaded workspace.
    token.clear();
    if (typeof window !== 'undefined' && !window.location.pathname.startsWith('/staff/login')) {
      window.location.href = '/staff/login?next=' + encodeURIComponent(window.location.pathname);
    }
    throw new ApiError(401, 'unauthenticated', 'Your session has ended.');
  }
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  let body: unknown;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    throw new ApiError(res.status, 'bad_response', 'The service returned something unexpected.');
  }
  if (!res.ok) {
    const e = body as { error?: string; message?: string };
    throw new ApiError(res.status, e.error ?? 'error', e.message ?? 'Something went wrong.', body);
  }
  return body as T;
}

export const sget = <T,>(p: string) => staffCall<T>(p);
export const spost = <T,>(p: string, body?: unknown) => staffCall<T>(p, { method: 'POST', body });

export async function login(email: string, password: string, totp?: string) {
  const res = await fetch(API_BASE + '/staff/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password, totp: totp ?? '' }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new ApiError(res.status, body.error ?? 'error', body.message ?? 'Sign-in failed.');
  }
  token.set(body.token);
  return body as Session & { token: string };
}

export async function logout() {
  try { await spost('/staff/logout'); } catch { /* the token is going either way */ }
  token.clear();
}

export const me = () => sget<Session>('/staff/me');

export const can = (id: Identity | null, perm: string) =>
  !!id && id.permissions.includes(perm);
