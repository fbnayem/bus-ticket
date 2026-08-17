'use client';

import { taka } from '@/lib/format';
import { useLang } from '@/components/LangProvider';

// Small, shared pieces for the staff workplaces. Everything here is a
// presentation detail; nothing decides what a person may do.

export function PageHead({
  title, sub, actions,
}: { title: string; sub?: string; actions?: React.ReactNode }) {
  return (
    <div className="staff-head">
      <div>
        <h1 style={{ fontSize: '1.5rem', marginBottom: sub ? '.15rem' : 0 }}>{title}</h1>
        {sub && <p className="muted small" style={{ marginBottom: 0 }}>{sub}</p>}
      </div>
      {actions && <div className="row">{actions}</div>}
    </div>
  );
}

export function Tile({ k, n, hint }: { k: string; n: React.ReactNode; hint?: string }) {
  return (
    <div className="tile">
      <span className="k">{k}</span>
      <span className="n">{n}</span>
      {hint && <span className="small muted">{hint}</span>}
    </div>
  );
}

export function Money({ poisha, decimals = false }: { poisha: number; decimals?: boolean }) {
  return <span className="tnum">{taka(poisha ?? 0, { decimals })}</span>;
}

// A variance is the one number on a money screen that must never look neutral.
export function Variance({ poisha }: { poisha: number }) {
  // Translated like StatusPill: this pill appears on the counter's own cash
  // screen, which a clerk reads in Bangla, as well as on the English finance
  // consoles. The words follow the reader, not the screen.
  const { t, fmt } = useLang();
  if (poisha === 0) return <span className="pill pill-ok">{t('var.balanced')}</span>;
  const over = poisha > 0;
  return (
    <span className={`pill ${over ? 'pill-warn' : 'pill-danger'}`}>
      {t(over ? 'var.over' : 'var.short', { amount: fmt.taka(Math.abs(poisha), { decimals: true }) })}
    </span>
  );
}

export function TableWrap({ children }: { children: React.ReactNode }) {
  return <div className="table-wrap">{children}</div>;
}

export function Bar({ value, max }: { value: number; max: number }) {
  const pct = max > 0 ? Math.round((value / max) * 100) : 0;
  return (
    <div className="bar" title={`${pct}%`}>
      <span style={{ width: pct + '%' }} />
    </div>
  );
}
