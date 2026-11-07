import type { Game } from '../espn';
import { LEAGUES } from '../espn';

/** Live football games you're watching that are inside the 20 right now. */
export default function RedZoneBar({ games }: { games: Game[] }) {
  const rz = games.filter((g) => g.situation?.redZone);
  if (!rz.length) return null;
  return (
    <div className="rzbar" role="status" aria-live="polite">
      {rz.map((g) => (
        <a key={g.id} className="rzitem" href={`#${g.league}`}>
          <span className="rzflag">Red Zone</span>
          <b>{g.situation?.possession ?? ''} ball</b>
          <span>{g.situation?.text}</span>
          <small className="muted">
            {g.away.abbr} {g.away.score ?? 0} – {g.home.abbr} {g.home.score ?? 0} · {g.detail} · {LEAGUES[g.league].label}
          </small>
        </a>
      ))}
    </div>
  );
}
