// Shared access to ESPN's player-market data: DraftKings prop lines, rosters, game logs, closing odds,
// and market-implied stat projections built from them.
import { LEAGUES, parseAmerican, type Game, type LeagueKey, type Price } from './espn';
import { breakEven } from './bets';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Json = any;

export const getJson = async (url: string): Promise<Json> => {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`ESPN returned ${res.status}`);
  return res.json();
};

/** Run async jobs with limited concurrency. */
export async function pool<T>(items: T[], size: number, fn: (t: T) => Promise<void>) {
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(size, items.length) }, async () => {
      while (i < items.length) await fn(items[i++]);
    })
  );
}

/** A one-sided "N+" market and the game-log columns that add up to it. */
export interface MarketDef {
  stat: string; // key into PROP_STATS, so legs built from it auto-grade
  label: string;
  names: string[];
  fixedTarget?: number; // e.g. Anytime Goalscorer = 1+ goals
}

// One-sided markets only: ESPN's "Total ..." over/under pairs don't say which price is the over.
export const MILESTONES: Partial<Record<LeagueKey, Record<string, MarketDef>>> = {
  nba: {
    'Points Milestones': { stat: 'pts', label: 'points', names: ['points'] },
    'Rebounds Milestones': { stat: 'reb', label: 'rebounds', names: ['totalRebounds'] },
    'Assists Milestones': { stat: 'ast', label: 'assists', names: ['assists'] },
    '3-Point Field Goals Milestones': { stat: '3pm', label: 'threes', names: ['threePointFieldGoalsMade-threePointFieldGoalsAttempted'] },
    'Points + Rebounds Milestones': { stat: 'pr', label: 'pts + reb', names: ['points', 'totalRebounds'] },
    'Points + Assists Milestones': { stat: 'pa', label: 'pts + ast', names: ['points', 'assists'] },
    'Rebounds + Assists Milestones': { stat: 'ra', label: 'reb + ast', names: ['totalRebounds', 'assists'] },
    'Points + Assists + Rebounds Milestones': { stat: 'pra', label: 'pts + reb + ast', names: ['points', 'totalRebounds', 'assists'] },
  },
  nhl: {
    'Shots on Goal Milestones': { stat: 'sog', label: 'shots on goal', names: ['shotsTotal'] },
    'Points Milestones': { stat: 'pts', label: 'points', names: ['points'] },
    'Goals Milestones': { stat: 'g', label: 'goals', names: ['goals'] },
    'Assists Milestones': { stat: 'a', label: 'assists', names: ['assists'] },
    'Anytime Goalscorer': { stat: 'g', label: 'goals', names: ['goals'], fixedTarget: 1 },
  },
  nfl: {
    'Passing Yards Milestones': { stat: 'passYds', label: 'passing yds', names: ['passingYards'] },
    'Rushing Yards Milestones': { stat: 'rushYds', label: 'rushing yds', names: ['rushingYards'] },
    'Receiving Yards Milestones': { stat: 'recYds', label: 'receiving yds', names: ['receivingYards'] },
    'Rushing + Receiving Yards Milestones': { stat: 'rushRecYds', label: 'rush + rec yds', names: ['rushingYards', 'receivingYards'] },
    'Anytime Touchdown Scorer': { stat: 'tds', label: 'TD', names: ['rushingTouchdowns', 'receivingTouchdowns'], fixedTarget: 1 },
  },
};

// The line of an over/under pair is the book's 50/50 point even though the side labels are missing.
const TOTALS: Partial<Record<LeagueKey, Record<string, string>>> = {
  nba: {
    'Total Points': 'pts',
    'Total Rebounds': 'reb',
    'Total Assists': 'ast',
    'Total 3-Point Field Goals': '3pm',
    'Total Steals': 'stl',
  },
  nhl: {
    'Total Shots on Goal': 'sog',
    'Total Points': 'pts',
    'Total Assists': 'a',
  },
};

export async function fetchPropBets(league: LeagueKey, eventId: string): Promise<Json[]> {
  const [sport, lg] = LEAGUES[league].path.split('/');
  const base = `https://sports.core.api.espn.com/v2/sports/${sport}/leagues/${lg}/events/${eventId}/competitions/${eventId}/odds/100/propBets?limit=1000`;
  const first = await getJson(base);
  const items: Json[] = [...(first.items ?? [])];
  for (let p = 2; p <= (first.pageCount ?? 1); p++) items.push(...((await getJson(`${base}&page=${p}`)).items ?? []));
  return items;
}

export interface RosterPlayer {
  id: string;
  name: string;
  pos?: string;
}

export async function fetchRoster(league: LeagueKey, teamId: string): Promise<RosterPlayer[]> {
  const j = await getJson(`https://site.api.espn.com/apis/site/v2/sports/${LEAGUES[league].path}/teams/${teamId}/roster`);
  // NBA lists athletes flat; NFL/NHL group them by position.
  return (j.athletes ?? [])
    .flatMap((a: Json) => a.items ?? [a])
    .map((a: Json) => ({ id: String(a.id), name: a.displayName ?? a.fullName, pos: a.position?.abbreviation }));
}

export const athleteIdOf = (ref?: string) => ref?.match(/athletes\/(\d+)/)?.[1];

// ---- Game logs -------------------------------------------------------------

export type GameRow = { id: string; date: string; teamId: string; vals: Record<string, number> };

const cellValue = (v: unknown) => {
  const n = parseFloat(String(v ?? '').split('-')[0]);
  return Number.isFinite(n) ? n : 0;
};

function parseGamelog(j: Json): { rows: GameRow[]; season?: string } {
  const names: string[] = j.names ?? [];
  const rows: GameRow[] = [];
  let season: string | undefined;
  for (const st of j.seasonTypes ?? []) {
    if (!/regular/i.test(st.displayName ?? '')) continue;
    season ??= st.displayName;
    for (const cat of st.categories ?? [])
      for (const ev of cat.events ?? []) {
        const vals: Record<string, number> = {};
        names.forEach((n, i) => (vals[n] = cellValue(ev.stats?.[i])));
        const meta = j.events?.[ev.eventId];
        rows.push({ id: String(ev.eventId), date: meta?.gameDate ?? '', teamId: String(meta?.team?.id ?? ''), vals });
      }
  }
  return { rows, season };
}

const logCache = new Map<string, Promise<GameRow[]>>();

/**
 * Regular-season games, newest first. Adds last season when this one has fewer than `minGames`
 * (pass Infinity to always include it).
 */
export function fetchGamelog(league: LeagueKey, athleteId: string, minGames = 10): Promise<GameRow[]> {
  const key = `${league}|${athleteId}|${minGames}`;
  if (!logCache.has(key)) {
    const p = (async () => {
      const url = `https://site.web.api.espn.com/apis/common/v3/sports/${LEAGUES[league].path}/athletes/${athleteId}/gamelog`;
      const cur = parseGamelog(await getJson(url));
      let rows = cur.rows;
      const m = cur.season?.match(/(\d{4})(-\d{2})?/);
      if (rows.length < minGames && m) {
        // "2026-27 Regular Season" → last season is ?season=2026; "2026 Regular Season" → ?season=2025.
        const prev = m[2] ? Number(m[1]) : Number(m[1]) - 1;
        try {
          rows = rows.concat(parseGamelog(await getJson(`${url}?season=${prev}`)).rows);
        } catch {
          /* rookies have no prior season */
        }
      }
      // If ESPN ignores ?season and repeats this season, don't count those games twice.
      return [...new Map(rows.map((r) => [r.id, r])).values()].sort((a, b) => b.date.localeCompare(a.date));
    })();
    p.catch(() => logCache.delete(key));
    logCache.set(key, p);
  }
  return logCache.get(key)!;
}

// ---- Milestone ladders -----------------------------------------------------

export interface Rung {
  athleteId: string;
  def: MarketDef;
  target: number;
  odds: number;
}

/** Priced "N+" rungs, cleaned of the other ladders ESPN mixes into some milestone types. */
export function milestoneRungs(league: LeagueKey, items: Json[]): Rung[] {
  const markets = MILESTONES[league] ?? {};
  // Where a target repeats (e.g. 1st-quarter rebounds filed under "Rebounds Milestones"), keep the shorter price:
  // the full game always clears a bar at least as often.
  const best = new Map<string, Rung>();
  for (const b of items) {
    const def = markets[b.type?.name];
    const odds = parseAmerican(b.odds?.american?.value);
    const target = def?.fixedTarget ?? b.current?.target?.value;
    const athleteId = athleteIdOf(b.athlete?.$ref);
    if (!def || odds == null || target == null || !athleteId) continue;
    const r = { athleteId, def, target: Number(target), odds };
    const k = `${athleteId}|${def.stat}|${r.target}`;
    const prev = best.get(k);
    if (!prev || breakEven(odds) > breakEven(prev.odds)) best.set(k, r);
  }
  // A real ladder gets less likely as the target rises; a rung priced below a higher rung came from another market.
  const rungs = [...best.values()];
  return rungs.filter(
    (r) => !rungs.some((o) => o.athleteId === r.athleteId && o.def.stat === r.def.stat && o.target > r.target && breakEven(o.odds) > breakEven(r.odds))
  );
}

/** Over/under lines by "athleteId|stat". */
export function totalLines(league: LeagueKey, items: Json[]): Map<string, number> {
  const map = TOTALS[league] ?? {};
  const out = new Map<string, number>();
  for (const b of items) {
    const stat = map[b.type?.name];
    const id = athleteIdOf(b.athlete?.$ref);
    const line = Number(b.current?.target?.value ?? b.odds?.total?.value);
    if (stat && id && Number.isFinite(line)) out.set(`${id}|${stat}`, line);
  }
  return out;
}

// One-sided milestone prices carry a margin that grows on longshots; raising the implied probability to this
// power strips most of it. Calibrated on 292 NBA player-stats (Oct 31, 2026): ladder means then land on the
// book's own over/under line with ~0 bias and a 0.28 average miss.
const VIG_EXP = 1.2;

/** Expected value of a stat from its "N+" ladder: sum of P(X ≥ k), interpolating between rungs. */
export function ladderMean(rungs: { target: number; odds: number }[]): number {
  const pts = rungs
    .map((r) => ({ t: r.target, p: Math.pow(breakEven(r.odds), VIG_EXP) }))
    .sort((a, b) => a.t - b.t);
  if (!pts.length) return 0;
  const knots = [{ t: 0, p: 1 }, ...pts];
  const last = pts[pts.length - 1];
  let mean = 0;
  for (let k = 1; k <= last.t; k++) {
    const i = knots.findIndex((x) => x.t >= k);
    const a = knots[i - 1];
    const b = knots[i];
    mean += a.p + ((b.p - a.p) * (k - a.t)) / (b.t - a.t);
  }
  // Geometric tail past the top rung, decaying at the rate between the last two rungs.
  const prev = knots[knots.length - 2];
  const rate = Math.min(0.95, Math.pow(last.p / prev.p, 1 / Math.max(1, last.t - prev.t)));
  return mean + (last.p * rate) / (1 - rate);
}

// ---- Market projections (NBA) ------------------------------------------------

export const NBA_STAT_COLS: Record<string, string> = {
  pts: 'points',
  reb: 'totalRebounds',
  ast: 'assists',
  '3pm': 'threePointFieldGoalsMade-threePointFieldGoalsAttempted',
  stl: 'steals',
  blk: 'blocks',
  to: 'turnovers',
  min: 'minutes',
};

export interface PlayerProjection {
  athleteId: string;
  name: string;
  team: string;
  teamId: string;
  pos?: string;
  gameId: string;
  mean: Record<string, number>;
  source: Record<string, 'line' | 'ladder' | 'recent'>;
  hasMarket: boolean;
  ddProb: number;
  minutes: number[]; // last 5 games, newest first
}

/** Per-player stat projections for one game: book lines first, then milestone ladders, then the last 10 games. */
export async function projectGame(game: Game, wanted?: (name: string) => boolean): Promise<PlayerProjection[]> {
  const league: LeagueKey = 'nba';
  const [items, away, home] = await Promise.all([
    fetchPropBets(league, game.id).catch(() => [] as Json[]),
    fetchRoster(league, game.away.id).catch(() => [] as RosterPlayer[]),
    fetchRoster(league, game.home.id).catch(() => [] as RosterPlayer[]),
  ]);
  const lines = totalLines(league, items);
  const rungs = milestoneRungs(league, items);
  const dd = new Map<string, number>();
  for (const b of items) {
    const id = athleteIdOf(b.athlete?.$ref);
    const odds = parseAmerican(b.odds?.american?.value);
    if (b.type?.name === 'To Record a Double Double' && id && odds != null) dd.set(id, Math.pow(breakEven(odds), VIG_EXP));
  }
  const marketIds = new Set(items.map((b) => athleteIdOf(b.athlete?.$ref)).filter(Boolean));

  const players = [
    ...away.map((p) => ({ ...p, team: game.away.abbr, teamId: game.away.id })),
    ...home.map((p) => ({ ...p, team: game.home.abbr, teamId: game.home.id })),
  ].filter((p) => !wanted || wanted(p.name));

  const out: PlayerProjection[] = [];
  await pool(players, 6, async (p) => {
    const log = (await fetchGamelog(league, p.id, 5).catch(() => [] as GameRow[])).slice(0, 10);
    const mean: Record<string, number> = {};
    const source: PlayerProjection['source'] = {};
    for (const [stat, col] of Object.entries(NBA_STAT_COLS)) {
      const line = lines.get(`${p.id}|${stat}`);
      const ladder = rungs.filter((r) => r.athleteId === p.id && r.def.stat === stat);
      if (line != null) {
        mean[stat] = line;
        source[stat] = 'line';
      } else if (ladder.length >= 2) {
        mean[stat] = ladderMean(ladder);
        source[stat] = 'ladder';
      } else {
        mean[stat] = log.length ? log.reduce((s, r) => s + (r.vals[col] ?? 0), 0) / log.length : 0;
        source[stat] = 'recent';
      }
    }
    out.push({
      athleteId: p.id,
      name: p.name,
      team: p.team,
      teamId: p.teamId,
      pos: p.pos,
      gameId: game.id,
      mean,
      source,
      hasMarket: marketIds.has(p.id),
      ddProb: dd.get(p.id) ?? 0,
      minutes: log.slice(0, 5).map((r) => r.vals.minutes ?? 0),
    });
  });
  return out;
}

// ---- Closing lines -----------------------------------------------------------

export interface CloseOdds {
  awayML?: number;
  homeML?: number;
  awaySpread?: Price;
  homeSpread?: Price;
  over?: Price;
  under?: Price;
}

/** DraftKings' closing prices for a game; ESPN keeps these after the scoreboard drops its odds. */
export async function fetchCloseOdds(league: LeagueKey, eventId: string): Promise<CloseOdds> {
  const [sport, lg] = LEAGUES[league].path.split('/');
  const o = await getJson(`https://sports.core.api.espn.com/v2/sports/${sport}/leagues/${lg}/events/${eventId}/competitions/${eventId}/odds/100`);
  const side = (t: Json) => t?.close ?? t?.current ?? {};
  const a = side(o.awayTeamOdds);
  const h = side(o.homeTeamOdds);
  const c = o.close ?? o.current ?? {};
  const num = (v: unknown) => (v == null || v === '' ? undefined : Number(v));
  const total = num(c.total?.american) ?? o.overUnder;
  return {
    awayML: parseAmerican(a.moneyLine?.american) ?? o.awayTeamOdds?.moneyLine,
    homeML: parseAmerican(h.moneyLine?.american) ?? o.homeTeamOdds?.moneyLine,
    awaySpread: { line: num(a.pointSpread?.american), odds: parseAmerican(a.spread?.american) },
    homeSpread: { line: num(h.pointSpread?.american), odds: parseAmerican(h.spread?.american) },
    over: { line: total, odds: parseAmerican(c.over?.american) },
    under: { line: total, odds: parseAmerican(c.under?.american) },
  };
}
