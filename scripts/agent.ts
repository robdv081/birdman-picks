// The Birdman pick agent. Runs on a schedule (.github/workflows/agent.yml), scans today's games with the same
// model as "Best edges" on the Today tab, and posts the strongest few picks to the public record.
// The server still decides: it stamps the time, refuses anything after kickoff, and grades every pick.
//
//   node scripts/run-agent.mjs          post picks (needs SERVER_URL and AGENT_KEY)
//   node scripts/run-agent.mjs --dry    show what it would post, post nothing
import { fetchScoreboard, LEAGUES, type Game, type LeagueKey } from '../src/espn';
import { scanProps, toLeg, candidateLabel, type Candidate } from '../src/propgen';
import { LINE_LEAGUES, scanGameLines } from '../src/gamelines';
import { fmtAmerican, kellyUnits } from '../src/bets';

const MAX_PER_DAY = 3;
const PROP_LEAGUES: LeagueKey[] = ['nba', 'nhl', 'nfl'];
const MIN_EDGE = { prop: 0.05, line: 0.04 }; // win-probability points over the book's price
// Bigger gaps than this are almost always a short hot streak, not a mispriced line, so they're skipped.
const MAX_EDGE = 0.15;
const ODDS_RANGE = [-200, 180]; // no heavy favorites, no long shots
const MIN_LEAD_MS = 30 * 60_000; // leave time before kickoff
const MAX_LEAD_MS = 12 * 3600_000; // only today's slate

const dry = process.argv.includes('--dry');
const SERVER = (process.env.SERVER_URL ?? '').replace(/\/+$/, '');
const KEY = process.env.AGENT_KEY ?? '';

const pct = (p: number) => `${Math.round(p * 100)}%`;
const easternDate = (ms: number) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms));

/** The "Why the model likes it" note, in plain words from the numbers behind the pick. */
export function reasonFor(c: Candidate) {
  const price = `DraftKings' ${fmtAmerican(c.odds)} implies ${pct(c.implied)}; the model makes it ${pct(c.est)}.`;
  if (c.kind === 'line') return `${c.detail}. ${price}`;
  return `${c.player} has reached ${c.target}+ ${c.label} in ${c.hits} of his last ${c.n} games, averaging ${c.avg.toFixed(1)}. ${price}`;
}

/** Strongest picks first, at most one per game, skipping games already on the record. */
export function choose(cands: Candidate[], now: number, taken: Set<string>, slots: number) {
  const ok = cands.filter((c) => {
    const start = Date.parse(c.game.start);
    return (
      c.game.state === 'pre' &&
      start - now >= MIN_LEAD_MS &&
      start - now <= MAX_LEAD_MS &&
      c.odds >= ODDS_RANGE[0] &&
      c.odds <= ODDS_RANGE[1] &&
      !c.gtd &&
      c.edge >= (c.kind === 'line' ? MIN_EDGE.line : MIN_EDGE.prop) &&
      c.edge <= MAX_EDGE
    );
  });
  const out: Candidate[] = [];
  const games = new Set(taken);
  for (const c of ok.sort((a, b) => b.edge - a.edge)) {
    if (out.length >= slots) break;
    if (games.has(c.game.id)) continue;
    games.add(c.game.id);
    out.push(c);
  }
  return out;
}

async function main() {
  if (!dry && (!SERVER || !KEY)) {
    console.log('SERVER_URL or AGENT_KEY is missing; nothing to do.');
    return;
  }
  const now = Date.now();
  const today = easternDate(now);

  // What's already on today's record.
  let taken = new Set<string>();
  let postedToday = 0;
  if (SERVER) {
    // The agent's key shows picks whose games haven't started (they're sealed for the public).
    const res = await fetch(`${SERVER}/api/record`, { headers: KEY ? { Authorization: `Bearer ${KEY}` } : {} });
    if (!res.ok) throw new Error(`Couldn't read the record: ${res.status}`);
    const { picks } = (await res.json()) as { picks: { eventId: string; date: string; author: string }[] };
    const todays = picks.filter((p) => p.date === today);
    taken = new Set(todays.map((p) => p.eventId));
    postedToday = todays.filter((p) => p.author === 'model').length;
  }
  const slots = MAX_PER_DAY - postedToday;
  console.log(`${today}: ${postedToday} model pick(s) already posted, ${Math.max(0, slots)} left.`);
  if (slots <= 0) return;

  const leagues = [...new Set([...PROP_LEAGUES, ...LINE_LEAGUES])];
  const boards = new Map<LeagueKey, Game[]>();
  for (const lg of leagues) boards.set(lg, await fetchScoreboard(lg, today).catch(() => []));

  const cands: Candidate[] = [];
  const quiet = () => {};
  for (const lg of PROP_LEAGUES) {
    const games = boards.get(lg)!.filter((g) => g.state === 'pre');
    if (games.length) cands.push(...(await scanProps(lg, games, today, quiet).catch((e) => (console.log(`${lg} props failed: ${e.message}`), []))));
  }
  for (const lg of LINE_LEAGUES) {
    const games = boards.get(lg)!.filter((g) => g.state === 'pre');
    if (games.length) cands.push(...(await scanGameLines(lg, games, today, quiet).catch((e) => (console.log(`${lg} lines failed: ${e.message}`), []))));
  }
  console.log(`Scanned ${cands.length} possible picks across ${leagues.map((l) => LEAGUES[l].label).join(', ')}.`);

  const picks = choose(cands, now, taken, slots);
  if (!picks.length) {
    console.log('No edge strong enough to post right now.');
    return;
  }

  for (const c of picks) {
    const leg = toLeg(c);
    const units = Math.min(3, Math.max(0.5, Math.round(kellyUnits(c.est, c.odds) * 2) / 2));
    const body = {
      league: leg.league,
      eventId: leg.eventId,
      date: leg.date,
      market: leg.market,
      side: leg.side,
      line: leg.line,
      odds: leg.odds,
      player: leg.player,
      stat: leg.stat,
      units,
      reason: reasonFor(c),
    };
    const what = `${candidateLabel(c)} ${fmtAmerican(c.odds)} (${LEAGUES[c.league].label}, edge +${(c.edge * 100).toFixed(1)}, ${units}u)`;
    if (dry) {
      console.log(`[dry run] would post: ${what}\n           ${body.reason}`);
      continue;
    }
    const res = await fetch(`${SERVER}/api/record/picks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${KEY}` },
      body: JSON.stringify(body),
    });
    const data = (await res.json().catch(() => ({}))) as { pick?: { seq: number }; error?: string };
    console.log(res.ok ? `Posted #${data.pick?.seq}: ${what}` : `Skipped ${what}: ${data.error ?? res.status}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
