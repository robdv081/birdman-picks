// Thin client for ESPN's public scoreboard feed (CORS-enabled, no key needed).

export type LeagueKey =
  | 'nfl' | 'cfb' | 'nba' | 'nhl' | 'mlb'
  | 'mcbb' | 'wcbb' | 'wnba'
  | 'epl' | 'laliga' | 'seriea' | 'bundesliga' | 'ligue1' | 'mls' | 'ligamx' | 'ucl' | 'uel'
  | 'ufc' | 'atp' | 'wta'
  | 'pga' | 'lpga' | 'f1' | 'nascar';

/** team: two teams with odds; versus: one athlete against another (fights, tennis); field: a leaderboard (golf, racing). */
export type LeagueKind = 'team' | 'versus' | 'field';

export type SportGroup = 'Football' | 'Basketball' | 'Hockey' | 'Baseball' | 'Soccer' | 'Fighting' | 'Tennis' | 'Golf' | 'Racing';

export interface LeagueInfo {
  label: string;
  path: string;
  query?: string;
  group: SportGroup;
  kind: LeagueKind;
  /** Moneyline includes a draw (soccer), so a draw loses both team moneylines. */
  threeWay?: boolean;
}

const soccer = (label: string, code: string): LeagueInfo => ({ label, path: `soccer/${code}`, group: 'Soccer', kind: 'team', threeWay: true });

export const LEAGUES: Record<LeagueKey, LeagueInfo> = {
  nfl: { label: 'NFL', path: 'football/nfl', group: 'Football', kind: 'team' },
  cfb: { label: 'College Football', path: 'football/college-football', query: 'groups=80&limit=200', group: 'Football', kind: 'team' },
  nba: { label: 'NBA', path: 'basketball/nba', group: 'Basketball', kind: 'team' },
  mcbb: { label: "Men's College Hoops", path: 'basketball/mens-college-basketball', query: 'groups=50&limit=400', group: 'Basketball', kind: 'team' },
  wcbb: { label: "Women's College Hoops", path: 'basketball/womens-college-basketball', query: 'groups=50&limit=400', group: 'Basketball', kind: 'team' },
  wnba: { label: 'WNBA', path: 'basketball/wnba', group: 'Basketball', kind: 'team' },
  nhl: { label: 'NHL', path: 'hockey/nhl', group: 'Hockey', kind: 'team' },
  mlb: { label: 'MLB', path: 'baseball/mlb', group: 'Baseball', kind: 'team' },
  epl: soccer('Premier League', 'eng.1'),
  laliga: soccer('LaLiga', 'esp.1'),
  seriea: soccer('Serie A', 'ita.1'),
  bundesliga: soccer('Bundesliga', 'ger.1'),
  ligue1: soccer('Ligue 1', 'fra.1'),
  mls: soccer('MLS', 'usa.1'),
  ligamx: soccer('Liga MX', 'mex.1'),
  ucl: soccer('Champions League', 'uefa.champions'),
  uel: soccer('Europa League', 'uefa.europa'),
  ufc: { label: 'UFC', path: 'mma/ufc', group: 'Fighting', kind: 'versus' },
  atp: { label: 'ATP', path: 'tennis/atp', group: 'Tennis', kind: 'versus' },
  wta: { label: 'WTA', path: 'tennis/wta', group: 'Tennis', kind: 'versus' },
  pga: { label: 'PGA Tour', path: 'golf/pga', group: 'Golf', kind: 'field' },
  lpga: { label: 'LPGA', path: 'golf/lpga', group: 'Golf', kind: 'field' },
  f1: { label: 'Formula 1', path: 'racing/f1', group: 'Racing', kind: 'field' },
  nascar: { label: 'NASCAR Cup', path: 'racing/nascar-premier', group: 'Racing', kind: 'field' },
};

export const LEAGUE_KEYS = Object.keys(LEAGUES) as LeagueKey[];

export const SPORT_GROUPS: SportGroup[] = ['Football', 'Basketball', 'Hockey', 'Baseball', 'Soccer', 'Fighting', 'Tennis', 'Golf', 'Racing'];
export const leaguesIn = (g: SportGroup) => LEAGUE_KEYS.filter((k) => LEAGUES[k].group === g);
export const isThreeWay = (league?: LeagueKey) => !!league && !!LEAGUES[league].threeWay;

export interface Side {
  id: string;
  abbr: string;
  name: string;
  logo?: string;
  score: number | null;
  record?: string;
  /** ESPN's result flag; fights have no score, so this decides them. */
  winner?: boolean;
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
  /** Soccer's draw price on the three-way moneyline. */
  draw?: number;
  /** DraftKings links that put one outcome on its bet slip, plus the event page. */
  links?: DkLinks;
  /** Opening numbers, for line movement. */
  open?: { awayML?: number; homeML?: number; homeSpread?: number; total?: number };
}

export interface DkLinks {
  event?: string;
  awayML?: string;
  homeML?: string;
  draw?: string;
  awaySpread?: string;
  homeSpread?: string;
  over?: string;
  under?: string;
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
  venueCity?: string;
  venueState?: string;
  indoor?: boolean;
  /** ESPN's forecast summary for the venue (NFL/CFB), e.g. "Mostly sunny", 63°. */
  weather?: { text: string; temp?: number };
  broadcast?: string;
  away: Side;
  home: Side;
  odds?: Odds;
  link?: string;
  /** Weight class or tournament round, for fights and tennis. */
  note?: string;
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
  odds.draw = parseAmerican(pick(o.moneyline?.draw)?.odds ?? o.drawOdds?.moneyLine);
  odds.links = {
    event: dkUrl(o.link?.href),
    awayML: dkUrl(o.moneyline?.away?.close?.link?.href),
    homeML: dkUrl(o.moneyline?.home?.close?.link?.href),
    draw: dkUrl(o.moneyline?.draw?.close?.link?.href ?? o.drawOdds?.link?.href),
    awaySpread: dkUrl(o.pointSpread?.away?.close?.link?.href),
    homeSpread: dkUrl(o.pointSpread?.home?.close?.link?.href),
    over: dkUrl(o.total?.over?.close?.link?.href),
    under: dkUrl(o.total?.under?.close?.link?.href),
  };
  const opened = (side: Json) => side?.open;
  odds.open = {
    awayML: parseAmerican(opened(o.moneyline?.away)?.odds),
    homeML: parseAmerican(opened(o.moneyline?.home)?.odds),
    homeSpread: parseLine(opened(o.pointSpread?.home)?.line),
    total: parseLine(opened(o.total?.over)?.line),
  };
  // Older feeds only carry "details" like "POR -6.5"; fall back to that for the spread.
  if (!odds.awaySpread && typeof o.spread === 'number') {
    const favHome = o.homeTeamOdds?.favorite;
    const s = Math.abs(o.spread);
    odds.homeSpread = { line: favHome ? -s : s };
    odds.awaySpread = { line: favHome ? s : -s };
  }
  return odds;
}

/** ESPN sometimes wraps DraftKings links in a tracking redirect; keep only the sportsbook address. */
export function dkUrl(href: unknown): string | undefined {
  if (typeof href !== 'string' || !href) return undefined;
  let url = href;
  const m = href.match(/[?&]preurl=([^&]+)/);
  if (m) {
    try {
      url = decodeURIComponent(m[1]);
    } catch {
      return undefined;
    }
  }
  return /^https:\/\/sportsbook\.draftkings\.com\//.test(url) ? url : undefined;
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
    winner: typeof c?.winner === 'boolean' ? c.winner : undefined,
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
    venueCity: comp.venue?.address?.city,
    venueState: comp.venue?.address?.state,
    indoor: comp.venue?.indoor,
    weather: comp.weather?.displayValue ? { text: comp.weather.displayValue, temp: comp.weather.temperature } : undefined,
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
  for (const t of json.injuries ?? []) out[String(t.id)] = (t.injuries ?? []).filter(isDesignated).map(parseInjury);
  return out;
}

// ESPN's NFL feed also lists healthy players as "Active" with a news note; those aren't injuries.
const isDesignated = (i: Json) => !/^active$/i.test(String(i.status ?? i.type?.description ?? ''));

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
  for (const t of j.injuries ?? []) injuries[String(t.team?.id)] = (t.injuries ?? []).filter(isDesignated).map(parseInjury);
  return { box, leaders, injuries };
}

const localYMD = (iso: string) => {
  const d = new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

async function getScoreboard(league: LeagueKey, date: string, signal?: AbortSignal): Promise<Json> {
  const qs = [`dates=${date.replace(/-/g, '')}`, LEAGUES[league].query].filter(Boolean).join('&');
  const res = await fetch(`${base(league)}/scoreboard?${qs}`, { signal });
  if (!res.ok) throw new Error(`ESPN returned ${res.status}`);
  return res.json();
}

function athleteSide(c: Json, sets: boolean): Side {
  const a = c?.athlete ?? {};
  const won = (c?.linescores ?? []).filter((l: Json) => l.winner).length;
  return {
    id: String(c?.id ?? a.id ?? ''),
    abbr: a.shortName ?? a.displayName ?? '?',
    name: a.displayName ?? a.fullName ?? 'TBD',
    logo: a.flag?.href,
    score: sets && c?.linescores?.length ? won : null,
    record: c?.records?.[0]?.summary,
    winner: typeof c?.winner === 'boolean' ? c.winner : undefined,
  };
}

/** One fight or one tennis match as a two-sided game. */
function parseBout(league: LeagueKey, e: Json, comp: Json, note?: string): Game {
  const cs: Json[] = [...(comp.competitors ?? [])].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  const away = cs.find((c) => c.homeAway === 'away') ?? cs[0];
  const home = cs.find((c) => c !== away) ?? cs[1];
  const status = comp.status ?? e.status ?? {};
  const tennis = LEAGUES[league].group === 'Tennis';
  return {
    id: String(comp.id ?? e.id),
    league,
    start: comp.date ?? e.date,
    state: status.type?.state ?? 'pre',
    completed: !!status.type?.completed,
    detail: status.type?.shortDetail ?? status.type?.detail ?? '',
    venue: comp.venue?.fullName ?? e.venue?.displayName ?? e.venues?.[0]?.fullName,
    broadcast: comp.broadcasts?.flatMap((b: Json) => b.names ?? []).join(', ') || undefined,
    away: athleteSide(away, tennis),
    home: athleteSide(home, tennis),
    odds: parseOdds(comp.odds?.[0]),
    link: e.links?.[0]?.href,
    note,
  };
}

/** date is YYYY-MM-DD. Field events (golf, racing) have no head-to-head games; see fetchLeaderboard. */
export async function fetchScoreboard(league: LeagueKey, date: string, signal?: AbortSignal): Promise<Game[]> {
  const info = LEAGUES[league];
  if (info.kind === 'field') return [];
  const json = await getScoreboard(league, date, signal);
  const events: Json[] = json.events ?? [];
  if (info.kind === 'team') return events.map((e) => parseEvent(league, e));
  if (info.group === 'Tennis') {
    // A tournament lists every match of the week; keep singles matches played on this day.
    return events.flatMap((e) =>
      (e.groupings ?? [])
        .filter((g: Json) => /singles/i.test(g.grouping?.displayName ?? ''))
        .flatMap((g: Json) =>
          (g.competitions ?? [])
            .filter((c: Json) => c.competitors?.length === 2 && localYMD(c.date ?? e.date) === date)
            .map((c: Json) => parseBout(league, e, c, [e.shortName ?? e.name, c.round?.displayName].filter(Boolean).join(' · ')))
        )
    );
  }
  // Fight cards: every bout, main event last as ESPN lists it.
  return events.flatMap((e) =>
    (e.competitions ?? [])
      .filter((c: Json) => c.competitors?.length === 2)
      .map((c: Json) => parseBout(league, e, c, [c.type?.abbreviation, e.name].filter(Boolean).join(' · ')))
  );
}

// ---- Leaderboards (golf, racing) ---------------------------------------------------

export interface FieldRow {
  id: string;
  pos: number;
  name: string;
  flag?: string;
  /** Golf: to-par total ("-15"); racing: blank or a time/gap when ESPN has one. */
  score?: string;
  /** Golf: today's round to par. */
  today?: string;
  winner?: boolean;
}

export interface FieldSession {
  label: string; // "Round 3", "Race", "Qual"
  state: 'pre' | 'in' | 'post';
  detail: string;
  start: string;
  rows: FieldRow[];
}

export interface FieldEvent {
  id: string;
  league: LeagueKey;
  name: string;
  start: string;
  end?: string;
  state: 'pre' | 'in' | 'post';
  detail: string;
  venue?: string;
  sessions: FieldSession[];
}

function fieldRows(comp: Json, golf: boolean): FieldRow[] {
  return (comp.competitors ?? [])
    .map((c: Json, i: number): FieldRow => {
      const ls: Json[] = c.linescores ?? [];
      const last = [...ls].reverse().find((l) => l.displayValue != null && l.value != null);
      return {
        id: String(c.id ?? i),
        pos: Number(c.order) || i + 1,
        name: c.athlete?.displayName ?? c.athlete?.fullName ?? c.team?.displayName ?? '—',
        flag: c.athlete?.flag?.href,
        score: golf ? (c.score != null ? String(c.score) : undefined) : undefined,
        today: golf && ls.length > 1 ? last?.displayValue : undefined,
        winner: c.winner === true,
      };
    })
    .sort((a: FieldRow, b: FieldRow) => a.pos - b.pos);
}

/** Golf tournaments and races for the day, with their leaderboards or running orders. */
export async function fetchLeaderboard(league: LeagueKey, date: string, signal?: AbortSignal): Promise<FieldEvent[]> {
  const json = await getScoreboard(league, date, signal);
  const golf = LEAGUES[league].group === 'Golf';
  return (json.events ?? []).map((e: Json): FieldEvent => {
    const st = e.status ?? e.competitions?.[0]?.status ?? {};
    const sessions: FieldSession[] = (e.competitions ?? []).map((c: Json, i: number) => {
      const cs = c.status ?? st;
      const period = Number(cs.period) || 0;
      return {
        label: c.type?.abbreviation ?? c.type?.text ?? (golf ? (period ? `Round ${period}` : 'Leaderboard') : `Session ${i + 1}`),
        state: cs.type?.state ?? 'pre',
        detail: cs.type?.shortDetail ?? cs.type?.detail ?? '',
        start: c.date ?? e.date,
        rows: fieldRows(c, golf),
      };
    });
    // A race weekend reads "final" once practice ends; go by its sessions instead.
    const states = sessions.map((s) => s.state);
    const state: FieldEvent['state'] = !states.length
      ? st.type?.state ?? 'pre'
      : states.includes('in') || (states.includes('post') && states.includes('pre'))
        ? 'in'
        : states.every((x) => x === 'post')
          ? 'post'
          : 'pre';
    return {
      id: String(e.id),
      league,
      name: e.name ?? e.shortName ?? 'Event',
      start: e.date,
      end: e.endDate,
      state,
      detail: st.type?.shortDetail ?? st.type?.detail ?? st.type?.description ?? '',
      venue: e.circuit?.fullName ?? e.venues?.[0]?.fullName ?? e.competitions?.[0]?.venue?.fullName,
      sessions,
    };
  });
}
