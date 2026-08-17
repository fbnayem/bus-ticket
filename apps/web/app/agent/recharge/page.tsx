'use client';

import { useCallback, useEffect, useState } from 'react';
import { ApiError } from '@/lib/api';
import { can, sget, spost } from '@/lib/staff';
import { useSession } from '@/components/StaffShell';
import { ErrorNotice, Loading } from '@/components/ui';
import { PageHead, Money } from '@/components/staff-ui';
import { useLang } from '@/components/LangProvider';
import { STRINGS, type Key } from '@/lib/i18n';

// Money entering the platform walks maker → checker. The agent says what they
// sent; a different person in finance confirms it arrived. The database refuses
// a self-approval outright, so this is not merely a workflow convention.

interface Recharge {
  recharge_id: string; agency: string; amount_poisha: number;
  method: string; reference: string; status: string;
  created_at: string; requested_by: string; approved_by: string;
}

export default function RechargePage() {
  const { t, fmt } = useLang();
  const session = useSession();
  const [rows, setRows] = useState<Recharge[]>([]);
  const [amount, setAmount] = useState('5000');
  const [method, setMethod] = useState('BKASH');
  const [reference, setReference] = useState('');
  const [error, setError] = useState('');
  const [flash, setFlash] = useState('');
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);

  const load = useCallback(() => {
    sget<{ recharges: Recharge[] }>('/agent/recharges')
      .then((r) => setRows(r.recharges))
      .catch((e: ApiError) => setError(e.message))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { load(); }, [load]);

  const request = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true); setError('');
    try {
      await spost('/agent/recharges', {
        amount_poisha: Math.round(Number(amount) * 100),
        method,
        reference,
      });
      setFlash(t('ag.rc.saved'));
      setReference('');
      load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t('ag.rc.fail'));
    } finally { setBusy(false); }
  };

  // Approval happens in the admin console, not here. An agent's own workspace
  // is not the place to sign off money entering their own account.
  const canRequest = can(session?.identity ?? null, 'wallet.recharge');

  // Statuses come from the server in English. Where a translation exists it is
  // used; where one does not, the server's own word is shown rather than a
  // blank — a missing string must never hide the state of somebody's money.
  const say = (k: string, fallback: string) =>
    (k as Key) in STRINGS ? t(k as Key) : fallback;

  if (loading) return <Loading rows={2} />;

  return (
    <div className="stack">
      <PageHead title={t('ag.nav.recharge')} sub={t('ag.rc.sub')} />

      {error && <ErrorNotice message={error} />}
      {flash && <div className="notice notice-info">{flash}</div>}

      {canRequest && (
        <form className="card card-pad stack" style={{ maxWidth: 420 }} onSubmit={request}>
          <h3>{t('ag.rc.formTitle')}</h3>
          <div className="field">
            <label className="label" htmlFor="amt">{t('ag.rc.amount')}</label>
            <input id="amt" className="input tnum" type="number" min="1" step="1"
                   value={amount} onChange={(e) => setAmount(e.target.value)} required
                   style={{ fontSize: '1.3rem' }} />
          </div>
          <div className="field">
            <label className="label" htmlFor="mth">{t('ag.rc.sentBy')}</label>
            <select id="mth" className="select" value={method} onChange={(e) => setMethod(e.target.value)}>
              <option value="BKASH">bKash</option>
              <option value="NAGAD">Nagad</option>
              <option value="BANK">{t('ag.rc.bank')}</option>
            </select>
          </div>
          <div className="field">
            <label className="label" htmlFor="ref">{t('ag.rc.reference')}</label>
            <input id="ref" className="input mono" value={reference}
                   onChange={(e) => setReference(e.target.value)} placeholder="TRX…" required />
          </div>
          <button className="btn btn-primary btn-block btn-lg" type="submit"
                  disabled={busy} data-act="record-recharge">
            {busy ? t('ag.rc.saving') : t('ag.rc.submit')}
          </button>
          <p className="small muted" style={{ marginBottom: 0 }}>{t('ag.rc.note')}</p>
        </form>
      )}

      <div>
        <h3 style={{ marginBottom: '.5rem' }}>{t('ag.rc.history')}</h3>
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>{t('ag.rc.requested')}</th><th>{t('ag.rc.agency')}</th>
                <th>{t('ag.rc.method')}</th><th>{t('ag.rc.reference')}</th>
                <th className="num">{t('ag.amount')}</th><th>{t('co.s.status')}</th>
                <th>{t('ag.rc.by')}</th><th>{t('ag.rc.approvedBy')}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.recharge_id}>
                  <td className="muted small">{fmt.dateTime(r.created_at)}</td>
                  <td>{r.agency}</td>
                  <td>{r.method === 'BANK' ? t('ag.rc.bank') : r.method}</td>
                  <td className="mono small">{r.reference || '—'}</td>
                  <td className="num"><Money poisha={r.amount_poisha} /></td>
                  <td>
                    <span className={`pill ${r.status === 'APPROVED' ? 'pill-ok' : r.status === 'REJECTED' ? 'pill-danger' : 'pill-warn'}`}>
                      {say(`status.${r.status}`, r.status.toLowerCase())}
                    </span>
                  </td>
                  <td className="small">{r.requested_by}</td>
                  <td className="small muted">{r.approved_by || '—'}</td>
                </tr>
              ))}
              {rows.length === 0 && (
                <tr><td colSpan={8} className="muted center">{t('ag.rc.empty')}</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
