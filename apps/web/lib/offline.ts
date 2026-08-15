'use client';

// The counter's offline queue.
//
// The rule this file exists to keep, from the plan: a counter may sell offline
// ONLY from seats it exclusively owns. Everything here is bookkeeping around
// that rule — the rule itself is enforced by inventory-service, which refuses
// any replayed sale for a seat outside the counter's quota. If this file were
// deleted and rewritten by someone who did not know the rule, the server would
// still refuse.
//
// Each queued sale carries a client_ref minted BEFORE the sale is made and a
// monotonic per-terminal sequence. The queue is flushed on reconnect, which on
// a bad line means it will be flushed repeatedly — the client_ref is what makes
// that harmless.

const QUEUE_KEY = 'jatra.counter.queue';
const SEQ_KEY = 'jatra.counter.seq';
const QUOTA_KEY = 'jatra.counter.quota';

export interface QuotaSeat {
  trip_id: string;
  seat_no: string;
  board_seq: number;
  drop_seq: number;
  depart_at?: string;
  operator?: string;
  from?: string;
  to?: string;
  fare_poisha?: number;
}

export interface QueuedSale {
  client_ref: string;
  terminal_seq: number;
  trip_id: string;
  seats: string[];
  board_seq: number;
  drop_seq: number;
  passengers: { seat_no: string; full_name: string }[];
  phone: string;
  total_poisha: number;
  sold_at: string;
  shift_id: string;
  // Local only — never sent. Lets the clerk see what they sold while offline.
  label?: string;
}

const read = <T,>(key: string, fallback: T): T => {
  if (typeof window === 'undefined') return fallback;
  try { return JSON.parse(localStorage.getItem(key) ?? '') as T; } catch { return fallback; }
};
const write = (key: string, v: unknown) => localStorage.setItem(key, JSON.stringify(v));

export const queue = {
  all: () => read<QueuedSale[]>(QUEUE_KEY, []),
  add(sale: Omit<QueuedSale, 'terminal_seq' | 'client_ref'>) {
    const seq = Number(localStorage.getItem(SEQ_KEY) ?? '0') + 1;
    localStorage.setItem(SEQ_KEY, String(seq));
    const entry: QueuedSale = {
      ...sale,
      terminal_seq: seq,
      // Minted here, before the sale is announced to anyone. This is the
      // identity the server deduplicates on.
      client_ref: `off-${terminalId()}-${seq}-${Date.now()}`,
    };
    write(QUEUE_KEY, [...queue.all(), entry]);
    return entry;
  },
  remove(refs: string[]) {
    write(QUEUE_KEY, queue.all().filter((s) => !refs.includes(s.client_ref)));
  },
  clear: () => write(QUEUE_KEY, []),
};

// The cached quota. Written while online, read while offline — a clerk with no
// signal must still be able to see which seats are genuinely theirs to sell.
export const quotaCache = {
  get: () => read<QuotaSeat[]>(QUOTA_KEY, []),
  set: (seats: QuotaSeat[]) => write(QUOTA_KEY, seats),
  consume(tripId: string, seatNos: string[]) {
    quotaCache.set(
      quotaCache.get().filter((q) => !(q.trip_id === tripId && seatNos.includes(q.seat_no))),
    );
  },
};

export function terminalId(): string {
  const KEY = 'jatra.counter.terminal';
  let id = localStorage.getItem(KEY);
  if (!id) {
    id = Math.random().toString(36).slice(2, 8).toUpperCase();
    localStorage.setItem(KEY, id);
  }
  return id;
}
