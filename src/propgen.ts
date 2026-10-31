// Prop parlay generator: DraftKings milestone props (via ESPN) scored against each player's recent games.
import { fetchInjuries, type Game, type LeagueKey } from './espn';
import { breakEven, toAmerican, toDecimal, type Leg } from './bets';
import { fetchGamelog, fetchPropBets, fetchRoster, milestoneRungs, MILESTONES, pool, type GameRow, type Rung } from './market';

export const PROP_LEAGUES = Object.keys(MILESTONES) as LeagueKey[];

const SAMPLE = 10; // most recent regular-season games
const MIN_GAMES = 4;
// The book's price counts as this many games of evidence, so a hot 10-game streak only moves the estimate halfway.
const PRIOR = 10;
const MAX_EDGE = 0.3;

export interface Candidate {
  key: string;
  league: LeagueKey;
  game: Game;
  date: string;
  athleteId: string;
  player: string;
  team: string;
  stat: string;
  label: string;
  target: number; // "N+"
  odds: number;
  n: number;
  hits: number;
  avg: number;
  implied: number; // book break-even, vig included
  est: number; // hit rate shrunk toward the book
  edge: number;
  gtd: boolean;
}

/** Scans every pregame game's milestone props and scores them. */
export async function scanProps(
  league: LeagueKey,
  games: Game[],
  date: string,
  onProgress: (msg: string) => void
): Promise<Candidate[]> {
  const pre = games.filter((g) => g.state === 'pre');
  if (!pre.length) return [];

  onProgress('Loading prop lines…');
  const injuries = await fetchInjuries(league).catch(() => ({} as Awaited<ReturnType<typeof fetchInjuries>>));
  const people = new Map<string, { name: string; team: string }>();
  const rungs: (Rung & { game: Game })[] = [];

  await pool(pre, 4, async (g) => {
    const [bets, away, home] = await Promise.all([
      fetchPropBets(league, g.id).catch(() => []),
      fetchRoster(league, g.away.id).catch(() => []),
      fetchRoster(league, g.home.id).catch(() => []),
    ]);
    for (const a of away) people.set(a.id, { name: a.name, team: g.away.abbr });
    for (const a of home) people.set(a.id, { name: a.name, team: g.home.abbr });
    rungs.push(...milestoneRungs(league, bets).map((r) => ({ ...r, game: g })));
  });

  const injuryByName = new Map(
    Object.values(injuries)
      .flat()
      .map((i) => [i.player, i.severity] as const)
  );
  const live = rungs.filter((r) => {
    const who = people.get(r.athleteId);
    return who && injuryByName.get(who.name) !== 'out';
  });

  const athletes = [...new Set(live.map((r) => r.athleteId))];
  const logs = new Map<string, GameRow[]>();
  let done = 0;
  await pool(athletes, 8, async (id) => {
    try {
      logs.set(id, (await fetchGamelog(league, id, SAMPLE)).slice(0, SAMPLE));
    } catch {
      /* skip players whose log fails */
    }
    onProgress(`Checking recent games… ${++done}/${athletes.length} players`);
  });

  const out: Candidate[] = [];
  for (const r of live) {
    const rows = logs.get(r.athleteId) ?? [];
    if (rows.length < MIN_GAMES) continue;
    const values = rows.map((row) => r.def.names.reduce((s, n) => s + (row.vals[n] ?? 0), 0));
    const hits = values.filter((v) => v >= r.target).length;
    const implied = breakEven(r.odds);
    const est = (hits + PRIOR * implied) / (rows.length + PRIOR);
    // Nobody beats DraftKings by 30 points; a gap that size means the line was misread, so leave it out.
    if (est - implied > MAX_EDGE) continue;
    const who = people.get(r.athleteId)!;
    out.push({
      key: `${r.athleteId}|${r.def.stat}|${r.target}`,
      league,
      game: r.game,
      date,
      athleteId: r.athleteId,
      player: who.name,
      team: who.team,
      stat: r.def.stat,
      label: r.def.label,
      target: r.target,
      odds: r.odds,
      n: rows.length,
      hits,
      avg: values.reduce((a, b) => a + b, 0) / values.length,
      implied,
      est,
      edge: est - implied,
      gtd: injuryByName.get(who.name) === 'q',
    });
  }
  return out.sort((a, b) => b.edge - a.edge);
}

export type Mode = 'safer' | 'balanced' | 'longshot';

export const MODES: Record<Mode, { label: string; hint: string; min: number; max: number; score: (c: Candidate) => number }> = {
  safer: { label: 'Safer', hint: 'Short-priced legs players clear most nights', min: -500, max: -140, score: (c) => c.est + c.edge },
  balanced: { label: 'Balanced', hint: 'Near even-money legs with the best edge', min: -220, max: 160, score: (c) => c.edge * 2 + c.est },
  longshot: { label: 'Longshot', hint: 'Plus-money ladders for a bigger payout', min: 100, max: 450, score: (c) => c.edge * 3 + c.est * 0.5 },
};

export interface Parlay {
  legs: Candidate[];
  odds: number;
  est: number; // product of leg estimates (assumes independence)
  implied: number;
  ev: number; // per unit staked, at the computed price
}

export interface BuildOptions {
  legs: number;
  mode: Mode;
  maxPerGame: number;
  gameId?: string;
  shuffle?: boolean;
}

function ranked(cands: Candidate[], opts: BuildOptions) {
  const m = MODES[opts.mode];
  return cands
    .filter((c) => c.odds >= m.min && c.odds <= m.max && c.edge > -0.03)
    .filter((c) => !opts.gameId || c.game.id === opts.gameId)
    .sort((a, b) => m.score(b) - m.score(a));
}

function summarizeParlay(legs: Candidate[]): Parlay {
  const dec = legs.reduce((p, l) => p * toDecimal(l.odds), 1);
  const est = legs.reduce((p, l) => p * l.est, 1);
  return { legs, odds: toAmerican(dec), est, implied: 1 / dec, ev: est * dec - 1 };
}

/** Replaces one leg with the best remaining candidate that fits the same rules, or null if none does. */
export function swapLeg(cands: Candidate[], parlay: Parlay, out: Candidate, opts: BuildOptions, skipped: Set<string>): Parlay | null {
  const rest = parlay.legs.filter((l) => l.key !== out.key);
  const players = new Set([...rest.map((l) => l.athleteId), out.athleteId]);
  const perGame = (id: string) => rest.filter((l) => l.game.id === id).length;
  const next = ranked(cands, opts).find(
    (c) => !players.has(c.athleteId) && !skipped.has(c.key) && perGame(c.game.id) < opts.maxPerGame
  );
  if (!next) return null;
  const legs = [...parlay.legs];
  legs[legs.indexOf(out)] = next;
  return summarizeParlay(legs);
}

/** Greedy pick by mode score, one leg per player and capped per game. `shuffle` widens the pool and samples. */
export function buildParlay(cands: Candidate[], opts: BuildOptions): Parlay | null {
  let list = ranked(cands, opts);
  if (opts.shuffle) {
    // Weighted sample from the top of the list so alternatives stay sensible.
    list = list
      .slice(0, Math.max(opts.legs * 4, 12))
      .map((c, i) => ({ c, w: Math.random() / (1 + i * 0.15) }))
      .sort((a, b) => b.w - a.w)
      .map((x) => x.c);
  }
  const legs: Candidate[] = [];
  const players = new Set<string>();
  const perGame = new Map<string, number>();
  for (const c of list) {
    if (legs.length >= opts.legs) break;
    if (players.has(c.athleteId) || (perGame.get(c.game.id) ?? 0) >= opts.maxPerGame) continue;
    legs.push(c);
    players.add(c.athleteId);
    perGame.set(c.game.id, (perGame.get(c.game.id) ?? 0) + 1);
  }
  return legs.length >= 2 ? summarizeParlay(legs) : null;
}

export function candidateLabel(c: Candidate) {
  return `${c.player} ${c.target}+ ${c.label}`;
}

/** As a parlay-slip leg: an "N+" milestone grades as over N − 0.5. */
export function toLeg(c: Candidate): Leg {
  return {
    league: c.league,
    eventId: c.game.id,
    matchup: `${c.game.away.abbr} @ ${c.game.home.abbr}`,
    date: c.date,
    market: 'prop',
    player: c.player,
    stat: c.stat,
    side: 'over',
    line: c.target - 0.5,
    odds: c.odds,
    selection: candidateLabel(c),
    status: 'pending',
  };
}
