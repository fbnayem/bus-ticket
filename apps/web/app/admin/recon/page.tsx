'use client';

import { useCallback, useEffect, useState } from 'react';
import { ApiError } from '@/lib/api';
import { sget, spost } from '@/lib/staff';
import { ErrorNotice, Loading } from '@/components/ui';
import { PageHead, TableWrap, Tile } from '@/components/staff-ui';
import { taka } from '@/lib/format';

// Three-way reconciliation.
//
// The platform's own records are one leg. The gateway's settlement file is the
// second. The bank statement is the third. Reconciling against only the first is
// proving the platform agrees with itself, which it always will.

interface Exception {
  exception_id: string;
  business_date: string;
  provider: string;
  kind: string;
  reference: string;
  expected_poisha: number;
  actual_poisha: number;
  detail: string;
  status: string;
  age_hours: number;
}

interface Run {
  run_id: string;
  business_date: string;
  platform_poisha: number;
  gateway_poisha: number;
  bank_poisha: number;
  exceptions_found: number;
  ran_at: string;
}

const KIND_LABEL: Record<string, string> = {
  MISSING_IN_GATEWAY: 'We recorded it, the gateway did not',
  MISSING_IN_PLATFORM: 'The gateway settled it, we have no payment',
  DUPLICATE_IN_GATEWAY: 'Settled more than once',
  AMOUNT_MISMATCH: 'Amounts disagree',
  REVERSED_TRANSACTION: 'Reversed but still held as paid',
  CALLBACK_FAILURE: 'A callback never landed',
  FAILED_REFUND: 'Refunded here, never settled there',
  MISSING_BANK_SETTLEMENT: 'Never arrived in the bank',
};

export default function ReconPage() {
  const today = new Date().toISOString().slice(0, 10);
  const [date, setDate] = useState(today);
  const [exceptions, setExceptions] = useState<Exception[]>([]);
  const [runs, setRuns] = useState<Run[]>([]);
  const [status, setStatus] = useState('OPEN');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const [flash, setFlash] = useState('');

  const load = useCallback(() => {
    Promise.all([
      sget<{ exceptions: Exception[] }>(`/finance/recon/exceptions${status ? '?status=' + status : ''}`),
      sget<{ runs: Run[] }>('/finance/recon/runs'),
    ])
      .then(([e, r]) => { setExceptions(e.exceptions); setRuns(r.runs); })
      .catch((err: ApiError) => setError(err.message));
  }, [status]);

  useEffect(load, [load]);

  if (error) return <ErrorNotice message={error} onRetry={load} />;
  if (runs.length === 0 && exceptions.length === 0 && !busy) {
    // An empty state here is legitimate: nothing has been reconciled yet.
  }

  const latest = runs[0];
  const open = exceptions.filter((e) => e.status === 'OPEN' || e.status === 'INVESTIGATING');
  const aged = open.filter((e) => e.age_hours > 24);

  return (
    <div className="stack">
      <PageHead
        title="Reconciliation"
        sub="Platform ledger against the gateway settlement file against the bank statement."
        actions={
          <div className="row" style={{ gap: '.4rem' }}>
            <input type="date" value={date} onChange={(e) => setDate(e.target.value)}
              style={{ padding: '.35rem .5rem' }} />
            <button className="btn btn-ghost btn-sm" disabled={!!busy}
              onClick={async () => {
                setBusy('import'); setFlash('');
                try {
                  const r = await spost<{ gateway?: { lines: number }; bank_lines?: number }>(
                    '/finance/recon/import',
                    { provider: 'BKASH', business_date: date, generate: true, seed_exceptions: true });
                  setFlash(`Imported ${r.gateway?.lines ?? 0} gateway lines and ${r.bank_lines ?? 0} bank lines.`);
                } catch (e) { setFlash((e as ApiError).message); }
                finally { setBusy(''); load(); }
              }}>
              {busy === 'import' ? 'Importing…' : 'Import files'}
            </button>
            <button className="btn btn-primary btn-sm" disabled={!!busy}
              onClick={async () => {
                setBusy('run'); setFlash('');
                try {
                  const r = await spost<{ exceptions_found: number; matched: number }>(
                    '/finance/recon/run', { business_date: date });
                  setFlash(`Matched ${r.matched}; ${r.exceptions_found} exception(s) open.`);
                } catch (e) { setFlash((e as ApiError).message); }
                finally { setBusy(''); load(); }
              }}>
              {busy === 'run' ? 'Matching…' : 'Run the match'}
            </button>
          </div>
        }
      />

      {flash && <div className="notice notice-info small">{flash}</div>}

      {latest && (
        <div className="tiles">
          <Tile k="Platform" n={taka(latest.platform_poisha)} hint={`for ${latest.business_date}`} />
          <Tile k="Gateway file" n={taka(latest.gateway_poisha)} />
          <Tile k="Bank statement" n={taka(latest.bank_poisha)} />
          <Tile k="Open exceptions" n={open.length} />
          <Tile k="Older than a day" n={aged.length} hint="past the triage SLA" />
        </div>
      )}

      {open.length > 0 && (
        <div className="notice notice-danger">
          <strong>{open.length} unresolved exception{open.length === 1 ? '' : 's'}.</strong>{' '}
          Any one of them inside a settlement window blocks that settlement from
          being approved. There is no override — a discrepancy that can be approved
          away is a discrepancy that will be.
        </div>
      )}

      <section className="stack">
        <div className="row-between">
          <h2 style={{ marginBottom: 0 }}>Exceptions</h2>
          <div className="row" style={{ gap: '.3rem' }}>
            {['OPEN', 'INVESTIGATING', 'RESOLVED', 'WRITTEN_OFF', ''].map((s) => (
              <button key={s || 'all'}
                className={`btn btn-sm ${status === s ? 'btn-primary' : 'btn-ghost'}`}
                onClick={() => setStatus(s)}>{s ? s.replace('_', ' ').toLowerCase() : 'all'}</button>
            ))}
          </div>
        </div>
        {exceptions.length === 0 ? (
          <div className="notice notice-info">
            Nothing here. Either the books line up, or nothing has been reconciled
            for this filter yet.
          </div>
        ) : (
          <TableWrap>
            <table className="data">
              <thead>
                <tr><th>Date</th><th>Class</th><th>Reference</th><th>Expected</th>
                  <th>Actual</th><th>Age</th><th>Status</th><th /></tr>
              </thead>
              <tbody>
                {exceptions.map((e) => (
                  <tr key={e.exception_id}>
                    <td className="small">{e.business_date}</td>
                    <td>
                      <div><strong>{KIND_LABEL[e.kind] ?? e.kind}</strong></div>
                      <div className="small muted">{e.detail}</div>
                    </td>
                    <td className="mono small">{e.reference}</td>
                    <td className="tnum">{taka(e.expected_poisha)}</td>
                    <td className="tnum">{taka(e.actual_poisha)}</td>
                    <td className={e.age_hours > 24 ? 'tnum' : 'tnum muted'}>
                      {e.age_hours}h
                    </td>
                    <td>
                      <span className={`pill ${e.status === 'RESOLVED' ? 'pill-ok'
                        : e.status === 'WRITTEN_OFF' ? 'pill-warn' : 'pill-danger'}`}>
                        {e.status.replace('_', ' ').toLowerCase()}
                      </span>
                    </td>
                    <td>
                      {(e.status === 'OPEN' || e.status === 'INVESTIGATING') && (
                        <button className="btn btn-ghost btn-sm"
                          onClick={async () => {
                            await spost(`/finance/recon/exceptions/${e.exception_id}`,
                              { status: 'RESOLVED', resolution: 'checked against the provider portal' });
                            load();
                          }}>
                          Resolve
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableWrap>
        )}
      </section>

      <section className="stack">
        <h2>Runs</h2>
        {runs.length === 0 ? <Loading rows={1} /> : (
          <TableWrap>
            <table className="data">
              <thead><tr><th>Date</th><th>Platform</th><th>Gateway</th><th>Bank</th>
                <th>Exceptions</th><th>Ran</th></tr></thead>
              <tbody>
                {runs.map((r) => (
                  <tr key={r.run_id}>
                    <td>{r.business_date}</td>
                    <td className="tnum">{taka(r.platform_poisha)}</td>
                    <td className="tnum">{taka(r.gateway_poisha)}</td>
                    <td className="tnum">{taka(r.bank_poisha)}</td>
                    <td className="tnum">{r.exceptions_found}</td>
                    <td className="small muted">{new Date(r.ran_at).toLocaleString('en-GB')}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableWrap>
        )}
      </section>

      <div className="notice notice-warn">
        <strong>Where the files come from.</strong> There is no aggregator contract
        behind this build, so &ldquo;Import files&rdquo; generates a gateway file and a
        bank statement from the platform&apos;s own payments — deliberately with a
        missing line, a duplicate, a wrong amount, a transaction we never saw and a
        short bank credit, so the matcher has something real to find.
      </div>
    </div>
  );
}
