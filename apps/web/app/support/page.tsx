import Link from 'next/link';
import type { Metadata } from 'next';

export const metadata: Metadata = { title: 'Support' };

const FAQ = [
  {
    q: 'Someone took my seat while I was paying. What happened?',
    a: 'Seats are held for 10 minutes from the moment you press Continue. If the hold runs out before payment clears, the seat goes back on sale automatically. Nothing is charged for an expired hold — pick your seats again and the money never left your account.',
  },
  {
    q: 'I paid but the page did not load. Am I booked?',
    a: 'Almost certainly yes. Your booking is confirmed by your payment provider notifying us directly, not by the page loading. Look up your PNR under Manage booking, or wait for the confirmation SMS. If you were charged and have no ticket after 15 minutes, contact us and we will trace it.',
  },
  {
    q: 'Can I buy a seat for part of the route?',
    a: 'Yes. On a route like Dhaka → Cumilla → Feni → Chattogram you can board and drop at any pair of stops, and you pay the fare for that leg only. The seat is sold separately for the parts of the journey you are not using.',
  },
  {
    q: 'How much do I get back if I cancel?',
    a: '90% if you cancel 24 hours or more before departure, 70% between 12 and 24 hours, 50% between 6 and 12 hours, and nothing under 6 hours. The exact amount is shown before you confirm.',
  },
  {
    q: 'When does my refund arrive?',
    a: 'Refunds are approved immediately and sent back to the method you paid with. Mobile wallets usually settle within 3 working days; cards can take up to 7.',
  },
  {
    q: 'Do I need to print my ticket?',
    a: 'No. The QR on your ticket page scans from your phone screen, and it works without a signal once the page has loaded. Printing is there if you prefer it.',
  },
  {
    q: 'Can I change my departure instead of cancelling?',
    a: 'Yes, if the booking is confirmed and the bus has not left. Open Manage booking and choose Change departure — you keep your current seats until the new ones are confirmed, and you only pay any fare difference.',
  },
];

export default function SupportPage() {
  return (
    <div className="page container">
      <div style={{ maxWidth: 720 }}>
        <h1 style={{ marginBottom: '.3rem' }}>Support</h1>
        <p className="muted">Answers to the things people ask most, and how to reach a person.</p>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr) 300px', gap: '1.5rem', alignItems: 'start', marginTop: '1.25rem' }}
           className="support-layout">
        <div className="stack">
          {FAQ.map((f) => (
            <details className="card card-pad" key={f.q}>
              <summary style={{ cursor: 'pointer', fontWeight: 620 }}>{f.q}</summary>
              <p className="muted" style={{ marginTop: '.6rem', marginBottom: 0 }}>{f.a}</p>
            </details>
          ))}
        </div>

        <aside className="stack">
          <div className="card card-pad stack-sm">
            <h3>Find your booking</h3>
            <p className="muted small" style={{ marginBottom: '.4rem' }}>
              Most things — cancelling, changing, re-sending a ticket — you can do yourself.
            </p>
            <Link className="btn btn-primary btn-block" href="/manage">Manage a booking</Link>
          </div>

          <div className="card card-pad stack-sm">
            <h3>Talk to us</h3>
            <dl className="kv">
              <dt>Hotline</dt><dd className="mono">16247</dd>
              <dt>WhatsApp</dt><dd className="mono">+8801700000000</dd>
              <dt>Email</dt><dd>help@jatra.test</dd>
              <dt>Hours</dt><dd>24 hours, every day</dd>
            </dl>
            <p className="small muted" style={{ marginBottom: 0 }}>
              Have your PNR ready — it is the fastest way for us to find your trip.
            </p>
          </div>

          <div className="card card-pad">
            <h3 style={{ marginBottom: '.3rem' }}>Bus already left?</h3>
            <p className="muted small" style={{ marginBottom: 0 }}>
              Call the hotline rather than emailing. We can reach the operator&apos;s
              dispatcher directly while the trip is running.
            </p>
          </div>
        </aside>
      </div>

      <style>{`
        @media (max-width: 860px) {
          .support-layout { grid-template-columns: 1fr !important; }
        }
      `}</style>
    </div>
  );
}
