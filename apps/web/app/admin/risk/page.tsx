'use client';

import { useCallback, useEffect, useState } from 'react';
import { ApiError } from '@/lib/api';
import { sget, spost, staffCall } from '@/lib/staff';
import { ErrorNotice, Loading } from '@/components/ui';
import { PageHead, TableWrap, Tile } from '@/components/staff-ui';

// Risk and fraud.
//
// The mode column is the most important thing here. A rule in SHADOW is
// evaluated and recorded but enforces nothing, so its false-positive rate can be
// measured on real traffic before anybody is turned away by it. Promotion to
// ENFORCING is a deliberate act, and the server refuses it for a rule that has
// never fired.

interface Rule {
  code: string;
  description: string;
  signal: string;
  window_minutes: number;
  threshold: number;
  outcome: string;
  mode: string;
  hits: number;
  false_positives: number;
}

interface Case {
  case_id: string;
  subject_kind: string;
  subject: string;
  reason: string;
  status: string;
  opened_at: string;
  events: number;
}

interface Block {
  subject_kind: string;
  subject: string;
  reason: string;
  blocked_at: string;
  lifted_at: string | null;
}

interface Stat { outcome: string; count: number; enforced: number; p95_latency_us: number }

export default function RiskPage() {
  const [rules, setRules] = useState<Rule[]>([]);
  const [cases, setCases] = useState<Case[]>([]);
  const [blocks, setBlocks] = useState<Block[]>([]);
  const [stats, setStats] = useState<Stat[]>([]);
  const [error, setError] = useState('');
  const [flash, setFlash] = useState('');

  const load = useCallback(() => {
    Promise.all([
      sget<{ rules: Rule[] }>('/admin/risk/rules'),
      sget<{ cases: Case[] }>('/admin/risk/cases'),
      sget<{ blocks: Block[] }>('/admin/risk/blocks'),
      sget<{ stats: Stat[] }>('/admin/risk/stats?hours=24'),
    ])
      .then(([r, c, b, s]) => { setRules(r.rules); setCases(c.cases); setBlocks(b.blocks); setStats(s.stats); })
      .catch((e: ApiError) => setError(e.message));
  }, []);

  useEffect(load, [load]);

  if (error) return <ErrorNotice message={error} onRetry={load} />;
  if (rules.length === 0) return <Loading rows={3} />;

  const worstLatency = stats.reduce((m, s) => Math.max(m, s.p95_latency_us), 0);
  const openCases = cases.filter((c) => c.status === 'OPEN');

  return (
    <div className="stack">
      <PageHead title="Risk & fraud"
        sub="Rules are rows. Every one of them starts in shadow, and the engine fails open." />

      <div className="tiles">
        <Tile k="Enforcing" n={rules.filter((r) => r.mode === 'ENFORCING').length} />
        <Tile k="In shadow" n={rules.filter((r) => r.mode === 'SHADOW').length} hint="observed, never enforced" />
        <Tile k="Open cases" n={openCases.length} />
        <Tile k="Active blocks" n={blocks.filter((b) => !b.lifted_at).length} />
        <Tile k="p95 evaluation" n={`${(worstLatency / 1000).toFixed(1)} ms`} hint="budget is 30 ms" />
      </div>

      {flash && <div className="notice notice-info small">{flash}</div>}

      <section className="stack">
        <h2>Rules</h2>
        <TableWrap>
          <table className="data">
            <thead>
              <tr><th>Rule</th><th>Signal</th><th>Threshold</th><th>Outcome</th>
                <th>Hits</th><th>False positives</th><th>Mode</th><th /></tr>
            </thead>
            <tbody>
              {rules.map((r) => {
                const fpRate = r.hits > 0 ? (r.false_positives / r.hits) * 100 : 0;
                return (
                  <tr key={r.code}>
                    <td>
                      <div className="mono small">{r.code}</div>
                      <div className="small muted">{r.description}</div>
                    </td>
                    <td className="small">{r.signal.replace(/_/g, ' ').toLowerCase()}</td>
                    <td className="tnum">{r.threshold} / {r.window_minutes}m</td>
                    <td><span className="pill">{r.outcome.replace('_', ' ')}</span></td>
                    <td className="tnum">{r.hits}</td>
                    <td className="tnum">
                      {r.false_positives}
                      {r.hits > 0 && <span className="small muted"> ({fpRate.toFixed(1)}%)</span>}
                    </td>
                    <td>
                      <span className={`pill ${r.mode === 'ENFORCING' ? 'pill-danger'
                        : r.mode === 'SHADOW' ? 'pill-warn' : ''}`}>
                        {r.mode.toLowerCase()}
                      </span>
                    </td>
                    <td>
                      <button className="btn btn-ghost btn-sm"
                        onClick={async () => {
                          setFlash('');
                          const next = r.mode === 'ENFORCING' ? 'SHADOW' : 'ENFORCING';
                          try {
                            await staffCall(`/admin/risk/rules/${r.code}`,
                              { method: 'PATCH', body: { mode: next } });
                            setFlash(`${r.code} is now ${next.toLowerCase()}.`);
                          } catch (e) { setFlash((e as ApiError).message); }
                          load();
                        }}>
                        {r.mode === 'ENFORCING' ? 'Back to shadow' : 'Enforce'}
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </TableWrap>
        <p className="muted small">
          A rule cannot be promoted to enforcement until it has fired at least once
          in shadow. Nobody should be turned away by a rule whose false-positive
          rate is still unknown.
        </p>
      </section>

      <section className="stack">
        <h2>Decisions in the last 24 hours</h2>
        <TableWrap>
          <table className="data">
            <thead><tr><th>Outcome</th><th>Times</th><th>Of those, enforced</th><th>p95 latency</th></tr></thead>
            <tbody>
              {stats.map((s) => (
                <tr key={s.outcome}>
                  <td><span className="pill">{s.outcome.replace('_', ' ')}</span></td>
                  <td className="tnum">{s.count.toLocaleString()}</td>
                  <td className="tnum">{s.enforced.toLocaleString()}</td>
                  <td className="tnum">{(s.p95_latency_us / 1000).toFixed(2)} ms</td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableWrap>
      </section>

      <section className="stack">
        <h2>Review queue</h2>
        {cases.length === 0 ? (
          <div className="notice notice-info">Nothing is waiting for a human.</div>
        ) : (
          <TableWrap>
            <table className="data">
              <thead><tr><th>Subject</th><th>Why</th><th>Recent events</th><th>Status</th><th /></tr></thead>
              <tbody>
                {cases.map((c) => (
                  <tr key={c.case_id}>
                    <td><span className="small muted">{c.subject_kind}</span> <span className="mono">{c.subject}</span></td>
                    <td className="small">{c.reason}</td>
                    <td className="tnum">{c.events}</td>
                    <td><span className={`pill ${c.status === 'OPEN' ? 'pill-warn'
                      : c.status === 'CONFIRMED' ? 'pill-danger' : 'pill-ok'}`}>{c.status.toLowerCase()}</span></td>
                    <td>
                      {c.status === 'OPEN' && (
                        <div className="row" style={{ gap: '.3rem' }}>
                          <button className="btn btn-ghost btn-sm"
                            onClick={async () => {
                              await spost(`/admin/risk/cases/${c.case_id}/close`,
                                { verdict: 'CLEARED', note: 'reviewed, legitimate' });
                              load();
                            }}>Clear</button>
                          <button className="btn btn-ghost btn-sm"
                            onClick={async () => {
                              await spost(`/admin/risk/cases/${c.case_id}/close`,
                                { verdict: 'CONFIRMED', note: 'reviewed, abusive' });
                              load();
                            }}>Confirm & block</button>
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableWrap>
        )}
        <p className="muted small">
          Clearing a case counts against the rules that raised it. That is what
          makes the false-positive column real rather than decorative.
        </p>
      </section>

      {blocks.length > 0 && (
        <section className="stack">
          <h2>Blocks</h2>
          <TableWrap>
            <table className="data">
              <thead><tr><th>Subject</th><th>Reason</th><th>Since</th><th /></tr></thead>
              <tbody>
                {blocks.map((b) => (
                  <tr key={b.subject_kind + b.subject}>
                    <td><span className="small muted">{b.subject_kind}</span> <span className="mono">{b.subject}</span></td>
                    <td className="small">{b.reason}</td>
                    <td className="small muted">{new Date(b.blocked_at).toLocaleString('en-GB')}</td>
                    <td>
                      {b.lifted_at ? <span className="pill pill-ok">Lifted</span> : (
                        <button className="btn btn-ghost btn-sm"
                          onClick={async () => {
                            await spost('/admin/risk/blocks/lift',
                              { subject_kind: b.subject_kind, subject: b.subject });
                            load();
                          }}>Lift</button>
                      )}
                    </td>
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
