'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { ApiError } from '@/lib/api';
import { sget } from '@/lib/staff';
import { ErrorNotice, Loading } from '@/components/ui';
import { PageHead, Money, Tile } from '@/components/staff-ui';
import { useLang } from '@/components/LangProvider';
import { Ref } from '@/components/Ref';
import { STRINGS, errorText, type Key } from '@/lib/i18n';
// The wallet.
//
// Three numbers matter, because any one of them alone misleads: what is loaded,
// what is committed to sales in flight, and what can actually be spent right
// now. "Balance" on its own hides a credit line and hides a hold.
//
// They used to be four equal tiles, which asked a shopkeeper to work out the
// only question they ever have — can I sell this ticket? — from three of the
// four. The sum is now given at full size with its own arithmetic written
// underneath, and the parts sit below it.

interface Wallet {
  wallet_id: string; agency_id: string; agency_name: string;
  available_poisha: number; held_poisha: number;
  credit_limit_poisha: number; spendable_poisha: number;
}

interface WalletResponse {
  wallet: Wallet;
  recomputed?: { available_poisha: number; held_poisha: number; matches: boolean };
}

interface Txn {
  txn_id: number; kind: string; delta_poisha: number;
  pnr: string; note: string; created_at: string;
}

export default function AgentWalletPage() {
  const { t, fmt } = useLang();
  const [data, setData] = useState<WalletResponse | null>(null);
  const [txns, setTxns] = useState<Txn[]>([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    Promise.all([
      sget<WalletResponse>('/agent/wallet'),
      sget<{ transactions: Txn[] }>('/agent/transactions'),
    ])
      .then(([w, tx]) => { setData(w); setTxns(tx.transactions); })
      .catch((e: ApiError) => setError(errorText(t, e)))
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <Loading rows={2} />;
  if (error) return <ErrorNotice message={error} />;
  if (!data) return null;

  const w = data.wallet;
  const kind = (k: string) =>
    (`ag.kind.${k}` as Key) in STRINGS ? t(`ag.kind.${k}` as Key) : k;

  return (
    <div className="stack">
      <PageHead
        title={w.agency_name}
        sub={t('ag.ledgerNote')}
        actions={
          <>
            <Link className="btn btn-primary" href="/agent/sell">{t('ag.nav.sell')}</Link>
            <Link className="btn btn-ghost" href="/agent/recharge">{t('ag.nav.recharge')}</Link>
          </>
        }
      />

      {/* The one figure that decides whether a sale can happen, with its own
          workings written out rather than left to be reconstructed. */}
      <div className="card card-pad" data-fig="spendable">
        <div className="moneyline">
          <span className="m-what">{t('ag.spendNow')}</span>
          <span className="m-amount" style={{ fontSize: '2.4rem' }}>
            {fmt.taka(w.spendable_poisha)}
          </span>
          <span className="m-what">
            {t('ag.spendHow', {
              balance: fmt.taka(w.available_poisha),
              credit: fmt.taka(w.credit_limit_poisha),
              held: fmt.taka(w.held_poisha),
            })}
          </span>
        </div>
      </div>

      {/* data-fig, so a test can assert the wallet still reports all four
          figures separately without depending on the English words for them —
          this page is bilingual and the labels move. */}
      <div className="tiles">
        <div data-fig="balance">
          <Tile k={t('ag.balance')} n={fmt.taka(w.available_poisha)} hint={t('ag.balanceHint')} />
        </div>
        <div data-fig="held">
          <Tile k={t('ag.held')} n={fmt.taka(w.held_poisha)} hint={t('ag.heldHint')} />
        </div>
        <div data-fig="credit">
          <Tile k={t('ag.credit')} n={fmt.taka(w.credit_limit_poisha)} hint={t('ag.creditHint')} />
        </div>
      </div>

      {data.recomputed && !data.recomputed.matches && (
        <div className="notice notice-danger" role="alert">
          <strong>{t('ag.mismatchTitle')}</strong>{' '}
          {t('ag.mismatchBody', {
            available: fmt.taka(data.recomputed.available_poisha),
            held: fmt.taka(data.recomputed.held_poisha),
          })}
        </div>
      )}
      {data.recomputed?.matches && (
        <p className="small muted" style={{ marginTop: '-.4rem' }}>{t('ag.agrees')}</p>
      )}

      <div>
        <h3 style={{ marginBottom: '.5rem' }}>{t('ag.txns')}</h3>
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>{t('ag.when')}</th><th>{t('ag.type')}</th><th>{t('ag.booking')}</th>
                <th>{t('ag.note')}</th><th className="num">{t('ag.amount')}</th>
              </tr>
            </thead>
            <tbody>
              {txns.map((tx) => (
                <tr key={tx.txn_id}>
                  <td className="muted small">{fmt.dateTime(tx.created_at)}</td>
                  <td>{kind(tx.kind)}</td>
                  <td>{tx.pnr ? <Ref value={tx.pnr} /> : '—'}</td>
                  <td className="muted small">{tx.note}</td>
                  <td className="num" style={{ color: tx.delta_poisha < 0 ? 'var(--danger)' : 'var(--ok)' }}>
                    {tx.delta_poisha > 0 ? '+' : '−'}
                    <Money poisha={Math.abs(tx.delta_poisha)} decimals />
                  </td>
                </tr>
              ))}
              {txns.length === 0 && (
                <tr><td colSpan={5} className="muted center">{t('ag.noTxns')}</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
