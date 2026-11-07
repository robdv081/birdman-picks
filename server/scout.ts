// Scout + Birdman Analyst on the server: accepts research from the Scout publisher (scripts/scout.ts, run on
// GitHub every 30 minutes), re-checks every paper pick, stores each report (append-only) and shows the latest
// one to Pro members. The server never downloads schedules here: the free Worker plan allows very little CPU per
// request, so the publisher does the heavy lifting and the server checks what it can check cheaply.
import {
  breakEven,
  citable,
  SCOUT_LEAGUES,
  type AnalystPick,
  type Evidence,
  type GameResearch,
  type ScoutFeed,
  type ScoutReport,
} from '../src/scout';
import { requirePro } from './pro';
import { bearer, easternDate, HttpError, json, readJson, timingSafeEqual, type Deps, type Env } from './util';

/** A report older than this is shown as out of date and its picks are hidden. The publisher runs every 30 minutes. */
export const REPORT_FRESH_MS = 75 * 60_000;
/** Evidence must have been checked within this long before the report was assembled. */
const EVIDENCE_FRESH_MS = 30 * 60_000;
/** Picks disappear this close to the start. */
const LEAD_MS = 10 * 60_000;
const MIN_EDGE = 0.03;
const MAX_EDGE = 0.15;
const MAX_PICKS = 3;

const AGENTS = {
  scout: 'Scout • ESPN schedules, injury reports and DraftKings prices',
  analyst: 'Birdman Analyst • the pick agent’s model, at most 3 paper picks',
};

const text = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const time = (v: unknown) => (typeof v === 'string' ? Date.parse(v) : NaN);
const isLeague = (v: unknown): v is (typeof SCOUT_LEAGUES)[number] => SCOUT_LEAGUES.includes(v as never);
const list = (v: unknown, max: number) => (Array.isArray(v) ? v.slice(0, max) : []);
type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : {});

function cleanGame(raw: unknown): GameResearch | null {
  const g = obj(raw);
  if (!isLeague(g.league) || !/^\d{1,20}$/.test(String(g.eventId)) || !Number.isFinite(time(g.start)) || !citable(String(g.url))) return null;
  return {
    league: g.league,
    eventId: String(g.eventId),
    start: new Date(time(g.start)).toISOString(),
    matchup: text(g.matchup, 80),
    url: String(g.url),
    odds: text(g.odds, 120) || undefined,
    moved: text(g.moved, 160) || undefined,
    injuries: list(g.injuries, 12)
      .map((x) => obj(x))
      .map((x) => ({ team: text(x.team, 8), player: text(x.player, 60), status: text(x.status, 30) }))
      .filter((x) => x.player && x.status),
  };
}

/** Re-checks one Analyst pick. Returns the cleaned pick, or the reason it was passed. */
function checkPick(raw: unknown, reportAt: number, now: number): AnalystPick | string {
  const p = obj(raw);
  if (!isLeague(p.league) || !/^\d{1,20}$/.test(String(p.eventId))) return 'Unknown league or game.';
  const start = time(p.start);
  if (!Number.isFinite(start) || start - now < LEAD_MS) return 'Started, or within ten minutes of the start.';
  const market = text(p.market, 120);
  const odds = Number(p.odds);
  if (!market || !Number.isInteger(odds) || Math.abs(odds) < 100 || Math.abs(odds) > 2000) return 'Exact market or American price missing.';
  const probability = Number(p.probability);
  if (!(probability > 0 && probability < 1)) return 'No model probability.';
  const be = breakEven(odds);
  const edge = probability - be;
  if (edge < MIN_EDGE || edge > MAX_EDGE) return 'Model edge outside the 3–15 point review range.';
  const evidence: Evidence[] = list(p.evidence, 10).map((e) => {
    const x = obj(e);
    return { url: String(x.url ?? ''), checkedAt: String(x.checkedAt ?? ''), kind: x.kind as Evidence['kind'], note: text(x.note, 200) };
  });
  const fresh = (e: Evidence) => {
    const t = time(e.checkedAt);
    return Number.isFinite(t) && t <= reportAt + 60_000 && reportAt - t <= EVIDENCE_FRESH_MS;
  };
  if (!evidence.length || evidence.some((e) => !citable(e.url) || !e.note || !fresh(e))) return 'Every source must be ESPN or DraftKings and checked in the last 30 minutes.';
  const has = (k: Evidence['kind']) => evidence.some((e) => e.kind === k);
  if (!has('schedule') || !has('odds') || !(has('injuries') || has('stats'))) return 'Needs the schedule, the price and an injury or stats check.';
  const availability = text(p.availability, 200);
  const counterarguments = list(p.counterarguments, 6).map((x) => text(x, 240)).filter(Boolean);
  const passIf = list(p.passIf, 6).map((x) => text(x, 200)).filter(Boolean);
  const method = text(p.method, 400);
  if (!availability || !counterarguments.length || !passIf.length || method.length < 20) return 'Availability, counterarguments, pass conditions or method missing.';
  return {
    league: p.league,
    eventId: String(p.eventId),
    start: new Date(start).toISOString(),
    event: text(p.event, 80),
    market,
    odds,
    bookmaker: text(p.bookmaker, 30) || 'DraftKings',
    breakEven: be,
    probability,
    edge,
    method,
    availability,
    evidence,
    counterarguments,
    passIf,
    onRecord: p.onRecord === true,
  };
}

/** Builds a report from a publisher submission. Bad picks become "passed" with a reason; they never block the rest. */
export function assemble(body: Obj, now: number): ScoutReport {
  const checkedAt = time(body.checkedAt);
  if (!Number.isFinite(checkedAt) || checkedAt > now + 2 * 60_000 || now - checkedAt > 20 * 60_000)
    throw new HttpError(400, 'checkedAt must be the time the research was gathered (within 20 minutes).');
  const feeds: ScoutFeed[] = list(body.feeds, SCOUT_LEAGUES.length)
    .map((f) => obj(f))
    .filter((f) => isLeague(f.league))
    .map((f) => ({
      league: f.league as ScoutFeed['league'],
      checkedAt: Number.isFinite(time(f.checkedAt)) ? new Date(time(f.checkedAt)).toISOString() : new Date(checkedAt).toISOString(),
      ok: f.ok === true,
      events: Math.max(0, Math.min(500, Number(f.events) || 0)),
      injuries: f.injuries === true,
    }));
  const games = list(body.games, 80).map(cleanGame).filter((g): g is GameResearch => !!g);
  const passes: ScoutReport['passes'] = list(body.passes, 40)
    .map((x) => obj(x))
    .map((x) => ({ event: text(x.event, 80), reason: text(x.reason, 200) }))
    .filter((x) => x.reason);
  const candidates: AnalystPick[] = [];
  const events = new Set<string>();
  for (const raw of list(body.candidates, 10)) {
    const r = checkPick(raw, checkedAt, now);
    const label = text(obj(raw).market, 80) || text(obj(raw).event, 80) || 'A pick';
    if (typeof r === 'string') passes.push({ event: label, reason: r });
    else if (candidates.length >= MAX_PICKS || events.has(`${r.league}:${r.eventId}`)) passes.push({ event: label, reason: 'Three-pick limit, or a second pick on the same game.' });
    else {
      events.add(`${r.league}:${r.eventId}`);
      candidates.push(r);
    }
  }
  return {
    id: crypto.randomUUID(),
    checkedAt: new Date(checkedAt).toISOString(),
    date: easternDate(checkedAt),
    agents: AGENTS,
    feeds,
    games,
    candidates,
    passes: passes.slice(0, 40),
    status: candidates.length ? 'paper_candidates' : 'no_verified_picks',
  };
}

export async function publishResearch(request: Request, env: Env, deps: Deps) {
  const key = bearer(request);
  if (!env.SCOUT_PUBLISH_KEY || !key || !timingSafeEqual(key, env.SCOUT_PUBLISH_KEY)) throw new HttpError(401, 'Scout publisher key required.');
  const report = assemble(await readJson(request, 200_000), deps.now());
  await env.DB.prepare('INSERT INTO scout_reports (id, created_at, report) VALUES (?, ?, ?)')
    .bind(report.id, Date.parse(report.checkedAt), JSON.stringify(report))
    .run();
  return json({ published: true, report: { id: report.id, status: report.status, candidates: report.candidates.length, games: report.games.length, passes: report.passes } }, 201);
}

/** Pro members: the latest report. Out-of-date reports keep their notes but show no picks. */
export async function getResearch(request: Request, env: Env, deps: Deps) {
  await requirePro(request, env);
  const row = await env.DB.prepare('SELECT report FROM scout_reports ORDER BY created_at DESC, rowid DESC LIMIT 1').first<{ report: string }>();
  if (!row) return json({ report: null, expired: false });
  const report: ScoutReport = JSON.parse(row.report);
  const now = deps.now();
  const expired = now - Date.parse(report.checkedAt) > REPORT_FRESH_MS || report.date !== easternDate(now);
  report.candidates = expired ? [] : report.candidates.filter((c) => Date.parse(c.start) - now >= LEAD_MS);
  report.games = report.games.filter((g) => Date.parse(g.start) > now - 4 * 3600_000);
  report.status = report.candidates.length ? 'paper_candidates' : 'no_verified_picks';
  return json({ report, expired });
}

/** Public: whether a research publisher is connected, so the app knows whether to show the Scout tab. */
export const scoutEnabled = (env: Env) => json({ enabled: !!env.SCOUT_PUBLISH_KEY }, 200, { 'Cache-Control': 'public, max-age=300' });
