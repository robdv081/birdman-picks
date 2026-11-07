// Birdman Scout + Analyst publisher. Runs on GitHub every 30 minutes (.github/workflows/scout.yml).
//
// Scout:   today's schedules, injury reports and DraftKings prices (with line movement) from ESPN.
// Analyst: the pick agent's model, at most 3 paper picks, each with its sources, the price it needs, the reasons it
//          could lose and when to pass. No pick clears the bar, or the evidence is missing: "No verified picks".
// Alerts:  current prices for pending picks on the public record, so Pro members following a pick hear when it moves.
//
//   node scripts/run-scout.mjs          publish (needs SERVER_URL and SCOUT_PUBLISH_KEY)
//   node scripts/run-scout.mjs --dry    print the report, send nothing
import { fetchInjuries, fetchScoreboard, LEAGUES, type Game, type Injury, type LeagueKey } from '../src/espn';
import { scanProps, candidateLabel, type Candidate } from '../src/propgen';
import { MODEL_NAME, scanGameLines } from '../src/gamelines';
import { fmtAmerican, fmtLine } from '../src/bets';
import { breakEven, type AnalystPick, type Evidence, type GameResearch, type ScoutFeed, type ScoutLeague, type ScoutSubmission } from '../src/scout';

const PROP_LEAGUES: ScoutLeague[] = ['nba', 'nhl', 'nfl'];
const LINE_LEAGUES: ScoutLeague[] = ['cfb', 'mcbb'];
const LEAGUE_ORDER: ScoutLeague[] = ['nfl', 'nba', 'nhl', 'cfb', 'mcbb'];
/** ESPN publishes league-wide injury reports for these. */
const INJURY_LEAGUES: ScoutLeague[] = ['nfl', 'nba', 'nhl'];
const MAX_PICKS = 3;
const MIN_EDGE = 0.04;
const MAX_EDGE = 0.15; // bigger gaps are almost always a short hot streak, not a mispriced line
const ODDS_RANGE = [-200, 180];
const MIN_LEAD_MS = 30 * 60_000;
const MAX_LEAD_MS = 14 * 3600_000;
const MAX_GAMES = 60;

const WEB: Record<ScoutLeague, string> = { nfl: 'nfl', cfb: 'college-football', nba: 'nba', nhl: 'nhl', mcbb: 'mens-college-basketball' };

const dry = process.argv.includes('--dry');
const SERVER = (process.env.SERVER_URL ?? '').replace(/\/+$/, '');
const KEY = process.env.SCOUT_PUBLISH_KEY ?? '';

const pct = (p: number) => `${(p * 100).toFixed(1)}%`;
const et = (iso: string | number) =>
  new Date(iso).toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit' }) + ' ET';
const easternDate = (ms: number) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms));

const gameUrl = (g: Game) =>
  g.link && /^https:\/\/www\.espn\.com\//.test(g.link) ? g.link : `https://www.espn.com/${WEB[g.league as ScoutLeague]}/game/_/gameId/${g.id}`;
const injuryUrl = (lg: ScoutLeague) => `https://www.espn.com/${WEB[lg]}/injuries`;
const gamelogUrl = (lg: ScoutLeague, athleteId: string) => `https://www.espn.com/${WEB[lg]}/player/gamelog/_/id/${athleteId}`;

/** The most a bettor could pay and still keep a 3-point edge, as an American price. */
function worstPrice(est: number) {
  const p = Math.max(0.05, Math.min(0.95, est - 0.03));
  const raw = p >= 0.5 ? (-100 * p) / (1 - p) : (100 * (1 - p)) / p;
  return raw < 0 ? -Math.floor(-raw / 5) * 5 : Math.floor(raw / 5) * 5;
}

function oddsLine(g: Game) {
  const o = g.odds;
  if (!o) return undefined;
  const bits: string[] = [];
  if (o.awayML != null && o.homeML != null) bits.push(`${g.away.abbr} ${fmtAmerican(o.awayML)} / ${g.home.abbr} ${fmtAmerican(o.homeML)}`);
  if (o.homeSpread?.line != null) bits.push(`${g.home.abbr} ${fmtLine(o.homeSpread.line)}`);
  if (o.over?.line != null) bits.push(`O/U ${o.over.line}`);
  return bits.length ? `${o.provider || 'DraftKings'}: ${bits.join(' · ')}` : undefined;
}

function movement(g: Game) {
  const o = g.odds;
  if (!o?.open) return undefined;
  const bits: string[] = [];
  const hs = o.homeSpread?.line;
  if (o.open.homeSpread != null && hs != null && Math.abs(o.open.homeSpread - hs) >= 0.5)
    bits.push(`${g.home.abbr} spread opened ${fmtLine(o.open.homeSpread)}, now ${fmtLine(hs)}`);
  const t = o.over?.line;
  if (o.open.total != null && t != null && Math.abs(o.open.total - t) >= 0.5) bits.push(`total opened ${o.open.total}, now ${t}`);
  return bits.length ? bits.join('; ') : undefined;
}

interface LeagueData {
  league: ScoutLeague;
  games: Game[];
  injuries: Record<string, Injury[]> | null;
  checkedAt: string;
  ok: boolean;
}

async function gather(league: ScoutLeague, date: string): Promise<LeagueData> {
  const checkedAt = new Date().toISOString();
  let games: Game[] = [];
  let ok = true;
  try {
    games = await fetchScoreboard(league as LeagueKey, date);
  } catch (e) {
    ok = false;
    console.log(`${league} schedule failed: ${(e as Error).message}`);
  }
  let injuries: Record<string, Injury[]> | null = null;
  if (ok && INJURY_LEAGUES.includes(league) && games.some((g) => g.state === 'pre')) {
    injuries = await fetchInjuries(league as LeagueKey).catch((e) => (console.log(`${league} injuries failed: ${e.message}`), null));
  }
  return { league, games, injuries, checkedAt, ok };
}

function gameInjuries(d: LeagueData, g: Game) {
  if (!d.injuries) return [];
  const rank = (i: Injury) => (i.severity === 'out' ? 0 : 1);
  return [g.away, g.home].flatMap((t) =>
    [...(d.injuries![t.id] ?? [])]
      .sort((a, b) => rank(a) - rank(b))
      .slice(0, 5)
      .map((i) => ({ team: t.abbr, player: i.player, status: i.status }))
  );
}

function research(d: LeagueData, g: Game): GameResearch {
  return {
    league: d.league,
    eventId: g.id,
    start: g.start,
    matchup: `${g.away.abbr} @ ${g.home.abbr}`,
    url: gameUrl(g),
    odds: oddsLine(g),
    moved: movement(g),
    injuries: gameInjuries(d, g),
  };
}

/** The line moved against the side we like, since it opened. */
function movedAgainst(c: Candidate): string | null {
  const o = c.game.odds?.open;
  const cur = c.game.odds;
  if (!o || !cur || c.kind !== 'line') return null;
  if (c.stat === 'spread' && o.homeSpread != null && cur.homeSpread?.line != null) {
    const delta = cur.homeSpread.line - o.homeSpread; // positive: home got more points (market moved toward away)
    const against = c.side === 'home' ? delta > 0 : delta < 0;
    if (Math.abs(delta) >= 0.5 && against)
      return `The spread has moved against this side since it opened (${c.game.home.abbr} ${fmtLine(o.homeSpread)} → ${fmtLine(cur.homeSpread.line)}).`;
  }
  if (c.stat === 'ml') {
    const open = c.side === 'home' ? o.homeML : o.awayML;
    if (open != null && breakEven(c.odds) < breakEven(open) - 0.02)
      return `The market has drifted away from this side since it opened (${fmtAmerican(open)} → ${fmtAmerican(c.odds)}).`;
  }
  return null;
}

function analystPick(d: LeagueData, c: Candidate, onRecord: boolean): AnalystPick {
  const g = c.game;
  const at = d.checkedAt;
  const lg = d.league;
  const evidence: Evidence[] = [
    { kind: 'schedule', url: gameUrl(g), checkedAt: at, note: `ESPN game page: ${g.away.name} at ${g.home.name}, ${et(g.start)}` },
    {
      kind: 'odds',
      url: g.odds?.links?.event ?? gameUrl(g),
      checkedAt: at,
      note: `DraftKings price ${fmtAmerican(c.odds)} (needs ${pct(breakEven(c.odds))} to break even)`,
    },
  ];
  const counter: string[] = [];
  const passIf: string[] = [`Pass if the price is worse than ${fmtAmerican(worstPrice(c.est))}: past that, the edge is under 3 points.`];
  let method: string;
  let availability: string;

  if (c.kind === 'line') {
    const model = MODEL_NAME[c.league] ?? 'ESPN';
    method = `ESPN ${model} projection (${c.detail}) blended with DraftKings' price; the model gets half the say, less on big spreads.`;
    evidence.push({ kind: 'stats', url: gameUrl(g), checkedAt: at, note: `ESPN ${model} matchup predictor: ${c.detail}` });
    availability = d.injuries
      ? 'Checked against ESPN’s injury report.'
      : 'College injury reports aren’t published on ESPN. Check team news before the game.';
    counter.push(`DraftKings makes this ${pct(c.implied)}; the model's ${pct(c.est)} leans on ESPN's power ratings, which miss late news.`);
    if (c.stat === 'spread' && Math.abs(c.target) >= 10) counter.push('Big spreads: power ratings tend to undersell blowouts the market prices in.');
    const against = movedAgainst(c);
    if (against) counter.push(against);
    if (c.stat === 'spread') {
      const worse = c.target - 1;
      passIf.push(`Pass if the line moves to ${fmtLine(worse)} or worse.`);
    }
  } else {
    method = `${c.player} reached ${c.target}+ ${c.label} in ${c.hits} of his last ${c.n} games; that hit rate is blended with DraftKings' price, counted as 10 games of evidence.`;
    evidence.push({
      kind: 'stats',
      url: gamelogUrl(lg, c.athleteId),
      checkedAt: at,
      note: `${c.player}: ${c.hits}/${c.n} games at ${c.target}+ ${c.label}, averaging ${c.avg.toFixed(1)}`,
    });
    if (d.injuries) {
      evidence.push({ kind: 'injuries', url: injuryUrl(lg), checkedAt: at, note: `ESPN injury report: ${c.player} not listed` });
      availability = `${c.player} isn't on ESPN's injury report as of ${et(at)}.`;
    } else availability = `ESPN's injury report couldn't be checked; confirm ${c.player} is playing.`;
    counter.push(`Only ${c.n} games of evidence; DraftKings prices in matchup, minutes and rest that a game log can't see.`);
    if (c.avg < c.target + 0.5) counter.push(`His average (${c.avg.toFixed(1)}) sits right at the line, so one quiet night loses it.`);
    passIf.push(`Pass if ${c.player} is listed questionable or out, or his role changes.`);
  }
  counter.push('A model edge is an estimate, not a guarantee; a pick like this still loses often.');
  passIf.push(`Pass after ${et(Date.parse(g.start) - 10 * 60_000)}: picks close 10 minutes before the start.`);

  return {
    league: lg,
    eventId: g.id,
    start: g.start,
    event: `${g.away.name} at ${g.home.name}`,
    market: candidateLabel(c),
    odds: c.odds,
    bookmaker: 'DraftKings',
    breakEven: breakEven(c.odds),
    probability: c.est,
    edge: c.est - breakEven(c.odds),
    method,
    availability,
    evidence,
    counterarguments: counter,
    passIf,
    onRecord,
  };
}

interface RecordPick {
  id: string;
  eventId: string;
  date: string;
  market: string;
  side: string;
  line: number | null;
  player: string | null;
  stat: string | null;
  startAt: number;
  status: string;
  selection: string;
}

/** Current DraftKings price for a pending record pick, if Scout saw one. */
function currentPrice(p: RecordPick, games: Map<string, Game>, cands: Candidate[]): { odds: number; line: number | null } | null {
  if (p.market === 'prop') {
    const c = cands.find((x) => x.kind !== 'line' && x.game.id === p.eventId && x.player === p.player && x.stat === p.stat && p.line != null && x.target === p.line + 0.5);
    return c ? { odds: c.odds, line: p.line } : null;
  }
  const o = games.get(p.eventId)?.odds;
  if (!o) return null;
  if (p.market === 'ml') {
    const odds = p.side === 'home' ? o.homeML : p.side === 'away' ? o.awayML : o.draw;
    return odds != null ? { odds, line: null } : null;
  }
  const price = p.market === 'spread' ? (p.side === 'home' ? o.homeSpread : o.awaySpread) : p.side === 'over' ? o.over : o.under;
  return price?.line != null && price.odds != null ? { odds: price.odds, line: price.line } : null;
}

async function post(path: string, body: unknown) {
  const res = await fetch(`${SERVER}${path}`, {
    method: 'POST',
    redirect: 'error',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${KEY}` },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${path} returned ${res.status}: ${(data as { error?: string }).error ?? ''}`);
  return data;
}

async function main() {
  if (!dry && (!SERVER || !KEY)) {
    console.log('SERVER_URL or SCOUT_PUBLISH_KEY is missing; nothing to do.');
    return;
  }
  const started = Date.now();
  const today = easternDate(started);

  // Today's public record: which games the pick agent already took, and pending picks to price for alerts.
  let record: RecordPick[] = [];
  if (SERVER) {
    const res = await fetch(`${SERVER}/api/record`);
    if (res.ok) record = ((await res.json()) as { picks: RecordPick[] }).picks;
  }

  const data = await Promise.all(LEAGUE_ORDER.map((lg) => gather(lg, today)));
  const quiet = () => {};
  const cands: { d: LeagueData; c: Candidate }[] = [];
  for (const d of data) {
    const pre = d.games.filter((g) => g.state === 'pre');
    if (!pre.length) continue;
    const scan = PROP_LEAGUES.includes(d.league) ? scanProps : LINE_LEAGUES.includes(d.league) ? scanGameLines : null;
    if (!scan) continue;
    const found = await scan(d.league as LeagueKey, pre, today, quiet).catch((e) => (console.log(`${d.league} model failed: ${e.message}`), []));
    cands.push(...found.map((c) => ({ d, c })));
  }

  // ---- Analyst: the strongest few, one per game, with the same guard rails as the pick agent ----
  const now = Date.now();
  const passes: ScoutSubmission['passes'] = [];
  const picks: AnalystPick[] = [];
  const used = new Set<string>();
  const ranked = [...cands].sort((a, b) => b.c.edge - a.c.edge);
  for (const { d, c } of ranked) {
    if (picks.length >= MAX_PICKS || c.edge < MIN_EDGE) break;
    const label = `${candidateLabel(c)} ${fmtAmerican(c.odds)}`;
    const lead = Date.parse(c.game.start) - now;
    const skip = (reason: string) => passes.length < 12 && passes.push({ event: label, reason });
    if (used.has(c.game.id)) continue;
    if (lead < MIN_LEAD_MS || lead > MAX_LEAD_MS) continue;
    if (c.edge > MAX_EDGE) {
      skip(`Model gap of ${(c.edge * 100).toFixed(0)} points is too big to trust; usually a short hot streak.`);
      continue;
    }
    if (c.odds < ODDS_RANGE[0] || c.odds > ODDS_RANGE[1]) {
      skip(`Price ${fmtAmerican(c.odds)} is outside the -200 to +180 range Analyst works in.`);
      continue;
    }
    if (c.gtd) {
      skip(`${c.player} is questionable on ESPN's injury report.`);
      continue;
    }
    if (c.kind !== 'line' && !d.injuries) {
      skip(`ESPN's ${LEAGUES[d.league as LeagueKey].label} injury report couldn't be checked.`);
      continue;
    }
    used.add(c.game.id);
    const onRecord = record.some((p) => p.date === today && p.eventId === c.game.id);
    picks.push(analystPick(d, c, onRecord));
  }

  const feeds: ScoutFeed[] = data.map((d) => ({
    league: d.league,
    checkedAt: d.checkedAt,
    ok: d.ok,
    events: d.games.length,
    injuries: !!d.injuries,
  }));
  const games = data
    .flatMap((d) => d.games.filter((g) => g.state === 'pre' && g.odds).map((g) => research(d, g)))
    .sort((a, b) => Date.parse(a.start) - Date.parse(b.start))
    .slice(0, MAX_GAMES);
  if (!data.some((d) => d.ok)) passes.push({ event: 'All leagues', reason: "ESPN's schedules couldn't be reached." });

  const report: ScoutSubmission = {
    checkedAt: new Date(Math.min(...data.map((d) => Date.parse(d.checkedAt)))).toISOString(),
    feeds,
    games,
    candidates: picks,
    passes,
  };
  console.log(
    `${today}: ${games.length} games researched, ${cands.length} markets scanned, ${picks.length} Analyst pick(s). ` +
      feeds.map((f) => `${f.league}:${f.ok ? f.events : 'down'}${f.injuries ? '+inj' : ''}`).join(' ')
  );
  for (const p of picks) console.log(`  ${p.market} ${fmtAmerican(p.odds)} · model ${pct(p.probability)} vs ${pct(p.breakEven)}${p.onRecord ? ' · on record' : ''}`);
  for (const p of passes) console.log(`  passed: ${p.event} — ${p.reason}`);

  // ---- Line moves for pending record picks ----
  const gameById = new Map(data.flatMap((d) => d.games.map((g) => [g.id, g] as const)));
  const moves = record
    .filter((p) => p.status === 'pending' && p.startAt > now)
    .map((p) => ({ p, price: currentPrice(p, gameById, cands.map((x) => x.c)) }))
    .filter((x) => x.price)
    .map(({ p, price }) => ({ pickId: p.id, odds: price!.odds, line: price!.line }));

  if (dry) {
    console.log(`[dry run] would publish the report and ${moves.length} price update(s).`);
    console.log(JSON.stringify(report, null, 1).slice(0, 4000));
    return;
  }
  const out = (await post('/api/scout/research', report)) as { report: { status: string; candidates: number; passes: { event: string; reason: string }[] } };
  console.log(`Published: ${out.report.status}, ${out.report.candidates} pick(s).`);
  for (const p of out.report.passes.slice(passes.length)) console.log(`  server passed: ${p.event} — ${p.reason}`);
  if (moves.length) console.log(`Price updates sent: ${JSON.stringify(await post('/api/push/moves', { moves }))}`);
  console.log(`Done in ${((Date.now() - started) / 1000).toFixed(0)}s.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
