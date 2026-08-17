'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { api, ApiError, type Offer } from '@/lib/api';
import { Empty, ErrorNotice, Loading } from '@/components/ui';
import { useLang } from '@/components/LangProvider';

/**
 * Offers, drawn as coupons.
 *
 * They were uniform cards with the discount as a small pill, which made a 20%
 * saving and a terms line the same visual weight. A coupon has a head you read
 * from across the room and a tear-off with the code on it, and that hierarchy
 * is correct here: the saving decides whether you read on, and the code is what
 * you came for.
 *
 * The instruction also changed. "Apply a code at checkout" assumes the reader
 * knows what a code is applied to and where; it now names the box.
 */
export default function OffersPage() {
  const { t, fmt, lang } = useLang();
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
      <h1 style={{ marginBottom: '.3rem' }}>{t('of.title')}</h1>
      <p className="muted" style={{ maxWidth: 620 }}>{t('of.lead')}</p>

      {loading && <Loading rows={3} />}
      {error && <ErrorNotice message={error} />}
      {!loading && !error && offers.length === 0 && <Empty title={t('of.none')} />}

      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(270px, 1fr))',
        gap: '.9rem',
      }}>
        {offers.map((o) => (
          <div className="coupon" key={o.code}>
            <div className="coupon-head">
              <span className="coupon-off">
                {o.discount_pct > 0
                  ? t('of.pctOff', { pct: o.discount_pct })
                  : t('of.amountOff', { amount: fmt.taka(o.discount_poisha) })}
              </span>
              {o.ends_at && (
                <span className="coupon-ends">{t('of.endsOn', { date: fmt.date(o.ends_at) })}</span>
              )}
            </div>

            <div className="coupon-body">
              {/* Campaign copy is content, not interface, so it lives beside
                  the campaign rather than in the string catalogue. Falling
                  back to the one title a campaign was written with beats
                  showing a Bangla reader an empty card. */}
              <strong>{(lang === 'bn' && o.title_bn) || o.title}</strong>
              <p className="muted small" style={{ margin: 0 }}>{o.description}</p>

              <ul className="coupon-terms">
                {o.min_amount_poisha > 0 && (
                  <li>{t('of.minSpend', { amount: fmt.taka(o.min_amount_poisha) })}</li>
                )}
                {o.max_discount_poisha > 0 && (
                  <li>{t('of.maxOff', { amount: fmt.taka(o.max_discount_poisha) })}</li>
                )}
                <li>{t('of.oneUse')}</li>
              </ul>

              <div className="coupon-tear">
                <code className="coupon-code">{o.code}</code>
                <button className="btn btn-ghost btn-sm" onClick={() => copy(o.code)}>
                  {copied === o.code ? t('of.copied') : t('of.copy')}
                </button>
              </div>
            </div>
          </div>
        ))}
      </div>

      <div style={{ marginTop: '1.5rem' }}>
        <Link className="btn btn-primary btn-lg" href="/search">{t('ac.findBus')}</Link>
      </div>
    </div>
  );
}
