// Game-line legs for leagues without player props (college football and basketball): DraftKings moneylines
// and spreads, scored against ESPN's matchup predictor (FPI for football, BPI for basketball).
import { LEAGUES, type Game, type LeagueKey } from './espn';
import { breakEven, fmtLine } from './bets';
import { getJson, pool } from './market';
import type { Candidate } from './propgen';

// Women's college hoops has no DraftKings odds on ESPN's feed, so it isn't offered here.
export const LINE_LEAGUES: LeagueKey[] = ['cfb', 'mcbb'];

// How far final margins land from the expected margin (standard deviation, points).
const MARGIN_SD: Partial<Record<LeagueKey, number>> = { cfb: 15, mcbb: 11 };
export const MODEL_NAME: Partial<Record<LeagueKey, string>> = { cfb: 'FPI', mcbb: 'BPI' };
// The model and the market each get half the say; the market is the sharper of the two on its own.
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

/**
 * ESPN's projection for the home team: win probability and, where published, projected margin
 * (BPI's "teampredmov", FPI's "teamPredPtDiff"). The margin beats inverting the win probability,
 * which ESPN caps near 98-99% and so understates blowouts.
 */
async function modelProjection(league: LeagueKey, eventId: string): Promise<{ pHome: number; margin?: number } | null> {
  const [sport, lg] = LEAGUES[league].path.split('/');
  const j = await getJson(`https://sports.core.api.espn.com/v2/sports/${sport}/leagues/${lg}/events/${eventId}/competitions/${eventId}/predictor`);
  const stats: { name: string; value?: number; displayValue?: string }[] = j.homeTeam?.statistics ?? [];
  const stat = (name: string) => {
    const x = stats.find((s) => s.name.toLowerCase() === name.toLowerCase());
    const v = Number(x?.value ?? parseFloat(x?.displayValue ?? ''));
    return Number.isFinite(v) ? v : undefined;
  };
  const p = stat('gameProjection');
  if (p == null || p <= 0) return null;
  return { pHome: Math.min(0.99, Math.max(0.01, p / 100)), margin: stat('teampredmov') ?? stat('teamPredPtDiff') };
}

/** The model's say on a spread shrinks as the spread grows: power ratings regress blowouts that the market prices in. */
const spreadWeight = (line: number) => MODEL_WEIGHT * Math.min(1, Math.max(0.3, 1 - (Math.abs(line) - 10) / 25));

/** Moneyline and spread candidates for every pregame game that has both DraftKings odds and a model projection. */
export async function scanGameLines(league: LeagueKey, games: Game[], date: string, onProgress: (msg: string) => void): Promise<Candidate[]> {
  const pre = games.filter((g) => g.state === 'pre' && g.odds);
  const out: Candidate[] = [];
  let done = 0;
  await pool(pre, 8, async (g) => {
    const proj = await modelProjection(league, g.id).catch(() => null);
    onProgress(`Checking ESPN's ${MODEL_NAME[league] ?? 'model'} projections… ${++done}/${pre.length} games`);
    if (!proj) return;
    const { pHome } = proj;
    const o = g.odds!;
    const sd = MARGIN_SD[league] ?? 13;
    const fpiMargin = proj.margin ?? sd * phiInv(pHome); // expected home margin from the model
    const add = (side: 'home' | 'away', market: 'ml' | 'spread', odds: number | undefined, line: number | undefined, fpi: number) => {
      if (odds == null || (market === 'spread' && line == null)) return;
      const implied = breakEven(odds);
      const w = market === 'spread' ? spreadWeight(line!) : MODEL_WEIGHT;
      const est = w * fpi + (1 - w) * implied;
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
        detail:
          market === 'ml'
            ? `${MODEL_NAME[league] ?? 'Model'} ${(fpi * 100).toFixed(0)}% to win`
            : `${MODEL_NAME[league] ?? 'Model'} has ${fpiMargin >= 0 ? g.home.abbr : g.away.abbr} by ${Math.abs(fpiMargin).toFixed(1)} · ${(fpi * 100).toFixed(0)}% to cover`,
      });
    };
    add('home', 'ml', o.homeML, undefined, pHome);
    add('away', 'ml', o.awayML, undefined, 1 - pHome);
    // P(home covers) = P(margin + homeLine > 0) with margin ~ Normal(fpiMargin, MARGIN_SD).
    if (o.homeSpread?.line != null) {
      const homeCover = phi((fpiMargin + o.homeSpread.line) / sd);
      add('home', 'spread', o.homeSpread.odds ?? -110, o.homeSpread.line, homeCover);
      add('away', 'spread', o.awaySpread?.odds ?? -110, o.awaySpread?.line ?? -o.homeSpread.line, 1 - homeCover);
    }
  });
  return out.sort((a, b) => b.edge - a.edge);
}
