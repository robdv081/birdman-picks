// Game-line legs for leagues without player props (college football): DraftKings moneylines and spreads,
// scored against ESPN's FPI matchup predictor.
import { LEAGUES, type Game, type LeagueKey } from './espn';
import { breakEven, fmtLine } from './bets';
import { getJson, pool } from './market';
import type { Candidate } from './propgen';

export const LINE_LEAGUES: LeagueKey[] = ['cfb'];

// Spread of final margins around the expected margin in college football, in points.
const MARGIN_SD = 15;
// FPI and the market each get half the say; the market is the sharper of the two on its own.
const MODEL_WEIGHT = 0.5;
const MAX_EDGE = 0.3;

/** Standard normal CDF (Abramowitz–Stegun 26.2.17, error < 7.5e-8). */
function phi(x: number) {
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989423 * Math.exp((-x * x) / 2);
  const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  return x > 0 ? 1 - p : p;
}

/** Inverse of phi by bisection; plenty fast for a few dozen games. */
function phiInv(p: number) {
  let lo = -8;
  let hi = 8;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if (phi(mid) < p) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

async function fpiHomeWin(league: LeagueKey, eventId: string): Promise<number | null> {
  const s = await getJson(`https://site.api.espn.com/apis/site/v2/sports/${LEAGUES[league].path}/summary?event=${eventId}`);
  const p = Number(s.predictor?.homeTeam?.gameProjection);
  return Number.isFinite(p) && p > 0 ? Math.min(0.99, Math.max(0.01, p / 100)) : null;
}

/** Moneyline and spread candidates for every pregame game that has both DraftKings odds and an FPI projection. */
export async function scanGameLines(league: LeagueKey, games: Game[], date: string, onProgress: (msg: string) => void): Promise<Candidate[]> {
  const pre = games.filter((g) => g.state === 'pre' && g.odds);
  const out: Candidate[] = [];
  let done = 0;
  await pool(pre, 8, async (g) => {
    const pHome = await fpiHomeWin(league, g.id).catch(() => null);
    onProgress(`Checking ESPN's FPI projections… ${++done}/${pre.length} games`);
    if (pHome == null) return;
    const o = g.odds!;
    const fpiMargin = MARGIN_SD * phiInv(pHome); // expected home margin implied by FPI
    const add = (side: 'home' | 'away', market: 'ml' | 'spread', odds: number | undefined, line: number | undefined, fpi: number) => {
      if (odds == null || (market === 'spread' && line == null)) return;
      const implied = breakEven(odds);
      const est = MODEL_WEIGHT * fpi + (1 - MODEL_WEIGHT) * implied;
      if (est - implied > MAX_EDGE) return;
      const t = side === 'home' ? g.home : g.away;
      const pick = market === 'ml' ? `${t.abbr} ML` : `${t.abbr} ${fmtLine(line)}`;
      out.push({
        key: `${g.id}|${market}|${side}`,
        kind: 'line',
        league,
        game: g,
        date,
        athleteId: g.id, // one leg per game: a team's moneyline and spread move together
        player: pick,
        team: t.abbr,
        stat: market,
        label: market === 'ml' ? 'moneyline' : 'spread',
        target: line ?? 0,
        side,
        odds,
        n: 0,
        hits: 0,
        avg: 0,
        implied,
        est,
        edge: est - implied,
        gtd: false,
        detail: `FPI ${(fpi * 100).toFixed(0)}% ${market === 'ml' ? 'to win' : 'to cover'}`,
      });
    };
    add('home', 'ml', o.homeML, undefined, pHome);
    add('away', 'ml', o.awayML, undefined, 1 - pHome);
    // P(home covers) = P(margin + homeLine > 0) with margin ~ Normal(fpiMargin, MARGIN_SD).
    if (o.homeSpread?.line != null) {
      const homeCover = phi((fpiMargin + o.homeSpread.line) / MARGIN_SD);
      add('home', 'spread', o.homeSpread.odds ?? -110, o.homeSpread.line, homeCover);
      add('away', 'spread', o.awaySpread?.odds ?? -110, o.awaySpread?.line ?? -o.homeSpread.line, 1 - homeCover);
    }
  });
  return out.sort((a, b) => b.edge - a.edge);
}
