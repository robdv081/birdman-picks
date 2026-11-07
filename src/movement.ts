// Line movement: how far DraftKings' spread, total and moneyline have moved since they opened.
import type { Game, LeagueKey } from './espn';
import { breakEven, fmtAmerican, fmtLine } from './bets';

export interface Move {
  kind: 'spread' | 'total' | 'ml';
  text: string; // "BUF -1.5 → -3"
  big: boolean;
  size: number; // move relative to its "big" threshold, for ranking across games
}

// What counts as a big move, per league: points of spread or total, or win probability on the moneyline.
const BIG: Record<LeagueKey, { spread: number; total: number }> = {
  nfl: { spread: 1.5, total: 2 },
  cfb: { spread: 2, total: 3 },
  nba: { spread: 2, total: 3 },
  nhl: { spread: 0.5, total: 0.5 },
  mlb: { spread: 0.5, total: 0.5 },
};
const BIG_ML = 0.05;

export function lineMoves(g: Game): Move[] {
  const o = g.odds;
  const open = o?.open;
  if (!o || !open) return [];
  const t = BIG[g.league];
  const moves: Move[] = [];

  const hs = o.homeSpread?.line;
  if (open.homeSpread != null && hs != null && open.homeSpread !== hs) {
    // Quote it for whichever team is favored now.
    const favHome = hs <= 0;
    const team = favHome ? g.home.abbr : g.away.abbr;
    const from = favHome ? open.homeSpread : -open.homeSpread;
    const to = favHome ? hs : -hs;
    const d = Math.abs(hs - open.homeSpread);
    moves.push({ kind: 'spread', text: `${team} ${fmtLine(from)} → ${fmtLine(to)}`, big: d >= t.spread, size: d / t.spread });
  }

  const total = o.over?.line;
  if (open.total != null && total != null && open.total !== total) {
    const d = Math.abs(total - open.total);
    moves.push({ kind: 'total', text: `Total ${open.total} → ${total}`, big: d >= t.total, size: d / t.total });
  }

  if (open.homeML != null && o.homeML != null && open.homeML !== o.homeML) {
    const d = Math.abs(breakEven(o.homeML) - breakEven(open.homeML));
    // Skip the moneyline when the spread already tells the story.
    if (!moves.some((m) => m.kind === 'spread')) {
      moves.push({ kind: 'ml', text: `${g.home.abbr} ML ${fmtAmerican(open.homeML)} → ${fmtAmerican(o.homeML)}`, big: d >= BIG_ML, size: d / BIG_ML });
    }
  }
  return moves;
}
