// Verified records for everyone, and the free weekly contest.
//
// Anyone can make a player name. Their picks go on their own record: checked against ESPN, refused once the game
// starts (by the server's clock), chained by hash like the Birdman record, and graded by the server along with
// the closing line. Every pick is also a contest entry: each week starts with 1,000 pretend points, and a pick
// stakes some of them. Leaderboards rank the week by points and all time by how often players beat the close.
import { GENESIS, pickHash } from '../src/recordhash';
import { profit } from '../src/bets';
import { publicPick, summarizeRecord, toBet, validatePick, type PickRow } from './record';
import { HttpError, b64url, json, readJson, sha256, str, timingSafeEqual, type Deps, type Env } from './util';

export const WEEK_START_POINTS = 1000;
export const MIN_STAKE = 10;
export const MAX_STAKE = 500;
const MAX_PICKS_PER_DAY = 20;
/** All-time board: only players with this many closing lines measured, so a hot week can't top it. */
export const MIN_CLV_PICKS = 10;
const RESERVED = new Set(['birdman', 'birdmanpicks', 'admin', 'owner', 'model', 'scout', 'analyst', 'pro', 'me']);

type PlayerRow = { id: string; name: string; token_hash: string; created_at: number; brand_until: number };
type UserPickRow = PickRow & { player_id: string; week: string; clv_beat: number | null };

/** Monday of the contest week (Eastern), as YYYY-MM-DD. */
export function contestWeek(ms: number) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short' }).formatToParts(new Date(ms));
  const get = (t: string) => parts.find((p) => p.type === t)!.value;
  const back = { Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6 }[get('weekday') as 'Mon'] ?? 0;
  const d = new Date(Date.UTC(Number(get('year')), Number(get('month')) - 1, Number(get('day')) - back));
  return d.toISOString().slice(0, 10);
}

const nameKey = (n: string) => n.toLowerCase();

function cleanName(v: unknown) {
  const name = typeof v === 'string' ? v.trim() : '';
  if (!/^[A-Za-z0-9_]{3,20}$/.test(name)) throw new HttpError(400, 'Names are 3 to 20 letters, numbers or underscores.');
  if (RESERVED.has(nameKey(name))) throw new HttpError(400, 'That name is taken.');
  return name;
}

async function playerFrom(request: Request, env: Env) {
  const token = request.headers.get('X-Player-Token') || '';
  if (token.length < 20) throw new HttpError(401, 'Make a player name first.');
  const [id] = token.split('.');
  const row = await env.DB.prepare('SELECT * FROM players WHERE id = ?').bind(id).first<PlayerRow>();
  if (!row || !timingSafeEqual(row.token_hash, await sha256(token))) throw new HttpError(401, "This device's player sign-in doesn't match. Sign in again with your code.");
  return row;
}

/** POST /api/players {name} — make a player. The token is shown once; it's the only way to post as them. */
export async function createPlayer(request: Request, env: Env, deps: Deps) {
  const name = cleanName((await readJson(request)).name);
  const id = b64url(crypto.getRandomValues(new Uint8Array(9)));
  const token = `${id}.${b64url(crypto.getRandomValues(new Uint8Array(24)))}`;
  try {
    await env.DB.prepare('INSERT INTO players (id, name, name_key, token_hash, created_at) VALUES (?, ?, ?, ?, ?)')
      .bind(id, name, nameKey(name), await sha256(token), deps.now())
      .run();
  } catch {
    throw new HttpError(409, 'That name is taken.');
  }
  return json({ player: { id, name }, token }, 201);
}

/** Points left this week: 1,000, plus settled results this week, less what's riding on open picks. */
async function weekState(env: Env, playerId: string, week: string) {
  const { results } = await env.DB.prepare('SELECT * FROM user_picks WHERE player_id = ? AND week = ?').bind(playerId, week).all<UserPickRow>();
  let settled = 0;
  let open = 0;
  for (const r of results) {
    if (r.status === 'pending') open += r.units;
    else settled += profit(toBet(r));
  }
  const round = (n: number) => Math.round(n * 100) / 100;
  return { week, picks: results.length, points: round(WEEK_START_POINTS + settled), available: round(WEEK_START_POINTS + settled - open), open: round(open) };
}

/** POST /api/players/picks — a pick on your own record, and a contest entry. */
export async function postPlayerPick(request: Request, env: Env, deps: Deps) {
  const me = await playerFrom(request, env);
  const b = await readJson(request);
  const stake = Math.round(Number(b.stake));
  if (!Number.isFinite(stake) || stake < MIN_STAKE || stake > MAX_STAKE) throw new HttpError(400, `Stake ${MIN_STAKE} to ${MAX_STAKE} points.`);
  const reason = str(b.reason, 300);
  const core = await validatePick(b, deps);
  const now = deps.now();
  const week = contestWeek(now);
  const today = await env.DB.prepare('SELECT COUNT(*) AS n FROM user_picks WHERE player_id = ? AND created_at > ?').bind(me.id, now - 86400_000).first<{ n: number }>();
  if ((today?.n ?? 0) >= MAX_PICKS_PER_DAY) throw new HttpError(429, `Up to ${MAX_PICKS_PER_DAY} picks a day.`);
  const ws = await weekState(env, me.id, week);
  if (stake > ws.available) throw new HttpError(409, `You have ${Math.floor(ws.available)} points left this week.`);

  const last = await env.DB.prepare('SELECT seq, hash FROM user_picks WHERE player_id = ? ORDER BY seq DESC LIMIT 1').bind(me.id).first<{ seq: number; hash: string }>();
  const row = { seq: (last?.seq ?? 0) + 1, id: crypto.randomUUID(), created_at: now, ...core, units: stake, reason, author: me.id };
  const prev = last?.hash ?? GENESIS;
  const hash = await pickHash(prev, row);
  try {
    await env.DB.prepare(
      `INSERT INTO user_picks (player_id, seq, id, created_at, start_at, league, event_id, date, matchup, market, side, line, odds, selection, player, stat, units, reason, week, prev_hash, hash)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
      .bind(me.id, row.seq, row.id, now, row.start_at, row.league, row.event_id, row.date, row.matchup, row.market, row.side, row.line, row.odds,
        row.selection, row.player, row.stat, row.units, row.reason, week, prev, hash)
      .run();
  } catch {
    throw new HttpError(409, 'Another pick was posted at the same moment. Try again.');
  }
  const full: PickRow = { ...row, prev_hash: prev, hash, status: 'pending', final_score: null, margin: null, close_odds: null, close_line: null, close_checked: 0, graded_at: null };
  return json({ pick: { ...publicPick(full), author: me.name }, week: { ...ws, available: ws.available - stake, open: ws.open + stake } }, 201);
}

/** Public profile: record summary, this week's contest, recent picks (newest first). Used by the overlay too. */
export async function getPlayer(env: Env, deps: Deps, name: string) {
  const p = await env.DB.prepare('SELECT * FROM players WHERE name_key = ?').bind(nameKey(name)).first<PlayerRow>();
  if (!p) throw new HttpError(404, 'No player by that name.');
  const { results } = await env.DB.prepare('SELECT * FROM user_picks WHERE player_id = ? ORDER BY seq ASC').bind(p.id).all<UserPickRow>();
  const now = deps.now();
  const clvMeasured = results.filter((r) => r.clv_beat != null).length;
  return json(
    {
      player: { name: p.name, since: p.created_at, branded: !(p.brand_until > now) },
      summary: { ...summarizeRecord(results), clvMeasured, clvBeat: results.filter((r) => r.clv_beat === 1).length },
      week: await weekState(env, p.id, contestWeek(now)),
      picks: results.slice(-100).reverse().map((r) => ({ ...publicPick(r), author: p.name })),
      genesis: GENESIS,
    },
    200,
    { 'Cache-Control': 'public, max-age=15' }
  );
}

/** GET /api/players/me — who this device is signed in as. */
export async function me(request: Request, env: Env) {
  const p = await playerFrom(request, env);
  return json({ player: { id: p.id, name: p.name } });
}

const decimalSql = 'CASE WHEN odds > 0 THEN odds / 100.0 ELSE 100.0 / -odds END';

/** GET /api/leaderboard — this week's contest by points, and all time by how often players beat the close. */
export async function leaderboard(env: Env, deps: Deps) {
  const week = contestWeek(deps.now());
  const weekRows = await env.DB.prepare(
    `SELECT p.name AS name, COUNT(*) AS picks,
       SUM(CASE WHEN u.status = 'won' THEN 1 ELSE 0 END) AS won,
       SUM(CASE WHEN u.status = 'lost' THEN 1 ELSE 0 END) AS lost,
       ${WEEK_START_POINTS} + SUM(CASE WHEN u.status = 'won' THEN u.units * (${decimalSql}) WHEN u.status = 'lost' THEN -u.units ELSE 0 END) AS points
     FROM user_picks u JOIN players p ON p.id = u.player_id
     WHERE u.week = ? GROUP BY u.player_id ORDER BY points DESC, won DESC LIMIT 50`
  )
    .bind(week)
    .all<{ name: string; picks: number; won: number; lost: number; points: number }>();
  const allRows = await env.DB.prepare(
    `SELECT p.name AS name,
       SUM(CASE WHEN u.clv_beat IS NOT NULL THEN 1 ELSE 0 END) AS measured,
       SUM(CASE WHEN u.clv_beat = 1 THEN 1 ELSE 0 END) AS beat,
       SUM(CASE WHEN u.status = 'won' THEN 1 ELSE 0 END) AS won,
       SUM(CASE WHEN u.status = 'lost' THEN 1 ELSE 0 END) AS lost,
       SUM(CASE WHEN u.status IN ('won', 'lost') THEN u.units ELSE 0 END) AS staked,
       SUM(CASE WHEN u.status = 'won' THEN u.units * (${decimalSql}) WHEN u.status = 'lost' THEN -u.units ELSE 0 END) AS net
     FROM user_picks u JOIN players p ON p.id = u.player_id
     GROUP BY u.player_id HAVING measured >= ? ORDER BY beat * 1.0 / measured DESC, net DESC LIMIT 50`
  )
    .bind(MIN_CLV_PICKS)
    .all<{ name: string; measured: number; beat: number; won: number; lost: number; staked: number; net: number }>();
  const r2 = (n: number) => Math.round(n * 100) / 100;
  return json(
    {
      week,
      weekly: weekRows.results.map((r) => ({ ...r, points: r2(r.points) })),
      allTime: allRows.results.map((r) => ({ name: r.name, measured: r.measured, beatPct: r2(r.beat / r.measured), won: r.won, lost: r.lost, roi: r.staked ? r2(r.net / r.staked) : 0 })),
      minClvPicks: MIN_CLV_PICKS,
    },
    200,
    { 'Cache-Control': 'public, max-age=60' }
  );
}

/** Pro members: their stream overlay shows without Birdman branding while Pro lasts (the app renews this). */
export async function setBrand(request: Request, env: Env, deps: Deps, requirePro: (r: Request, e: Env) => Promise<{ renews: string | null }>) {
  const meRow = await playerFrom(request, env);
  const { renews } = await requirePro(request, env);
  const at = renews ? Date.parse(renews) : NaN;
  const until = Number.isFinite(at) ? at + 2 * 86400_000 : deps.now() + 35 * 86400_000;
  await env.DB.prepare('UPDATE players SET brand_until = ? WHERE id = ?').bind(until, meRow.id).run();
  return json({ branded: false, until });
}
