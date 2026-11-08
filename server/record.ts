// Birdman's public record. Picks are posted by the owner, stamped with the server's clock, refused once
// the game has started, chained by hash so a removed or edited pick shows, and graded by the server.
import { isThreeWay, LEAGUES, type LeagueKey } from '../src/espn';
import { clv, profit, type Bet, type BetSide, type BetStatus, type Market } from '../src/bets';
import { PROP_STATS } from '../src/stats';
import { GENESIS, pickHash } from '../src/recordhash';
import { HttpError, json, readJson, str, isYMD, bearer, timingSafeEqual, type Deps, type Env } from './util';

export interface PickRow {
  seq: number;
  id: string;
  created_at: number;
  start_at: number;
  league: string;
  event_id: string;
  date: string;
  matchup: string;
  market: string;
  side: string;
  line: number | null;
  odds: number;
  selection: string;
  player: string | null;
  stat: string | null;
  units: number;
  reason: string;
  author: string;
  prev_hash: string;
  hash: string;
  status: string;
  final_score: string | null;
  margin: number | null;
  close_odds: number | null;
  close_line: number | null;
  close_checked: number;
  graded_at: number | null;
}

const MARKETS: Market[] = ['ml', 'spread', 'total', 'prop'];

const strong = (k?: string) => !!k && k.length >= 16;

/** Who is posting: the owner, the pick agent, or nobody allowed. */
export function poster(request: Request, env: Env): 'owner' | 'model' | null {
  const key = bearer(request);
  if (!key) return null;
  if (strong(env.ADMIN_KEY) && timingSafeEqual(key, env.ADMIN_KEY!)) return 'owner';
  if (strong(env.AGENT_KEY) && timingSafeEqual(key, env.AGENT_KEY!)) return 'model';
  return null;
}

export const isAdmin = (request: Request, env: Env) => poster(request, env) === 'owner';

/** The checked, locked fields of a new pick, shared by the Birdman record and players' records. */
export interface PickCore {
  start_at: number;
  league: string;
  event_id: string;
  date: string;
  matchup: string;
  market: string;
  side: string;
  line: number | null;
  odds: number;
  selection: string;
  player: string | null;
  stat: string | null;
}

/**
 * Checks a pick against ESPN: a real game that hasn't started (by the server's clock and ESPN's state, never the
 * phone's), a real market and side, an American price. Builds the label the same way for everyone.
 */
export async function validatePick(b: Record<string, unknown>, deps: Deps): Promise<PickCore> {
  const league = str(b.league, 20) as LeagueKey;
  const eventId = str(b.eventId, 30);
  const date = str(b.date, 10);
  const market = str(b.market, 10) as Market;
  const side = str(b.side, 10) as BetSide;
  const odds = Number(b.odds);
  const line = b.line == null || b.line === '' ? null : Number(b.line);
  const player = market === 'prop' ? str(b.player, 60) : '';
  const stat = market === 'prop' ? str(b.stat, 20) : '';

  if (!(league in LEAGUES) || LEAGUES[league].kind === 'field') throw new HttpError(400, 'Pick a game from Scores.');
  if (!/^\d{1,30}$/.test(eventId) || !isYMD(date)) throw new HttpError(400, 'That game link is missing.');
  if (!MARKETS.includes(market)) throw new HttpError(400, 'Only moneylines, spreads, totals and player props go on the record.');
  const sides: BetSide[] =
    market === 'ml' ? (isThreeWay(league) ? ['home', 'away', 'draw'] : ['home', 'away']) : market === 'spread' ? ['home', 'away'] : ['over', 'under'];
  if (!sides.includes(side)) throw new HttpError(400, 'Pick a side.');
  if (!Number.isInteger(odds) || Math.abs(odds) < 100 || Math.abs(odds) > 100000) throw new HttpError(400, 'Odds must be American, like -110 or +150.');
  if ((market === 'spread' || market === 'total' || market === 'prop') && (line == null || !Number.isFinite(line))) throw new HttpError(400, 'This pick needs a line.');
  if (market === 'prop' && (!player || !PROP_STATS[league]?.some((s) => s.key === stat))) throw new HttpError(400, 'Props need a player and a stat.');

  const game = (await deps.games(league, date)).find((g) => g.id === eventId);
  if (!game) throw new HttpError(404, "Couldn't find that game on ESPN.");
  const startAt = Date.parse(game.start);
  if (game.state !== 'pre' || !(startAt > deps.now())) throw new HttpError(409, 'That game has started. Picks lock at kickoff.');

  const matchup = LEAGUES[league].kind === 'versus' ? `${game.away.name} vs ${game.home.name}` : `${game.away.abbr} @ ${game.home.abbr}`;
  const team = side === 'home' ? game.home : side === 'away' ? game.away : null;
  const fmtLine = (n: number) => (n > 0 ? `+${n}` : `${n}`);
  const selection =
    market === 'ml'
      ? side === 'draw' ? `${matchup} Draw` : `${team!.abbr} ML`
      : market === 'spread'
        ? `${team!.abbr} ${fmtLine(line!)}`
        : market === 'total'
          ? `${matchup} ${side === 'over' ? 'Over' : 'Under'} ${line}`
          : `${player} ${side === 'over' ? 'Over' : 'Under'} ${line} ${PROP_STATS[league]!.find((s) => s.key === stat)!.label}`;
  return { start_at: startAt, league, event_id: eventId, date, matchup, market, side, line, odds, selection, player: player || null, stat: stat || null };
}

/** POST /api/record/picks — the owner or the pick agent. */
export async function postPick(request: Request, env: Env, deps: Deps) {
  const author = poster(request, env);
  if (!author) throw new HttpError(401, 'Owner key required.');
  const b = await readJson(request);
  const units = Number(b.units ?? 1);
  const reason = str(b.reason, 600);
  if (!Number.isFinite(units) || units < 0.1 || units > 10) throw new HttpError(400, 'Stake must be 0.1 to 10 units.');
  const core = await validatePick(b, deps);
  const now = deps.now();

  const last = await env.DB.prepare('SELECT seq, hash FROM picks ORDER BY seq DESC LIMIT 1').first<{ seq: number; hash: string }>();
  const row = {
    seq: (last?.seq ?? 0) + 1,
    id: crypto.randomUUID(),
    created_at: now,
    ...core,
    units: Math.round(units * 10) / 10,
    reason,
    author,
  };
  const prev = last?.hash ?? GENESIS;
  const hash = await pickHash(prev, row);
  try {
    await env.DB.prepare(
      `INSERT INTO picks (seq, id, created_at, start_at, league, event_id, date, matchup, market, side, line, odds, selection, player, stat, units, reason, author, prev_hash, hash)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
      .bind(row.seq, row.id, row.created_at, row.start_at, row.league, row.event_id, row.date, row.matchup, row.market, row.side, row.line,
        row.odds, row.selection, row.player, row.stat, row.units, row.reason, row.author, prev, hash)
      .run();
  } catch {
    // Two posts at the same moment both took the same number; the second one should just try again.
    throw new HttpError(409, 'Another pick was posted at the same time. Try again.');
  }
  return json({ pick: publicPick({ ...row, prev_hash: prev, hash, status: 'pending', final_score: null, margin: null, close_odds: null, close_line: null, close_checked: 0, graded_at: null }) }, 201);
}

export function publicPick(r: PickRow) {
  return {
    seq: r.seq,
    id: r.id,
    createdAt: r.created_at,
    startAt: r.start_at,
    league: r.league,
    eventId: r.event_id,
    date: r.date,
    matchup: r.matchup,
    market: r.market,
    side: r.side,
    line: r.line,
    odds: r.odds,
    selection: r.selection,
    player: r.player,
    stat: r.stat,
    units: r.units,
    reason: r.reason,
    author: r.author,
    prevHash: r.prev_hash,
    hash: r.hash,
    status: r.status,
    finalScore: r.final_score,
    margin: r.margin,
    closeOdds: r.close_odds,
    closeLine: r.close_line,
    gradedAt: r.graded_at,
  };
}

export function toBet(r: PickRow): Bet {
  return {
    id: r.id,
    createdAt: new Date(r.created_at).toISOString(),
    date: r.date,
    selection: r.selection,
    market: r.market as Market,
    odds: r.odds,
    league: r.league as LeagueKey,
    eventId: r.event_id,
    matchup: r.matchup,
    side: r.side as BetSide,
    line: r.line ?? undefined,
    player: r.player ?? undefined,
    stat: r.stat ?? undefined,
    stake: r.units,
    status: r.status as BetStatus,
    finalScore: r.final_score ?? undefined,
    margin: r.margin ?? undefined,
    closeOdds: r.close_odds ?? undefined,
    closeLine: r.close_line ?? undefined,
    closeChecked: !!r.close_checked,
  };
}

export function summarizeRecord(rows: PickRow[]) {
  let won = 0, lost = 0, push = 0, pending = 0, staked = 0, units = 0, clvMeasured = 0, clvBeat = 0;
  for (const r of rows) {
    const b = toBet(r);
    if (b.status === 'pending') pending++;
    else if (b.status === 'won') won++;
    else if (b.status === 'lost') lost++;
    else if (b.status === 'push') push++;
    if (b.status === 'won' || b.status === 'lost') staked += b.stake;
    units += profit(b);
    const c = clv(b);
    if (c) {
      clvMeasured++;
      if (c.beat) clvBeat++;
    }
  }
  const round = (n: number) => Math.round(n * 100) / 100;
  return { won, lost, push, pending, units: round(units), roi: staked ? round(units / staked) : 0, clvMeasured, clvBeat };
}

/**
 * A pick before its game starts, as everyone but Pro members sees it: that a pick is locked, for which sport and
 * start time, with its hash. The pick itself shows at the start, and its hash proves it wasn't changed.
 */
export function sealedPick(r: PickRow) {
  return {
    ...publicPick(r),
    sealed: true,
    eventId: '',
    matchup: '',
    market: '',
    side: '',
    line: null,
    odds: 0,
    selection: 'Locked pick',
    player: null,
    stat: null,
    reason: '',
  };
}

/** Who sees picks before their games start: the owner, the pick agent, the Scout publisher and Pro members. */
async function seesSealed(request: Request, env: Env, isPro: (r: Request, e: Env) => Promise<unknown>) {
  if (poster(request, env)) return true;
  const key = bearer(request);
  if (!key) return false;
  if (strong(env.SCOUT_PUBLISH_KEY) && timingSafeEqual(key, env.SCOUT_PUBLISH_KEY!)) return true;
  return isPro(request, env).then(
    () => true,
    () => false
  );
}

/** GET /api/record — public; picks whose games haven't started are sealed except for Pro members. */
export async function getRecord(request: Request, env: Env, deps: Deps, isPro: (r: Request, e: Env) => Promise<unknown>) {
  const { results } = await env.DB.prepare('SELECT * FROM picks ORDER BY seq ASC').all<PickRow>();
  const now = deps.now();
  const anySealed = results.some((r) => r.start_at > now);
  const full = anySealed && (await seesSealed(request, env, isPro));
  const picks = results.map((r) => (r.start_at > now && !full ? sealedPick(r) : publicPick(r))).reverse();
  return json({ picks, summary: summarizeRecord(results), genesis: GENESIS, sealed: anySealed && !full }, 200, {
    'Cache-Control': 'private, max-age=15',
    Vary: 'Authorization',
  });
}

/**
 * Every few minutes: record closing lines once games start, and grade finished games, for the Birdman record and
 * players' records together (one look at each scoreboard). Players' picks also store whether they beat the close.
 */
export async function settleRecord(env: Env, deps: Deps) {
  const now = deps.now();
  // Closing lines are only worth chasing for a few days after kickoff.
  const due = "WHERE start_at <= ? AND (status = 'pending' OR (close_checked = 0 AND start_at > ?)) ORDER BY start_at LIMIT 200";
  const [own, theirs] = await Promise.all([
    env.DB.prepare(`SELECT * FROM picks ${due}`).bind(now, now - 3 * 86400_000).all<PickRow>(),
    env.DB.prepare(`SELECT * FROM user_picks ${due}`).bind(now, now - 3 * 86400_000).all<PickRow>(),
  ]);
  const table = new Map<string, string>();
  for (const r of own.results) table.set(r.id, 'picks');
  for (const r of theirs.results) table.set(r.id, 'user_picks');
  const results = [...own.results, ...theirs.results];
  if (!results.length) return { closed: 0, graded: 0 };
  const bets = results.map(toBet);

  const stmts = [];
  let closed = 0;
  let graded = 0;
  const closes = await deps.closes(bets.filter((b) => !b.closeChecked));
  for (const [id, c] of closes) {
    if (!c.closeChecked) continue;
    closed++;
    const t = table.get(id);
    if (t === 'user_picks') {
      const b = bets.find((x) => x.id === id)!;
      const v = clv({ ...b, closeOdds: c.closeOdds, closeLine: c.closeLine, closeChecked: true });
      stmts.push(
        env.DB.prepare('UPDATE user_picks SET close_odds = ?, close_line = ?, close_checked = 1, clv_beat = ? WHERE id = ? AND close_checked = 0').bind(
          c.closeOdds ?? null, c.closeLine ?? null, v ? (v.beat ? 1 : 0) : null, id)
      );
    } else
      stmts.push(
        env.DB.prepare('UPDATE picks SET close_odds = ?, close_line = ?, close_checked = 1 WHERE id = ? AND close_checked = 0').bind(
          c.closeOdds ?? null, c.closeLine ?? null, id)
      );
  }
  const grades = await deps.grade(bets.filter((b) => b.status === 'pending'));
  for (const [id, g] of grades) {
    if (!g.status || g.status === 'pending') continue;
    graded++;
    stmts.push(
      env.DB.prepare(`UPDATE ${table.get(id) === 'user_picks' ? 'user_picks' : 'picks'} SET status = ?, final_score = ?, margin = ?, graded_at = ? WHERE id = ? AND status = 'pending'`).bind(
        g.status, g.finalScore ?? null, g.margin ?? null, now, id)
    );
  }
  if (stmts.length) await env.DB.batch(stmts);
  return { closed, graded };
}
