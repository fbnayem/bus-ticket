'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { api, ApiError, type Offer } from '@/lib/api';
import { Empty, ErrorNotice, Loading } from '@/components/ui';
import { dateOf, taka } from '@/lib/format';

export default function OffersPage() {
  const [offers, setOffers] = useState<Offer[]>([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [copied, setCopied] = useState('');

  useEffect(() => {
    api.offers()
      .then((r) => setOffers(r.offers))
      .catch((e: ApiError) => setError(e.message))
      .finally(() => setLoading(false));
  }, []);

  const copy = async (code: string) => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(code);
      setTimeout(() => setCopied(''), 2000);
    } catch { /* clipboard unavailable; the code is on screen anyway */ }
  };

  return (
    <div className="page container">
      <h1 style={{ marginBottom: '.3rem' }}>Offers</h1>
      <p className="muted">Apply a code at checkout. One code per booking.</p>

      {loading && <Loading rows={3} />}
      {error && <ErrorNotice message={error} />}
      {!loading && !error && offers.length === 0 && <Empty title="No offers running right now" />}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px,1fr))', gap: '.9rem' }}>
        {offers.map((o) => (
          <div className="card card-pad stack-sm" key={o.code}>
            <div className="row-between">
              <span className="pill pill-brand">
                {o.discount_pct > 0 ? `${o.discount_pct}% off` : `${taka(o.discount_poisha)} off`}
              </span>
              {o.ends_at && <span className="small muted">Ends {dateOf(o.ends_at)}</span>}
            </div>

            <h3>{o.title}</h3>
            <p className="muted small" style={{ marginBottom: '.3rem' }}>{o.description}</p>

            <ul className="small muted" style={{ margin: 0, paddingLeft: '1.1rem' }}>
              {o.min_amount_poisha > 0 && <li>Bookings over {taka(o.min_amount_poisha)}</li>}
              {o.max_discount_poisha > 0 && <li>Up to {taka(o.max_discount_poisha)} off</li>}
              <li>One use per passenger</li>
            </ul>

            <div className="row-between" style={{ marginTop: '.4rem' }}>
              <code className="mono" style={{
                background: 'var(--sunken)', padding: '.35rem .6rem',
                borderRadius: 6, fontWeight: 700, letterSpacing: '.08em',
              }}>{o.code}</code>
              <button className="btn btn-ghost btn-sm" onClick={() => copy(o.code)}>
                {copied === o.code ? 'Copied' : 'Copy code'}
              </button>
            </div>
          </div>
        ))}
      </div>

      <div style={{ marginTop: '1.5rem' }}>
        <Link className="btn btn-primary" href="/search">Find a bus</Link>
      </div>
    </div>
  );
}
