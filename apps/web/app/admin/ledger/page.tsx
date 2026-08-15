'use client';

import { useEffect, useState } from 'react';
import { ApiError } from '@/lib/api';
import { sget } from '@/lib/staff';
import { ErrorNotice, Loading } from '@/components/ui';
import { PageHead, Money, Tile } from '@/components/staff-ui';
import { taka, dateTimeOf } from '@/lib/format';

// The books.
//
// Every balance on this page is computed from finance.ledger_entries, which is
// append-only — corrections are reversing entries, never edits. Nothing here is
// a cached figure that could quietly drift from what actually happened.

interface Account {
  account_code: string; name: string; normal_side: string;
  debit_poisha: number; credit_poisha: number; balance_poisha: number;
}
interface Journal {
  journal_id: string; description: string; occurred_at: string;
  total_poisha: number; lines: string;
}

export default function LedgerPage() {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [journals, setJournals] = useState<Journal[]>([]);
  const [variance, setVariance] = useState(0);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    sget<{ accounts: Account[]; journals: Journal[]; variance_poisha: number }>('/admin/ledger')
      .then((r) => { setAccounts(r.accounts); setJournals(r.journals); setVariance(Number(r.variance_poisha)); })
      .catch((e: ApiError) => setError(e.message))
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <Loading rows={3} />;
  if (error) return <ErrorNotice message={error} />;

  const totalDr = accounts.reduce((a, x) => a + x.debit_poisha, 0);
  const totalCr = accounts.reduce((a, x) => a + x.credit_poisha, 0);

  return (
    <div className="stack">
      <PageHead title="Ledger" sub="Double entry. Append-only. Corrections are reversing entries, never edits." />

      <div className="tiles">
        <Tile k="Total debits" n={taka(totalDr)} />
        <Tile k="Total credits" n={taka(totalCr)} />
        <Tile k="Variance" n={variance === 0 ? '0' : taka(variance, { decimals: true })}
              hint={variance === 0 ? 'the books balance' : 'investigate before anything else'} />
      </div>

      <div className="table-wrap">
        <table className="data">
          <thead>
            <tr>
              <th>Code</th><th>Account</th><th>Normal</th>
              <th className="num">Debits</th><th className="num">Credits</th><th className="num">Balance</th>
            </tr>
          </thead>
          <tbody>
            {accounts.map((a) => (
              <tr key={a.account_code}>
                <td className="mono">{a.account_code}</td>
                <td>{a.name}</td>
                <td className="muted small">{a.normal_side}</td>
                <td className="num muted"><Money poisha={a.debit_poisha} decimals /></td>
                <td className="num muted"><Money poisha={a.credit_poisha} decimals /></td>
                <td className="num"><strong><Money poisha={a.balance_poisha} decimals /></strong></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div>
        <h3 style={{ marginBottom: '.5rem' }}>Recent journals</h3>
        <div className="table-wrap">
          <table className="data">
            <thead><tr><th>When</th><th>Description</th><th>Lines</th><th className="num">Amount</th></tr></thead>
            <tbody>
              {journals.map((j) => (
                <tr key={j.journal_id}>
                  <td className="muted small">{dateTimeOf(j.occurred_at)}</td>
                  <td>{j.description}</td>
                  <td className="mono" style={{ fontSize: '.74rem' }}>{j.lines}</td>
                  <td className="num"><Money poisha={j.total_poisha} decimals /></td>
                </tr>
              ))}
              {journals.length === 0 && (
                <tr><td colSpan={4} className="muted center">No journals yet.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      <p className="small muted">
        A journal that does not balance cannot be committed — the database refuses
        it inside the same transaction that writes the booking. That is why the
        variance above is a fact rather than a hope.
      </p>
    </div>
  );
}
