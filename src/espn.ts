// Thin client for ESPN's public scoreboard feed (CORS-enabled, no key needed).

export type LeagueKey = 'nfl' | 'cfb' | 'nba' | 'nhl' | 'mlb';

export const LEAGUES: Record<LeagueKey, { label: string; path: string; query?: string }> = {
  nfl: { label: 'NFL', path: 'football/nfl' },
  cfb: { label: 'College Football', path: 'football/college-football', query: 'groups=80&limit=200' },
  nba: { label: 'NBA', path: 'basketball/nba' },
  nhl: { label: 'NHL', path: 'hockey/nhl' },
  mlb: { label: 'MLB', path: 'baseball/mlb' },
};

export const LEAGUE_KEYS = Object.keys(LEAGUES) as LeagueKey[];

export interface Side {
  id: string;
  abbr: string;
  name: string;
  logo?: string;
  score: number | null;
  record?: string;
}

export interface Price {
  line?: number;
  odds?: number;
}

export interface Odds {
  provider: string;
  awayML?: number;
  homeML?: number;
  awaySpread?: Price;
  homeSpread?: Price;
  over?: Price;
  under?: Price;
}

export interface Game {
  id: string;
  league: LeagueKey;
  start: string;
  state: 'pre' | 'in' | 'post';
  completed: boolean;
  detail: string;
  period?: number;
  clock?: string; // "4:12"
  venue?: string;
  broadcast?: string;
  away: Side;
  home: Side;
  odds?: Odds;
  link?: string;
}

export function parseAmerican(s: unknown): number | undefined {
  if (s == null) return undefined;
  const str = String(s).trim();
  if (str.toUpperCase() === 'EVEN') return 100;
  const n = parseInt(str, 10);
  return Number.isFinite(n) && n !== 0 ? n : undefined;
}

function parseLine(s: unknown): number | undefined {
  if (s == null) return undefined;
  const n = parseFloat(String(s).replace(/^[ou]/i, ''));
  return Number.isFinite(n) ? n : undefined;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

function pick(side: Json): Json {
  return side?.close ?? side?.open;
}

function parseOdds(o: Json): Odds | undefined {
  if (!o) return undefined;
  const odds: Odds = { provider: o.provider?.displayName ?? o.provider?.name ?? 'Sportsbook' };
  odds.awayML = parseAmerican(pick(o.moneyline?.away)?.odds);
  odds.homeML = parseAmerican(pick(o.moneyline?.home)?.odds);
  const as = pick(o.pointSpread?.away);
  const hs = pick(o.pointSpread?.home);
  if (as) odds.awaySpread = { line: parseLine(as.line), odds: parseAmerican(as.odds) };
  if (hs) odds.homeSpread = { line: parseLine(hs.line), odds: parseAmerican(hs.odds) };
  const ov = pick(o.total?.over);
  const un = pick(o.total?.under);
  const total = parseLine(ov?.line) ?? (typeof o.overUnder === 'number' ? o.overUnder : undefined);
  if (total != null) {
    odds.over = { line: total, odds: parseAmerican(ov?.odds) };
    odds.under = { line: total, odds: parseAmerican(un?.odds) };
  }
  // Older feeds only carry "details" like "POR -6.5"; fall back to that for the spread.
  if (!odds.awaySpread && typeof o.spread === 'number') {
    const favHome = o.homeTeamOdds?.favorite;
    const s = Math.abs(o.spread);
    odds.homeSpread = { line: favHome ? -s : s };
    odds.awaySpread = { line: favHome ? s : -s };
  }
  return odds;
}

function parseSide(c: Json): Side {
  const score = c?.score != null && c.score !== '' ? Number(c.score) : null;
  return {
    id: String(c?.team?.id ?? ''),
    abbr: c?.team?.abbreviation ?? '?',
    name: c?.team?.displayName ?? c?.team?.name ?? 'TBD',
    logo: c?.team?.logo,
    score: Number.isFinite(score) ? score : null,
    record: c?.records?.[0]?.summary,
  };
}

function parseEvent(league: LeagueKey, e: Json): Game {
  const comp = e.competitions?.[0] ?? {};
  const away = comp.competitors?.find((c: Json) => c.homeAway === 'away');
  const home = comp.competitors?.find((c: Json) => c.homeAway === 'home');
  const status = comp.status ?? e.status ?? {};
  return {
    id: String(e.id),
    league,
    start: e.date,
    state: status.type?.state ?? 'pre',
    completed: !!status.type?.completed,
    detail: status.type?.shortDetail ?? status.type?.detail ?? '',
    period: status.period,
    clock: status.displayClock,
    venue: comp.venue?.fullName,
    broadcast: comp.broadcasts?.flatMap((b: Json) => b.names ?? []).join(', ') || undefined,
    away: parseSide(away),
    home: parseSide(home),
    odds: parseOdds(comp.odds?.[0]),
    link: e.links?.find((l: Json) => l.rel?.includes('summary'))?.href ?? e.links?.[0]?.href,
  };
}

const base = (league: LeagueKey) => `https://site.api.espn.com/apis/site/v2/sports/${LEAGUES[league].path}`;

export interface Injury {
  player: string;
  pos?: string;
  status: string;
  severity: 'out' | 'q';
  detail?: string;
  comment?: string;
  returnDate?: string;
}

function parseInjury(i: Json): Injury {
  const status: string = i.status ?? i.type?.description ?? 'Unknown';
  const d = i.details;
  return {
    player: i.athlete?.displayName ?? 'Unknown',
    pos: i.athlete?.position?.abbreviation,
    status,
    severity: /out|reserve|suspend|inactive/i.test(status) ? 'out' : 'q',
    detail: [d?.side, d?.type, d?.detail].filter((x) => x && x !== 'Not Specified').join(' ') || undefined,
    comment: i.shortComment,
    returnDate: d?.returnDate,
  };
}

/** Current injury report for every team in the league, keyed by ESPN team id. */
export async function fetchInjuries(league: LeagueKey, signal?: AbortSignal): Promise<Record<string, Injury[]>> {
  const res = await fetch(`${base(league)}/injuries`, { signal });
  if (!res.ok) throw new Error(`ESPN returned ${res.status}`);
  const json = await res.json();
  const out: Record<string, Injury[]> = {};
  for (const t of json.injuries ?? []) out[String(t.id)] = (t.injuries ?? []).map(parseInjury);
  return out;
}

export interface StatRow {
  id: string;
  name: string;
  pos?: string;
  starter: boolean;
  dnp: boolean;
  stats: string[];
}

export interface StatGroup {
  name: string;
  labels: string[];
  rows: StatRow[];
}

export interface TeamBox {
  teamId: string;
  abbr: string;
  logo?: string;
  won: boolean;
  groups: StatGroup[];
}

export interface TeamLeaders {
  teamId: string;
  abbr: string;
  items: { category: string; player: string; value: string }[];
}

export interface GameSummary {
  box: TeamBox[];
  leaders: TeamLeaders[];
  injuries: Record<string, Injury[]>;
}

export async function fetchSummary(league: LeagueKey, eventId: string, signal?: AbortSignal): Promise<GameSummary> {
  const res = await fetch(`${base(league)}/summary?event=${eventId}`, { signal });
  if (!res.ok) throw new Error(`ESPN returned ${res.status}`);
  const j = await res.json();
  const competitors: Json[] = j.header?.competitions?.[0]?.competitors ?? [];
  const box: TeamBox[] = (j.boxscore?.players ?? []).map((p: Json) => ({
    teamId: String(p.team?.id),
    abbr: p.team?.abbreviation ?? '',
    logo: p.team?.logo,
    won: !!competitors.find((c) => String(c.id ?? c.team?.id) === String(p.team?.id))?.winner,
    groups: (p.statistics ?? []).map((g: Json) => ({
      name: g.name ?? g.text ?? '',
      labels: g.labels ?? [],
      rows: (g.athletes ?? []).map((a: Json) => ({
        id: String(a.athlete?.id ?? ''),
        name: a.athlete?.displayName ?? '',
        pos: a.athlete?.position?.abbreviation,
        starter: !!a.starter,
        dnp: !!a.didNotPlay || !(a.stats?.length),
        stats: a.stats ?? [],
      })),
    })),
  }));
  const leaders: TeamLeaders[] = (j.leaders ?? []).map((t: Json) => ({
    teamId: String(t.team?.id),
    abbr: t.team?.abbreviation ?? '',
    items: (t.leaders ?? [])
      .filter((c: Json) => c.leaders?.length)
      .map((c: Json) => ({
        category: c.displayName ?? c.name,
        player: c.leaders[0].athlete?.displayName ?? '',
        value: c.leaders[0].displayValue ?? '',
      })),
  }));
  const injuries: Record<string, Injury[]> = {};
  for (const t of j.injuries ?? []) injuries[String(t.team?.id)] = (t.injuries ?? []).map(parseInjury);
  return { box, leaders, injuries };
}

/** date is YYYY-MM-DD */
export async function fetchScoreboard(league: LeagueKey, date: string, signal?: AbortSignal): Promise<Game[]> {
  const qs = [`dates=${date.replace(/-/g, '')}`, LEAGUES[league].query].filter(Boolean).join('&');
  const res = await fetch(`${base(league)}/scoreboard?${qs}`, { signal });
  if (!res.ok) throw new Error(`ESPN returned ${res.status}`);
  const json = await res.json();
  return (json.events ?? []).map((e: Json) => parseEvent(league, e));
}
