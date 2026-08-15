import Link from 'next/link';
import { SearchForm } from '@/components/SearchForm';
import { getT } from '@/lib/i18n-server';
import type { Key } from '@/lib/i18n';

/**
 * Deliberately a server component. The whole page — headline, popular routes,
 * the three promises — arrives as HTML in the first response, in the reader's
 * language, with only the search form hydrating afterwards.
 */

const POPULAR: { from: string; to: string; fromBn: string; toBn: string; note: Key }[] = [
  { from: 'Dhaka',   to: 'Chattogram', fromBn: 'ঢাকা',   toBn: 'চট্টগ্রাম', note: 'home.note.daily' },
  { from: 'Dhaka',   to: 'Cumilla',    fromBn: 'ঢাকা',   toBn: 'কুমিল্লা',  note: 'home.note.shortHop' },
  { from: 'Cumilla', to: 'Chattogram', fromBn: 'কুমিল্লা', toBn: 'চট্টগ্রাম', note: 'home.note.segment' },
  { from: 'Dhaka',   to: 'Sylhet',     fromBn: 'ঢাকা',   toBn: 'সিলেট',    note: 'home.note.overnight' },
];

export default async function HomePage() {
  const { t, lang } = await getT();

  return (
    <div className="page">
      <section className="container" style={{ paddingTop: '1rem' }}>
        <div style={{ maxWidth: 640, marginBottom: '1.5rem' }}>
          <h1>{t('home.h1')}</h1>
          <p className="muted" style={{ fontSize: '1.02rem', marginTop: '.5rem' }}>
            {t('home.sub')}
          </p>
        </div>

        <div className="card card-pad" style={{ maxWidth: 780 }}>
          <SearchForm />
        </div>
      </section>

      <section className="container" style={{ marginTop: '2.5rem' }}>
        <h2 style={{ marginBottom: '.75rem' }}>{t('home.popular')}</h2>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(210px, 1fr))', gap: '.7rem' }}>
          {POPULAR.map((r) => (
            <Link
              key={`${r.from}-${r.to}`}
              href={`/search?from=${r.from}&to=${r.to}`}
              className="card card-pad"
              style={{ color: 'inherit', textDecoration: 'none' }}
            >
              <div className="route-line" style={{ marginBottom: '.4rem' }}>
                <span className="route-dot" />
                <span className="route-track" />
                <span className="route-dot hollow" />
              </div>
              {/* Place names are shown in the reader's script, but the link still
                  carries the canonical English name the search API resolves. */}
              <strong>
                {lang === 'bn' ? r.fromBn : r.from} → {lang === 'bn' ? r.toBn : r.to}
              </strong>
              <div className="small muted">{t(r.note)}</div>
            </Link>
          ))}
        </div>
      </section>

      <section className="container" style={{ marginTop: '2.5rem' }}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: '1rem' }}>
          <Feature title={t('home.f1.title')} body={t('home.f1.body')} />
          <Feature title={t('home.f2.title')} body={t('home.f2.body')} />
          <Feature title={t('home.f3.title')} body={t('home.f3.body')} />
        </div>
      </section>
    </div>
  );
}

function Feature({ title, body }: { title: string; body: string }) {
  return (
    <div className="card card-pad">
      <h3 style={{ marginBottom: '.35rem' }}>{title}</h3>
      <p className="muted small" style={{ marginBottom: 0 }}>{body}</p>
    </div>
  );
}
