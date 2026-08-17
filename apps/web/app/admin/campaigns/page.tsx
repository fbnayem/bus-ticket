'use client';

import { useCallback, useEffect, useState } from 'react';
import { ApiError } from '@/lib/api';
import { sget, spost } from '@/lib/staff';
import { ErrorNotice, Loading } from '@/components/ui';
import { PageHead, TableWrap, Tile } from '@/components/staff-ui';
import { taka } from '@/lib/format';

// Campaigns and referrals.
//
// The "left" column is the one to watch on a limited campaign. It cannot go
// negative and it cannot overshoot, because a redemption is a conditional
// UPDATE whose rowcount is the verdict — the same shape as acquiring a seat.

interface Campaign {
  code: string;
  title: string;
  title_bn?: string;
  kind: string;
  discount_pct: number;
  discount_poisha: number;
  max_discount_poisha: number;
  min_amount_poisha: number;
  remaining: number | null;
  redeemed: number;
  ends_at: string | null;
}

interface Referral {
  code: string;
  referrer: string;
  invitee?: string;
  status: string;
  reward_poisha: number;
  reward_code?: string;
  created_at: string;
}

export default function CampaignsPage() {
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [referrals, setReferrals] = useState<Referral[]>([]);
  const [error, setError] = useState('');
  const [flash, setFlash] = useState('');
  const [form, setForm] = useState({ code: '', title: '', title_bn: '', discount_pct: 10, max: 20000, min: 0, cap: '', days: 30 });

  const load = useCallback(() => {
    Promise.all([
      sget<{ campaigns: Campaign[] }>('/admin/campaigns'),
      sget<{ referrals: Referral[] }>('/admin/referrals').catch(() => ({ referrals: [] })),
    ])
      .then(([c, r]) => { setCampaigns(c.campaigns); setReferrals(r.referrals); })
      .catch((e: ApiError) => setError(e.message));
  }, []);

  useEffect(load, [load]);

  if (error) return <ErrorNotice message={error} onRetry={load} />;
  if (campaigns.length === 0 && !flash) return <Loading rows={2} />;

  const limited = campaigns.filter((c) => c.remaining !== null);
  const rewarded = referrals.filter((r) => r.status === 'REWARDED');

  return (
    <div className="stack">
      <PageHead title="Campaigns & referrals"
        sub="Discounts are an expense the platform carries, and every redemption posts to the ledger." />

      <div className="tiles">
        <Tile k="Live campaigns" n={campaigns.length} />
        <Tile k="With a hard cap" n={limited.length} />
        <Tile k="Redemptions" n={campaigns.reduce((s, c) => s + c.redeemed, 0)} />
        <Tile k="Referrals" n={referrals.length} />
        <Tile k="Rewards issued" n={rewarded.length} />
      </div>

      {flash && <div className="notice notice-info small">{flash}</div>}

      <section className="stack">
        <h2>Campaigns</h2>
        <TableWrap>
          <table className="data">
            <thead>
              <tr><th>Code</th><th>Offer</th><th>Minimum fare</th><th>Redeemed</th>
                <th>Left</th><th>Ends</th></tr>
            </thead>
            <tbody>
              {campaigns.map((c) => (
                <tr key={c.code}>
                  <td className="mono"><strong>{c.code}</strong></td>
                  <td>
                    <div>{c.title}</div>
                    {c.title_bn
                      ? <div lang="bn">{c.title_bn}</div>
                      : <div className="small pill pill-warn">no Bangla copy</div>}
                    <div className="small muted">
                      {c.discount_pct > 0 ? `${c.discount_pct}% off` : taka(c.discount_poisha) + ' off'}
                      {c.max_discount_poisha > 0 && `, up to ${taka(c.max_discount_poisha)}`}
                      {' · '}{c.kind.toLowerCase()}
                    </div>
                  </td>
                  <td className="tnum">{c.min_amount_poisha > 0 ? taka(c.min_amount_poisha) : '—'}</td>
                  <td className="tnum">{c.redeemed}</td>
                  <td>
                    {c.remaining === null
                      ? <span className="small muted">unlimited</span>
                      : <span className={`pill ${c.remaining === 0 ? 'pill-danger'
                          : c.remaining < 10 ? 'pill-warn' : 'pill-ok'}`}>{c.remaining}</span>}
                  </td>
                  <td className="small muted">
                    {c.ends_at ? new Date(c.ends_at).toLocaleDateString('en-GB') : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableWrap>
      </section>

      <section className="stack">
        <h2>New campaign</h2>
        <form
          className="card card-pad stack"
          style={{ maxWidth: 560 }}
          onSubmit={async (e) => {
            e.preventDefault();
            setFlash('');
            try {
              await spost('/admin/campaigns', {
                code: form.code, title: form.title, title_bn: form.title_bn,
                kind: form.cap ? 'LIMITED' : 'COUPON',
                discount_pct: Number(form.discount_pct),
                max_discount_poisha: Number(form.max),
                min_amount_poisha: Number(form.min),
                max_redemptions: form.cap ? Number(form.cap) : null,
                per_user_limit: 1, days: Number(form.days),
              });
              setFlash(`${form.code.toUpperCase()} created.`);
              setForm({ ...form, code: '', title: '', title_bn: '' });
              load();
            } catch (err) { setFlash((err as ApiError).message); }
          }}
        >
          <div className="row" style={{ gap: '.6rem', flexWrap: 'wrap' }}>
            <div style={{ flex: '1 1 140px' }}>
              <label htmlFor="code">Code</label>
              <input id="code" required value={form.code}
                onChange={(e) => setForm({ ...form, code: e.target.value.toUpperCase() })} />
            </div>
            <div style={{ flex: '2 1 240px' }}>
              <label htmlFor="title">Title (English)</label>
              <input id="title" required value={form.title}
                onChange={(e) => setForm({ ...form, title: e.target.value })} />
            </div>
          </div>
          {/* Most passengers read this in Bangla. Leaving it empty is allowed
              and shows the English line to everyone, which is worse than
              writing one sentence twice. */}
          <div>
            <label htmlFor="title_bn">Title (Bangla)</label>
            <input id="title_bn" lang="bn" value={form.title_bn}
              placeholder="ঈদ সফর — 15% ছাড়"
              onChange={(e) => setForm({ ...form, title_bn: e.target.value })} />
          </div>
          <div className="row" style={{ gap: '.6rem', flexWrap: 'wrap' }}>
            <div style={{ flex: '1 1 120px' }}>
              <label htmlFor="pct">Discount %</label>
              <input id="pct" type="number" min={0} max={100} value={form.discount_pct}
                onChange={(e) => setForm({ ...form, discount_pct: Number(e.target.value) })} />
            </div>
            <div style={{ flex: '1 1 120px' }}>
              <label htmlFor="max">Max discount (poisha)</label>
              <input id="max" type="number" min={0} value={form.max}
                onChange={(e) => setForm({ ...form, max: Number(e.target.value) })} />
            </div>
            <div style={{ flex: '1 1 120px' }}>
              <label htmlFor="cap">Total redemptions</label>
              <input id="cap" type="number" min={1} placeholder="unlimited" value={form.cap}
                onChange={(e) => setForm({ ...form, cap: e.target.value })} />
            </div>
            <div style={{ flex: '1 1 100px' }}>
              <label htmlFor="days">Runs for (days)</label>
              <input id="days" type="number" min={1} value={form.days}
                onChange={(e) => setForm({ ...form, days: Number(e.target.value) })} />
            </div>
          </div>
          <button className="btn btn-primary" type="submit">Create campaign</button>
        </form>
      </section>

      {referrals.length > 0 && (
        <section className="stack">
          <h2>Referrals</h2>
          <TableWrap>
            <table className="data">
              <thead><tr><th>Code</th><th>Referrer</th><th>Invitee</th><th>Status</th>
                <th>Reward</th><th>Coupon issued</th></tr></thead>
              <tbody>
                {referrals.slice(0, 40).map((r) => (
                  <tr key={r.code}>
                    <td className="mono">{r.code}</td>
                    <td className="mono small">{r.referrer}</td>
                    <td className="mono small">{r.invitee || '—'}</td>
                    <td>
                      <span className={`pill ${r.status === 'REWARDED' ? 'pill-ok'
                        : r.status === 'VOID' ? 'pill-danger' : 'pill-warn'}`}>
                        {r.status.toLowerCase()}
                      </span>
                    </td>
                    <td className="tnum">{taka(r.reward_poisha)}</td>
                    <td className="mono small">{r.reward_code || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableWrap>
        </section>
      )}
    </div>
  );
}
