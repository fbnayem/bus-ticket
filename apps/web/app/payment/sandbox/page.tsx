'use client';

import { Suspense, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { api, ApiError } from '@/lib/api';
import { ErrorNotice, Loading } from '@/components/ui';
import { useT } from '@/components/LangProvider';

/**
 * Stand-in for the provider's hosted checkout.
 *
 * It exists to make one architectural point visible: this page cannot confirm
 * a payment. Pressing "approve" asks the sandbox provider to deliver a signed
 * webhook, and the booking becomes a ticket only when that webhook passes
 * verification server-side. Closing this tab mid-payment is safe.
 */
function Sandbox() {
  const params = useSearchParams();
  const router = useRouter();
  const t = useT();
  const ref = params.get('ref') ?? '';
  const pnr = params.get('pnr') ?? '';

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const finish = async (outcome: 'success' | 'failure') => {
    setBusy(true);
    setError('');
    try {
      const res = await api.completeSandboxPayment(ref, outcome);
      if (outcome === 'failure' || !res.confirmed) {
        setError(t('sb.declined'));
        setBusy(false);
        return;
      }
      router.push(`/confirmation/${res.pnr || pnr}`);
    } catch (e) {
      setError((e as ApiError).message);
      setBusy(false);
    }
  };

  return (
    <div className="page container-narrow">
      <div className="card">
        <div className="card-head row-between">
          <span>{t('sb.title')}</span>
          <span className="pill pill-warn">{t('sb.testMode')}</span>
        </div>
        <div className="card-pad stack">
          <div className="notice notice-warn">{t('sb.noMoney')}</div>

          <p className="muted small" style={{ marginBottom: 0 }}>{t('sb.webhookNote')}</p>

          {error && <ErrorNotice message={error} />}

          <div className="row" style={{ gap: '.6rem' }}>
            <button className="btn btn-primary btn-lg" disabled={busy || !ref}
                    onClick={() => finish('success')}>
              {busy ? t('sb.confirming') : t('sb.approve')}
            </button>
            <button className="btn btn-ghost" disabled={busy} onClick={() => finish('failure')}>
              {t('sb.decline')}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

export default function SandboxPage() {
  return (
    <Suspense fallback={<div className="page container"><Loading rows={2} /></div>}>
      <Sandbox />
    </Suspense>
  );
}
