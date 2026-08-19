'use client';

import { useState } from 'react';
import Link from 'next/link';
import { ApiError } from '@/lib/api';
import { sget } from '@/lib/staff';
import { ErrorNotice, StatusPill } from '@/components/ui';
import { PageHead, Money } from '@/components/staff-ui';
import { dateTimeOf, timeOf, channelLabel } from '@/lib/format';

// One search box. A passenger on the phone will give you whatever they have —
// a PNR, the number they booked with, an email, a name, or the transaction id
// from their bKash SMS. All of them work here.

interface Result {
  pnr: string; status: string; channel: string; total_poisha: number;
  created_at: string; operator: string; depart_at: string;
  phone: string; email: string; passenger: string; seats: string;
}

export default function HelpdeskSearchPage() {
  const [q, setQ] = useState('');
  const [results, setResults] = useState<Result[] | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const search = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true); setError(''); setResults(null);
    try {
      const r = await sget<{ results: Result[] }>(`/helpdesk/search?q=${encodeURIComponent(q)}`);
      setResults(r.results);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'The search failed.');
    } finally { setBusy(false); }
  };

  return (
    <div className="stack">
      <PageHead
        title="Find a booking"
        sub="PNR, mobile number, email, passenger name or a provider transaction id"
      />

      <form className="card card-pad" onSubmit={search}>
        <div className="row" style={{ gap: '.6rem' }}>
          <input
            className="input" style={{ flex: 1 }} value={q} onChange={(e) => setQ(e.target.value)}
            placeholder="e.g. K7W4VP or +8801711111111" aria-label="Search"
          />
          <button className="btn btn-primary" type="submit" disabled={busy || q.length < 3}>
            {busy ? 'Searching…' : 'Search'}
          </button>
        </div>
      </form>

      {error && <ErrorNotice message={error} />}

      {results && (
        results.length === 0 ? (
          <div className="empty">
            <h3>Nothing found</h3>
            <p className="muted">
              Try the number the passenger booked with rather than the one they are
              calling from — they are often different.
            </p>
          </div>
        ) : (
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>PNR</th><th>Passenger</th><th>Contact</th><th>Departure</th>
                  <th>Seats</th><th>Channel</th><th className="num">Paid</th><th>Status</th><th />
                </tr>
              </thead>
              <tbody>
                {results.map((r) => (
                  <tr key={r.pnr}>
                    <td className="mono"><strong>{r.pnr}</strong></td>
                    <td>{r.passenger || '—'}</td>
                    <td className="small">
                      <div className="mono">{r.phone}</div>
                      {r.email && <div className="muted">{r.email}</div>}
                    </td>
                    <td className="small">{r.operator}<div className="muted">{dateTimeOf(r.depart_at)}</div></td>
                    <td className="mono small">{r.seats}</td>
                    <td className="small muted">{channelLabel(r.channel)}</td>
                    <td className="num"><Money poisha={r.total_poisha} /></td>
                    <td><StatusPill status={r.status} /></td>
                    <td>
                      <Link className="btn btn-sm btn-brand" href={`/helpdesk/booking/${r.pnr}`}>
                        Open
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )
      )}
    </div>
  );
}
