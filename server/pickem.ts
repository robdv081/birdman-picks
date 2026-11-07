// Free pick'em: friends make a pool, pick game winners, and climb a weekly and all-time leaderboard.
// No entry fee and no prizes, so it stays a game rather than a contest. Picks lock at kickoff
// (checked by the server) and nobody sees anyone else's pick on a game until it starts.
import { isThreeWay, LEAGUES, type Game, type LeagueKey } from '../src/espn';
import { easternDate, HttpError, isYMD, json, randomToken, readJson, sha256, str, weekStart, type Deps, type Env } from './util';

const MAX_MEMBERS = 50;
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O or 1/I
export const PICKEM_LEAGUES = (Object.keys(LEAGUES) as LeagueKey[]).filter((k) => LEAGUES[k].kind !== 'field');

interface PoolRow {
  id: number;
  code: string;
  name: string;
  league: string;
  created_at: number;
}
interface MemberRow {
  id: number;
  pool_id: number;
  name: string;
}
interface EntryRow {
  member_id: number;
  event_id: string;
  date: string;
  side: string;
  label: string;
  matchup: string;
  start_at: number;
  result: string | null;
}

function cleanName(v: unknown) {
  const name = str(v, 20).replace(/\s+/g, ' ');
  if (name.length < 1) throw new HttpError(400, 'Enter a name for the leaderboard.');
  return name;
}

function newCode() {
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  return [...bytes].map((b) => CODE_CHARS[b % CODE_CHARS.length]).join('');
}

const cleanCode = (v: unknown) => str(v, 12).toUpperCase().replace(/[^A-Z0-9]/g, '');

async function addMember(env: Env, poolId: number, name: string, now: number) {
  const count = await env.DB.prepare('SELECT COUNT(*) AS n FROM members WHERE pool_id = ?').bind(poolId).first<{ n: number }>();
  if ((count?.n ?? 0) >= MAX_MEMBERS) throw new HttpError(409, `This pool is full (${MAX_MEMBERS} players).`);
  const token = randomToken();
  try {
    await env.DB.prepare('INSERT INTO members (pool_id, name, token_hash, joined_at) VALUES (?, ?, ?, ?)')
      .bind(poolId, name, await sha256(token), now)
      .run();
  } catch {
    throw new HttpError(409, 'Someone in this pool already has that name. Pick another.');
  }
  return token;
}

/** POST /api/pools {name, league, player} */
export async function createPool(request: Request, env: Env, deps: Deps) {
  const b = await readJson(request);
  const name = str(b.name, 40) || 'Birdman Pick’em';
  const league = str(b.league, 20) as LeagueKey;
  if (!PICKEM_LEAGUES.includes(league)) throw new HttpError(400, 'Pick a league for the pool.');
  const player = cleanName(b.player);
  const now = deps.now();
  let pool: PoolRow | null = null;
  for (let i = 0; i < 5 && !pool; i++) {
    const code = newCode();
    try {
      await env.DB.prepare('INSERT INTO pools (code, name, league, created_at) VALUES (?, ?, ?, ?)').bind(code, name, league, now).run();
      pool = await env.DB.prepare('SELECT * FROM pools WHERE code = ?').bind(code).first<PoolRow>();
    } catch {
      /* code taken; try another */
    }
  }
  if (!pool) throw new HttpError(500, "Couldn't make a pool code. Try again.");
  const token = await addMember(env, pool.id, player, now);
  return json({ code: pool.code, token }, 201);
}

/** POST /api/pools/join {code, player} */
export async function joinPool(request: Request, env: Env, deps: Deps) {
  const b = await readJson(request);
  const code = cleanCode(b.code);
  const pool = code ? await env.DB.prepare('SELECT * FROM pools WHERE code = ?').bind(code).first<PoolRow>() : null;
  if (!pool) throw new HttpError(404, 'No pool with that code.');
  const token = await addMember(env, pool.id, cleanName(b.player), deps.now());
  return json({ code: pool.code, token }, 201);
}

async function memberFor(request: Request, env: Env, code: string) {
  const token = request.headers.get('X-Pool-Token') || '';
  if (!token) throw new HttpError(401, 'Join the pool first.');
  const m = await env.DB.prepare(
    'SELECT m.id, m.pool_id, m.name, p.code, p.name AS pool_name, p.league FROM members m JOIN pools p ON p.id = m.pool_id WHERE m.token_hash = ? AND p.code = ?'
  )
    .bind(await sha256(token), code)
    .first<MemberRow & { code: string; pool_name: string; league: string }>();
  if (!m) throw new HttpError(401, "You're not in this pool on this device.");
  return m;
}

/** GET /api/pools/:code?date=YYYY-MM-DD */
export async function getPool(request: Request, env: Env, deps: Deps, code: string) {
  const me = await memberFor(request, env, code);
  const now = deps.now();
  const url = new URL(request.url);
  const date = isYMD(url.searchParams.get('date') ?? '') ? url.searchParams.get('date')! : easternDate(now);
  const week = weekStart(easternDate(now));

  const { results: members } = await env.DB.prepare('SELECT id, name FROM members WHERE pool_id = ? ORDER BY joined_at').bind(me.pool_id).all<{ id: number; name: string }>();
  const { results: tallies } = await env.DB.prepare(
    `SELECT member_id,
            SUM(CASE WHEN result = 'right' THEN 1 ELSE 0 END) AS right_all,
            SUM(CASE WHEN result = 'wrong' THEN 1 ELSE 0 END) AS wrong_all,
            SUM(CASE WHEN result = 'right' AND date >= ? THEN 1 ELSE 0 END) AS right_week,
            SUM(CASE WHEN result = 'wrong' AND date >= ? THEN 1 ELSE 0 END) AS wrong_week
     FROM entries WHERE pool_id = ? GROUP BY member_id`
  )
    .bind(week, week, me.pool_id)
    .all<{ member_id: number; right_all: number; wrong_all: number; right_week: number; wrong_week: number }>();
  const byMember = new Map(tallies.map((t) => [t.member_id, t]));
  const standings = members.map((m) => {
    const t = byMember.get(m.id);
    return {
      name: m.name,
      me: m.id === me.id,
      week: { right: t?.right_week ?? 0, wrong: t?.wrong_week ?? 0 },
      all: { right: t?.right_all ?? 0, wrong: t?.wrong_all ?? 0 },
    };
  });

  // This day's picks: all of mine, and everyone's on games that have started.
  const { results: entries } = await env.DB.prepare(
    'SELECT e.*, m.name FROM entries e JOIN members m ON m.id = e.member_id WHERE e.pool_id = ? AND e.date = ?'
  )
    .bind(me.pool_id, date)
    .all<EntryRow & { name: string }>();
  const mine: Record<string, { side: string; result: string | null }> = {};
  const others: Record<string, { name: string; side: string; label: string; result: string | null }[]> = {};
  for (const e of entries) {
    if (e.member_id === me.id) mine[e.event_id] = { side: e.side, result: e.result };
    if (e.start_at <= now) (others[e.event_id] ??= []).push({ name: e.name, side: e.side, label: e.label, result: e.result });
  }

  return json({
    pool: { code: me.code, name: me.pool_name, league: me.league },
    me: me.name,
    date,
    weekStart: week,
    standings,
    mine,
    revealed: others,
  });
}

/** PUT /api/pools/:code/picks {eventId, date, side} */
export async function savePoolPick(request: Request, env: Env, deps: Deps, code: string) {
  const me = await memberFor(request, env, code);
  const b = await readJson(request);
  const eventId = str(b.eventId, 30);
  const date = str(b.date, 10);
  const side = str(b.side, 10);
  const league = me.league as LeagueKey;
  if (!/^\d{1,30}$/.test(eventId) || !isYMD(date)) throw new HttpError(400, 'Pick a game.');
  const allowed = isThreeWay(league) ? ['home', 'away', 'draw'] : ['home', 'away'];
  if (!allowed.includes(side)) throw new HttpError(400, 'Pick a side.');

  const game = (await deps.games(league, date)).find((g) => g.id === eventId);
  if (!game) throw new HttpError(404, "Couldn't find that game.");
  const startAt = Date.parse(game.start);
  const now = deps.now();
  if (game.state !== 'pre' || !(startAt > now)) throw new HttpError(409, 'That game has started. Picks are locked.');

  const label = side === 'draw' ? 'Draw' : side === 'home' ? game.home.abbr : game.away.abbr;
  const matchup = LEAGUES[league].kind === 'versus' ? `${game.away.name} vs ${game.home.name}` : `${game.away.abbr} @ ${game.home.abbr}`;
  await env.DB.prepare(
    `INSERT INTO entries (member_id, pool_id, event_id, league, date, side, label, matchup, start_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (member_id, event_id) DO UPDATE SET side = excluded.side, label = excluded.label, start_at = excluded.start_at, updated_at = excluded.updated_at`
  )
    .bind(me.id, me.pool_id, eventId, league, date, side, label, matchup, startAt, now)
    .run();
  return json({ saved: true, eventId, side });
}

/** Which side won a finished game, or 'void' when there's no winner to pick (a non-soccer tie or no contest). */
export function winningSide(g: Game): 'home' | 'away' | 'draw' | 'void' | null {
  if (!g.completed) return null;
  if (g.home.winner) return 'home';
  if (g.away.winner) return 'away';
  const a = g.away.score;
  const h = g.home.score;
  if (a == null || h == null) return 'void';
  if (h > a) return 'home';
  if (a > h) return 'away';
  return isThreeWay(g.league) ? 'draw' : 'void';
}

/** Every few minutes: mark picks right or wrong on finished games. */
export async function settlePools(env: Env, deps: Deps) {
  const { results } = await env.DB.prepare(
    'SELECT DISTINCT league, date, event_id FROM entries WHERE result IS NULL AND start_at <= ? LIMIT 500'
  )
    .bind(deps.now())
    .all<{ league: string; date: string; event_id: string }>();
  const boards = new Map<string, Promise<Game[]>>();
  const stmts = [];
  for (const r of results) {
    const k = `${r.league}|${r.date}`;
    if (!boards.has(k)) boards.set(k, deps.games(r.league as LeagueKey, r.date).catch(() => [] as Game[]));
    const g = (await boards.get(k)!).find((x) => x.id === r.event_id);
    const win = g && winningSide(g);
    if (!win) continue;
    stmts.push(
      win === 'void'
        ? env.DB.prepare("UPDATE entries SET result = 'void' WHERE event_id = ? AND result IS NULL").bind(r.event_id)
        : env.DB.prepare("UPDATE entries SET result = CASE WHEN side = ? THEN 'right' ELSE 'wrong' END WHERE event_id = ? AND result IS NULL").bind(
            win, r.event_id)
    );
  }
  if (stmts.length) await env.DB.batch(stmts);
  return { graded: stmts.length };
}
