'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { ApiError } from '@/lib/api';
import { sget } from '@/lib/staff';
import { ErrorNotice, Loading } from '@/components/ui';
import { PageHead, Money, Tile } from '@/components/staff-ui';
import { taka, dateTimeOf } from '@/lib/format';

// The wallet.
//
// Three numbers, always, because any one of them alone misleads: what is
// loaded, what is committed to sales in flight, and what can actually be spent
// right now. "Balance" on its own hides a credit line and hides a hold.

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

const KIND_LABEL: Record<string, string> = {
  RECHARGE: 'Recharge', SALE: 'Ticket sale', REFUND: 'Refund',
  COMMISSION: 'Commission', ADJUSTMENT: 'Adjustment',
};

export default function AgentWalletPage() {
  const [data, setData] = useState<WalletResponse | null>(null);
  const [txns, setTxns] = useState<Txn[]>([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    Promise.all([
      sget<WalletResponse>('/agent/wallet'),
      sget<{ transactions: Txn[] }>('/agent/transactions'),
    ])
      .then(([w, t]) => { setData(w); setTxns(t.transactions); })
      .catch((e: ApiError) => setError(e.message))
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <Loading rows={2} />;
  if (error) return <ErrorNotice message={error} />;
  if (!data) return null;

  const w = data.wallet;

  return (
    <div className="stack">
      <PageHead
        title={w.agency_name}
        sub="Your wallet is a ledger. Every figure below is derived from the transactions, never typed in."
        actions={
          <>
            <Link className="btn btn-primary" href="/agent/sell">Sell a ticket</Link>
            <Link className="btn btn-ghost" href="/agent/recharge">Recharge</Link>
          </>
        }
      />

      <div className="tiles">
        <Tile k="Spendable now" n={taka(w.spendable_poisha)} hint="balance + credit − held" />
        <Tile k="Balance" n={taka(w.available_poisha)} hint="money you have loaded" />
        <Tile k="Held" n={taka(w.held_poisha)} hint="committed to sales in flight" />
        <Tile k="Credit limit" n={taka(w.credit_limit_poisha)} hint="agreed overdraft" />
      </div>

      {data.recomputed && !data.recomputed.matches && (
        <div className="notice notice-danger">
          <strong>These figures do not match the transaction log.</strong> The log
          says {taka(data.recomputed.available_poisha)} available and{' '}
          {taka(data.recomputed.held_poisha)} held. The log is the truth — please
          report this before selling anything else.
        </div>
      )}
      {data.recomputed?.matches && (
        <p className="small muted" style={{ marginTop: '-.4rem' }}>
          Checked against the transaction log just now: they agree to the poisha.
        </p>
      )}

      <div>
        <h3 style={{ marginBottom: '.5rem' }}>Transactions</h3>
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr><th>When</th><th>Type</th><th>Booking</th><th>Note</th><th className="num">Amount</th></tr>
            </thead>
            <tbody>
              {txns.map((t) => (
                <tr key={t.txn_id}>
                  <td className="muted small">{dateTimeOf(t.created_at)}</td>
                  <td>{KIND_LABEL[t.kind] ?? t.kind}</td>
                  <td className="mono">{t.pnr || '—'}</td>
                  <td className="muted small">{t.note}</td>
                  <td className="num" style={{ color: t.delta_poisha < 0 ? 'var(--danger)' : 'var(--ok)' }}>
                    {t.delta_poisha > 0 ? '+' : '−'}<Money poisha={Math.abs(t.delta_poisha)} decimals />
                  </td>
                </tr>
              ))}
              {txns.length === 0 && (
                <tr><td colSpan={5} className="muted center">No transactions yet.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
