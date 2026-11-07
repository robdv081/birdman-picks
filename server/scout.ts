import type { ResearchMarket, ScoutCandidate, ScoutReport } from '../src/scout';
import { requirePro } from './pro';
import { bearer, easternDate, HttpError, json, readJson, timingSafeEqual, type Env, type Deps } from './util';

const SPORTS = ['nfl', 'cfb', 'nba', 'nhl', 'mlb'] as const;
const FRESH_MS = 30 * 60_000;
const LEAD_MS = 10 * 60_000;
export const breakEven = (odds: number) => odds < 0 ? -odds / (-odds + 100) : 100 / (odds + 100);
const https = (s: unknown) => {
  try { const u = new URL(String(s)); return u.protocol === 'https:' && !u.username && !u.password; } catch { return false; }
};
const official = (url: string, league: ResearchMarket['league']) => {
  try {
    const host = new URL(url).hostname;
    const domains = { nfl: ['nfl.com'], cfb: ['ncaa.com'], nba: ['nba.com'], nhl: ['nhl.com'], mlb: ['mlb.com'] }[league];
    return domains.some(d => host === d || host.endsWith('.' + d));
  } catch { return false; }
};

/** Scout v2 validates evidence and rechecks all five schedules; Analyst v1 selects only
 * independently estimated markets. Neither stage calls an LLM or executes wagers. */
export async function research(env: Env, deps: Deps, markets: unknown[]): Promise<ScoutReport> {
  const now = deps.now(), date = easternDate(now);
  // Only download the schedules this research needs. Full ESPN scoreboards are large, and the free Worker plan
  // allows very little CPU per request, so an empty report fetches nothing at all.
  const needed = SPORTS.filter(l => markets.some(m => (m as ResearchMarket | null)?.league === l));
  const boards = await Promise.all(needed.map(async league => {
    try { return { league, games: await deps.games(league, date), stale: false }; }
    catch { return { league, games: [], stale: true }; }
  }));
  const candidates: ScoutCandidate[] = [], passes: ScoutReport['passes'] = [];
  for (const input of markets) {
    const m = input as ResearchMarket;
    const pass = (reason: string) => passes.push({ eventId: typeof m?.eventId === 'string' ? m.eventId : 'unknown', reason });
    if (!m || !SPORTS.includes(m.league) || typeof m.eventId !== 'string') { pass('Invalid market identity.'); continue; }
    const board = boards.find(b => b.league === m.league)!;
    const game = board.games.find(g => g.id === m.eventId);
    if (board.stale || !game) { pass('Official schedule unavailable or event absent.'); continue; }
    const start = Date.parse(game.start);
    if (game.state !== 'pre' || game.completed || !Number.isFinite(start) || start - now < LEAD_MS || start !== Date.parse(m.start)) {
      pass('Started, within ten minutes of start, or conflicting event time.'); continue;
    }
    if (typeof m.market !== 'string' || !m.market.trim() || m.market.length > 250 || !Number.isInteger(m.odds) || Math.abs(m.odds) < 100 || Math.abs(m.odds) > 10000 || typeof m.bookmaker !== 'string' || !m.bookmaker.trim()) {
      pass('Exact market, American price or bookmaker missing.'); continue;
    }
    const evidence = m.evidence;
    if (!Array.isArray(evidence) || evidence.length > 10 || !evidence.length || evidence.some(e =>
      !e || !https(e.url) || typeof e.note !== 'string' || !e.note.trim() ||
      !Number.isFinite(Date.parse(e.checkedAt)) || Date.parse(e.checkedAt) > now || now - Date.parse(e.checkedAt) > FRESH_MS
    ) || !evidence.some(e => e.kind === 'official' && official(e.url, m.league)) || !evidence.some(e => e.kind === 'bookmaker')) {
      pass('Fresh official and bookmaker evidence required (30 minute limit).'); continue;
    }
    if (m.availabilityConfirmed !== true || typeof m.counterarguments !== 'string' || !m.counterarguments.trim() || typeof m.passIf !== 'string' || !m.passIf.trim()) {
      pass('Availability, counterarguments or pass conditions incomplete.'); continue;
    }
    const est = m.estimate;
    if (!est || !Number.isFinite(est.probability) || est.probability <= 0 || est.probability >= 1 ||
      typeof est.method !== 'string' || est.method.trim().length < 30 || typeof est.validation !== 'string' || est.validation.trim().length < 30 || !https(est.source)) {
      pass('Documented independent estimate and validation required; bookmaker price is not an estimate.'); continue;
    }
    const be = breakEven(m.odds), edge = est.probability - be;
    if (edge < 0.03 || edge > 0.15) { pass('Estimated gap outside conservative 3–15 percentage point review range.'); continue; }
    candidates.push({ league: m.league, eventId: m.eventId, start: game.start, market: m.market, odds: m.odds,
      bookmaker: m.bookmaker, evidence, availabilityConfirmed: true, counterarguments: m.counterarguments,
      passIf: m.passIf, estimate: est, event: `${game.away.name} at ${game.home.name}`, breakEven: be, edge, units: 1 });
  }
  const selected: ScoutCandidate[] = [], events = new Set<string>();
  for (const c of candidates.sort((a,b) => b.edge - a.edge)) {
    const key = `${c.league}:${c.eventId}`;
    if (selected.length === 3 || events.has(key)) { passes.push({eventId:c.eventId, reason:'Three-candidate limit or duplicate event.'}); continue; }
    events.add(key); selected.push(c);
  }
  return { id: crypto.randomUUID(), checkedAt: new Date(now).toISOString(), date,
    agents: { scout: 'Scout v2 • evidence validation', analyst: 'Birdman Analyst v1 • independent-estimate filter' },
    feeds: boards.map(b => ({ league: b.league, checkedAt: new Date(now).toISOString(), stale: b.stale, events: b.games.length })),
    candidates: selected, passes, status: selected.length ? 'paper_candidates' : 'no_verified_picks' };
}
async function persist(env: Env, report: ScoutReport) {
  await env.DB.prepare('INSERT INTO scout_reports (id, created_at, report) VALUES (?, ?, ?)')
    .bind(report.id, Date.parse(report.checkedAt), JSON.stringify(report)).run();
}
export async function publishResearch(request: Request, env: Env, deps: Deps) {
  const key = bearer(request);
  if (!env.SCOUT_PUBLISH_KEY || !key || !timingSafeEqual(key, env.SCOUT_PUBLISH_KEY)) throw new HttpError(401, 'Scout publisher key required.');
  const body = await readJson(request);
  if (!Array.isArray(body.markets) || body.markets.length > 10) throw new HttpError(400, 'Supply zero to ten researched markets.');
  const report = await research(env, deps, body.markets);
  await persist(env, report);
  return json({ published: true, report }, 201);
}
export async function getResearch(request: Request, env: Env, deps: Deps) {
  await requirePro(request, env);
  const row = await env.DB.prepare('SELECT report FROM scout_reports ORDER BY created_at DESC, rowid DESC LIMIT 1').first<{report:string}>();
  if (!row) return json({ report: null });
  const report: ScoutReport = JSON.parse(row.report);
  const expired = deps.now() - Date.parse(report.checkedAt) > FRESH_MS || report.date !== easternDate(deps.now());
  // Old reports stay immutable in the database. Never display expired or started picks as actionable.
  report.candidates = expired ? [] : (await research(env, deps, report.candidates)).candidates;
  report.status = report.candidates.length ? 'paper_candidates' : 'no_verified_picks';
  return json({ report, expired });
}
/** Records a schedule-only "no picks" report when none is fresh. Not run by the cron: it would add a row every
 * 30 minutes with nothing in it, and the cron's CPU budget is kept for grading the public record. */
export async function refreshResearch(env: Env, deps: Deps) {
  const row = await env.DB.prepare('SELECT created_at FROM scout_reports ORDER BY created_at DESC LIMIT 1').first<{created_at:number}>();
  if (row && deps.now() - row.created_at < FRESH_MS) return;
  await persist(env, await research(env, deps, []));
}

/** Public: whether a research publisher is connected, so the app knows whether to show the Scout tab. */
export const scoutEnabled = (env: Env) => json({ enabled: !!env.SCOUT_PUBLISH_KEY }, 200, { 'Cache-Control': 'public, max-age=300' });
