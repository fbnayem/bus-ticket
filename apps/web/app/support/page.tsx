import Link from 'next/link';
import type { Metadata } from 'next';
import { getT } from '@/lib/i18n-server';
import { Glyph } from '@/components/Glyph';
import type { Key } from '@/lib/i18n';

export const metadata: Metadata = { title: 'Support' };

/**
 * Help.
 *
 * Deliberately still a server component. This is the page someone opens at a
 * bus counter on a bad connection with a problem already in progress, so it has
 * to be readable from the first byte rather than after a bundle lands. That is
 * also why the answers are static text and not fetched.
 *
 * One answer was wrong and is now fixed. The hold question used to promise
 * "seats are held for 10 minutes" — a number this interface does not own. The
 * server issues the hold and returns its own deadline, which the checkout
 * screen already counts down. Printing a competing figure in the help pages is
 * how a passenger ends up believing they had four minutes left when they had
 * none. The answer now points at the countdown instead of restating it.
 */

const FAQ: { q: Key; a: Key }[] = [
  { q: 'faq.q.hold',         a: 'faq.a.hold' },
  { q: 'faq.q.paidNoPage',   a: 'faq.a.paidNoPage' },
  { q: 'faq.q.refundAmount', a: 'faq.a.refundAmount' },
  { q: 'faq.q.change',       a: 'faq.a.change' },
  { q: 'faq.q.refundWhen',   a: 'faq.a.refundWhen' },
  { q: 'faq.q.partRoute',    a: 'faq.a.partRoute' },
  { q: 'faq.q.print',        a: 'faq.a.print' },
];

export default async function SupportPage() {
  const { t } = await getT();

  return (
    <div className="page container">
      <div style={{ maxWidth: 720 }}>
        <h1 style={{ marginBottom: '.3rem' }}>{t('sp.title')}</h1>
        <p className="muted">{t('sp.lead')}</p>
      </div>

      <div className="support-layout">
        <div>
          {FAQ.map((f) => (
            <details className="qa" key={f.q}>
              <summary>{t(f.q)}</summary>
              <div className="qa-body"><p>{t(f.a)}</p></div>
            </details>
          ))}
        </div>

        <aside className="stack">
          {/*
            Self-service first, because it is faster for the passenger and
            because most of what people call the hotline about is something they
            could have finished in a minute with their ticket number.
          */}
          <div className="card card-pad stack-sm">
            <div className="row" style={{ gap: '.5rem' }}>
              <Glyph name="ticket" size={18} />
              <h3 style={{ margin: 0, fontSize: '1rem' }}>{t('sp.selfServe')}</h3>
            </div>
            <p className="muted small" style={{ margin: 0 }}>{t('sp.selfServeBody')}</p>
            <Link className="btn btn-primary btn-block" href="/manage">{t('find.title')}</Link>
          </div>

          <div className="card card-pad stack-sm">
            <div className="row" style={{ gap: '.5rem' }}>
              <Glyph name="chat" size={18} />
              <h3 style={{ margin: 0, fontSize: '1rem' }}>{t('sp.talk')}</h3>
            </div>
            {/*
              Tel and WhatsApp links, not printed digits. On the phone this is
              read on, a number you cannot tap is a number you have to memorise
              and retype while your bus is leaving.
            */}
            <dl className="kv">
              <dt>{t('sp.hotline')}</dt>
              <dd><a className="ref" href="tel:16247">16247</a></dd>
              <dt>{t('sp.whatsapp')}</dt>
              <dd><a className="ref" href="https://wa.me/8801700000000">+8801700000000</a></dd>
              <dt>{t('sp.emailUs')}</dt>
              <dd><a href="mailto:help@jatra.test">help@jatra.test</a></dd>
              <dt>{t('sp.hours')}</dt>
              <dd>{t('sp.allDay')}</dd>
            </dl>
            <p className="small muted" style={{ margin: 0 }}>{t('sp.havePnr')}</p>
          </div>

          <div className="card card-pad stack-sm">
            <div className="row" style={{ gap: '.5rem' }}>
              <Glyph name="phone" size={18} />
              <h3 style={{ margin: 0, fontSize: '1rem' }}>{t('sp.busGone')}</h3>
            </div>
            <p className="muted small" style={{ margin: 0 }}>{t('sp.busGoneBody')}</p>
          </div>
        </aside>
      </div>
    </div>
  );
}
