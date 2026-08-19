'use client';

import { use, useEffect, useState } from 'react';
import Link from 'next/link';
import { api, ApiError, type Invoice } from '@/lib/api';
import { ErrorNotice, Loading } from '@/components/ui';
import { useLang, useT } from '@/components/LangProvider';
import { errorText } from '@/lib/i18n';

export default function InvoicePage({ params }: { params: Promise<{ pnr: string }> }) {
  const { pnr } = use(params);
  const t = useT();
  const { fmt } = useLang();
  const [inv, setInv] = useState<Invoice | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    api.invoice(pnr)
      .then(setInv)
      .catch((e: ApiError) => setError(errorText(t, e)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pnr]);

  if (error) return <div className="page container-narrow"><ErrorNotice message={error} /></div>;
  if (!inv) return <div className="page container-narrow"><Loading rows={2} /></div>;

  const ratePct = (inv.transport.rate_bp / 100).toString();

  return (
    <div className="page container-narrow">
      <div className="row-between no-print" style={{ marginBottom: '1rem' }}>
        <h1 style={{ fontSize: '1.3rem' }}>{t('inv.title')}</h1>
        <div className="row" style={{ gap: '.4rem' }}>
          <button className="btn btn-ghost btn-sm" onClick={() => window.print()}>{t('inv.print')}</button>
          <Link className="btn btn-ghost btn-sm" href={`/tickets/${inv.pnr}`}>{t('ticket.title')}</Link>
        </div>
      </div>

      <div className="card card-pad stack">
        <div className="row-between" style={{ alignItems: 'flex-start' }}>
          <div>
            <div className="ticket-eyebrow">{t('inv.mushak')}</div>
            <div style={{ fontWeight: 800, fontSize: '1.15rem' }}>{inv.seller_brand}</div>
            <div className="small muted">{inv.seller.name}</div>
          </div>
          <div style={{ textAlign: 'right' }}>
            <div className="small muted">{t('inv.no')}</div>
            <div className="mono" style={{ fontWeight: 700 }}>{inv.invoice_no}</div>
            <div className="small muted" style={{ marginTop: '.25rem' }}>{t('inv.issued')}</div>
            <div className="small">{fmt.dateTime(inv.issued_at)}</div>
          </div>
        </div>

        <dl className="kv">
          <dt>{t('inv.seller')} · {t('inv.bin')}</dt><dd className="mono">{inv.seller.bin}</dd>
          <dt>{t('inv.buyer')}</dt>
          <dd>{inv.buyer.name || '—'}{inv.buyer.phone ? ` · ${inv.buyer.phone}` : ''}</dd>
          <dt>{t('inv.journey')}</dt>
          <dd>{inv.origin} → {inv.destination} · {fmt.date(inv.depart_at)}</dd>
        </dl>

        <table className="data">
          <thead>
            <tr>
              <th>{t('inv.desc')}</th>
              <th style={{ textAlign: 'right' }}>{t('inv.base')}</th>
              <th style={{ textAlign: 'right' }}>{t('inv.vat')}</th>
              <th style={{ textAlign: 'right' }}>{t('inv.fareTotal')}</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>
                {t('inv.transport')}
                {inv.vat_exempt
                  ? <div className="small muted">{t('inv.exempt')}</div>
                  : <div className="small muted">{t('inv.vat')} @ {ratePct}%</div>}
              </td>
              <td className="tnum" style={{ textAlign: 'right' }}>{fmt.taka(inv.transport.base_poisha)}</td>
              <td className="tnum" style={{ textAlign: 'right' }}>{fmt.taka(inv.transport.vat_poisha)}</td>
              <td className="tnum" style={{ textAlign: 'right' }}>{fmt.taka(inv.transport.gross_poisha)}</td>
            </tr>
            <tr>
              <td>
                {t('inv.platformFee')}
                <div className="small muted">{t('inv.platformNote')}</div>
              </td>
              <td className="muted" style={{ textAlign: 'right' }}>—</td>
              <td className="muted" style={{ textAlign: 'right' }}>—</td>
              <td className="tnum" style={{ textAlign: 'right' }}>{fmt.taka(inv.platform_fee_poisha)}</td>
            </tr>
          </tbody>
          <tfoot>
            <tr>
              <td colSpan={3} style={{ fontWeight: 700 }}>{t('inv.grandTotal')}</td>
              <td className="tnum" style={{ textAlign: 'right', fontWeight: 700 }}>{fmt.taka(inv.total_poisha)}</td>
            </tr>
          </tfoot>
        </table>

        <p className="small muted" style={{ marginBottom: 0 }}>{t('inv.derived')}</p>
      </div>
    </div>
  );
}
