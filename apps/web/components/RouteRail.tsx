'use client';

import type { Stop } from '@/lib/api';
import { useLang, useT } from './LangProvider';

/**
 * The route, drawn.
 *
 * Segment inventory is the thing this platform does that its competitors do
 * not: a multi-stop trip sells per leg, so a seat sold Dhaka→Cumilla is
 * genuinely free Cumilla→Chattogram. Until now the interface said that in a
 * grey sentence under the seat map, which is the weakest possible place to
 * make the argument.
 *
 * Here the whole route is drawn as a thin unpainted line, and the leg the
 * passenger is actually buying is REPAINTED over it — thicker, in field green,
 * with solid markers at the two stops that belong to them. The stops outside
 * their leg stay on the line but hollow. A passenger who has been told
 * elsewhere that this bus is full can see why seats are free here.
 */
export function RouteRail({
  stops, board, drop, vertical = false,
}: {
  stops: Stop[];
  board: number;
  drop: number;
  /** Bangla stop names need horizontal room, so narrow screens stack. */
  vertical?: boolean;
}) {
  const t = useT();
  const { fmt } = useLang();

  if (!stops.length) return null;

  if (vertical) {
    return (
      <ol className="rail-v">
        {stops.map((s) => {
          const inLeg = s.seq >= board && s.seq <= drop;
          return (
            <li key={s.seq} className={`rail-v-stop${inLeg ? ' in-leg' : ''}`}>
              <span className="rail-v-mark" aria-hidden="true" />
              <time className="rail-v-time" dateTime={s.at}>{fmt.time(s.at)}</time>
              <span className="rail-v-name">{s.name}</span>
              {s.seq === board && <span className="pill pill-brand">{t('trip.board')}</span>}
              {s.seq === drop && <span className="pill pill-ok">{t('trip.drop')}</span>}
            </li>
          );
        })}
      </ol>
    );
  }

  // Horizontal: the painted leg is positioned as a percentage of the whole run,
  // so the picture is proportional to the actual journey rather than to the
  // number of stops.
  const span = Math.max(1, stops.length - 1);
  const left = (board / span) * 100;
  const width = ((drop - board) / span) * 100;

  return (
    <div className="rail-h">
      <div className="rail-h-line" aria-hidden="true">
        <span className="rail-h-painted" style={{ left: `${left}%`, width: `${width}%` }} />
        {stops.map((s) => {
          const inLeg = s.seq >= board && s.seq <= drop;
          return (
            <span
              key={s.seq}
              className={`rail-h-mark${inLeg ? ' in-leg' : ''}`}
              style={{ left: `${(s.seq / span) * 100}%` }}
            />
          );
        })}
      </div>
      <div className="rail-h-ends">
        <span>{stops[board]?.name}</span>
        <span>{stops[drop]?.name}</span>
      </div>
    </div>
  );
}
