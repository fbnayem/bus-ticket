'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { api, ApiError } from '@/lib/api';
import { ErrorNotice } from '@/components/ui';

export default function ManageLookupPage() {
  const router = useRouter();
  const [pnr, setPnr] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const find = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const b = await api.booking(pnr.trim().toUpperCase());
      router.push(`/manage/${b.pnr}`);
    } catch (err) {
      setError((err as ApiError).message);
      setBusy(false);
    }
  };

  return (
    <div className="page container-narrow">
      <h1 style={{ marginBottom: '.4rem' }}>Manage your booking</h1>
      <p className="muted">
        Change, cancel or track a trip using the 6-character reference from your ticket.
      </p>

      <form className="card card-pad stack" onSubmit={find}>
        <div className="field">
          <label className="label" htmlFor="pnr">Booking reference (PNR)</label>
          <input
            id="pnr" className="input mono" required value={pnr}
            maxLength={6} placeholder="7VAFHL" autoComplete="off"
            style={{ letterSpacing: '.16em', textTransform: 'uppercase', fontSize: '1.1rem' }}
            onChange={(e) => setPnr(e.target.value.toUpperCase())}
          />
          <span className="hint">Printed at the top of your ticket and in your confirmation SMS.</span>
        </div>

        {error && <ErrorNotice message={error} />}

        <button className="btn btn-primary" type="submit" disabled={busy || pnr.length < 6}>
          {busy ? 'Looking up…' : 'Find booking'}
        </button>
      </form>

      <p className="small muted" style={{ marginTop: '1rem' }}>
        Lost your reference? <Link href="/account">Check your trips</Link> or{' '}
        <Link href="/support">contact support</Link>.
      </p>
    </div>
  );
}
