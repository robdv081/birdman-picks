// DFS slate projections: site salaries, ESPN game logs, the betting market (implied team totals and,
// for NBA/NHL, player props), and injury reports, combined into one projection per player.
import { fetchInjuries, fetchScoreboard, type Game, type Injury, type LeagueKey } from './espn';
import { breakEven } from './bets';
import { fetchGamelog, fetchPropBets, fetchRoster, ladderMean, milestoneRungs, pool, projectGame, totalLines, type GameRow, type RosterPlayer } from './market';
import { canFill, parseSalaries, projectPoints, type Risk } from './optimizer';
import { sameName } from './stats';
import { shiftYMD, todayYMD } from './store';

export type Site = 'dk' | 'fd';
export type Sport = 'nba' | 'nfl' | 'nhl';

export interface SlatePlayer {
  id: string;
  name: string;
  pos: string[];
  slots: string[]; // roster slots this player can fill
  salary: number;
  team: string;
  opp?: string;
  game?: string;
  time?: string;
  avg: number; // the site's own season average fantasy points
  status: string;
}

export interface Slate {
  id: string;
  site: Site;
  sport: Sport;
  label: string;
  start?: string;
  games?: number;
  cap: number;
  slots: string[];
  players: SlatePlayer[];
}

export interface DfsPlayer extends SlatePlayer {
  key: string;
  proj: number;
  ceiling: number;
  source: string;
  risks: Risk[];
  out: boolean;
  implied?: number; // the team's implied points from the betting lines
  recent: number[]; // fantasy points in recent games, newest first
}

export const SPORT_LABEL: Record<Sport, string> = { nba: 'NBA', nfl: 'NFL', nhl: 'NHL' };

/** Salary lists the deploy workflow refreshes from DraftKings every 30 minutes. */
export async function loadDkSlates(): Promise<{ updated?: string; slates: Slate[] }> {
  try {
    const r = await fetch('data/dk-slates.json', { cache: 'no-store' });
    return r.ok ? await r.json() : { slates: [] };
  } catch {
    return { slates: [] };
  }
}

// Where a site's team abbreviation differs from ESPN's.
const ALIAS: Record<Sport, Record<string, string>> = {
  nfl: { WAS: 'WSH', JAC: 'JAX', LA: 'LAR' },
  nba: { GSW: 'GS', NOP: 'NO', NYK: 'NY', SAS: 'SA', PHO: 'PHX', UTA: 'UTAH', WAS: 'WSH' },
  nhl: { UTA: 'UTAH', WAS: 'WSH', LAK: 'LA', NJD: 'NJ', SJS: 'SJ', TBL: 'TB', MON: 'MTL', CLS: 'CBJ', NAS: 'NSH', ANH: 'ANA', CAL: 'CGY' },
};
const toEspn = (sport: Sport, abbr?: string) => (abbr ? ALIAS[sport][abbr.toUpperCase()] ?? abbr.toUpperCase() : '');

/** FanDuel (or any site) player-list CSV → a slate for the given contest format. */
export function slateFromCsv(text: string, sport: Sport, site: Site, slots: string[], cap: number): Slate {
  const rows = parseSalaries(text);
  return {
    id: `${site}-paste`,
    site,
    sport,
    label: 'Pasted player list',
    cap,
    slots,
    players: rows.map((r, i) => ({
      id: r.id ?? `p${i}`,
      name: r.name,
      pos: r.pos,
      slots: r.roster?.length ? r.roster : [...new Set(slots)].filter((s) => fits(sport, s, r.pos)),
      salary: r.salary,
      team: r.team ?? '',
      opp: r.opp,
      game: r.game,
      avg: r.avg ?? 0,
      status: r.out ? 'O' : r.status ?? '',
    })),
  };
}

/** Slot eligibility for pasted lists, where a slot name can mean different things per sport. */
function fits(sport: Sport, slot: string, pos: string[]) {
  if (sport === 'nhl') {
    if (slot === 'UTIL') return pos.some((p) => ['C', 'W', 'LW', 'RW', 'D'].includes(p));
    if (slot === 'W') return pos.some((p) => ['W', 'LW', 'RW'].includes(p));
    return pos.includes(slot);
  }
  if (sport === 'nfl') {
    if (slot === 'FLEX') return pos.some((p) => ['RB', 'WR', 'TE'].includes(p));
    if (slot === 'SUPERFLEX') return pos.some((p) => ['QB', 'RB', 'WR', 'TE'].includes(p));
    if (slot === 'DEF' || slot === 'DST') return pos.some((p) => ['D', 'DST', 'DEF'].includes(p));
    return pos.includes(slot);
  }
  return canFill(slot, pos);
}

// ---- Scoring a game-log row ---------------------------------------------------

const NBA_3PM = 'threePointFieldGoalsMade-threePointFieldGoalsAttempted';

function rowPoints(sport: Sport, site: Site, v: Record<string, number>, goalie: boolean, defense: boolean): number {
  const n = (k: string) => v[k] ?? 0;
  if (sport === 'nba') {
    const [pts, reb, ast, stl, blk, to] = ['points', 'totalRebounds', 'assists', 'steals', 'blocks', 'turnovers'].map(n);
    if (site === 'fd') return pts + 1.2 * reb + 1.5 * ast + 3 * stl + 3 * blk - to;
    const doubles = [pts, reb, ast, stl, blk].filter((x) => x >= 10).length;
    return pts + 0.5 * n(NBA_3PM) + 1.25 * reb + 1.5 * ast + 2 * stl + 2 * blk - 0.5 * to + (doubles >= 2 ? 1.5 : 0) + (doubles >= 3 ? 3 : 0);
  }
  if (sport === 'nfl') {
    const py = n('passingYards');
    const ry = n('rushingYards');
    const recy = n('receivingYards');
    const common = 0.04 * py + 4 * n('passingTouchdowns') - n('interceptions') + 0.1 * ry + 6 * n('rushingTouchdowns') + 0.1 * recy + 6 * n('receivingTouchdowns');
    if (site === 'fd') return common + 0.5 * n('receptions') - 2 * n('fumblesLost');
    return common + n('receptions') - n('fumblesLost') + (py >= 300 ? 3 : 0) + (ry >= 100 ? 3 : 0) + (recy >= 100 ? 3 : 0);
  }
  // NHL
  if (goalie) {
    const sv = n('saves');
    if (site === 'fd') return 12 * n('wins') - 4 * n('goalsAgainst') + 0.8 * sv + 8 * n('shutouts');
    return 6 * n('wins') + 0.7 * sv - 3.5 * n('goalsAgainst') + 4 * n('shutouts') + 2 * n('overtimeLosses') + (sv >= 35 ? 3 : 0);
  }
  const g = n('goals');
  const a = n('assists');
  const s = n('shotsTotal');
  const blk = defense ? 1.3 : 0.5; // ESPN's skater game log has no blocked shots; league-typical rates by position
  const sh = n('shortHandedGoals') + n('shortHandedAssists');
  if (site === 'fd') return 12 * g + 8 * a + 1.6 * s + 1.6 * blk + 0.5 * (n('powerPlayGoals') + n('powerPlayAssists')) + 2 * sh;
  return 8.5 * g + 5 * a + 1.5 * s + 1.3 * blk + 2 * sh + (g >= 3 ? 3 : 0) + (s >= 5 ? 3 : 0) + (g + a >= 3 ? 3 : 0);
}

function nhlMeanPoints(site: Site, m: { g: number; a: number; sog: number }, defense: boolean) {
  const blk = defense ? 1.3 : 0.5;
  return site === 'fd' ? 12 * m.g + 8 * m.a + 1.6 * m.sog + 1.6 * blk : 8.5 * m.g + 5 * m.a + 1.5 * m.sog + 1.3 * blk;
}

// ---- Market context -------------------------------------------------------------

/** Each team's implied points from DraftKings' total and spread (NHL: total and moneyline). */
function impliedTotals(g: Game): Record<string, number> {
  const o = g.odds;
  const total = o?.over?.line;
  if (total == null) return {};
  let homeEdge: number | undefined; // expected home margin
  if (g.league === 'nhl' && o?.homeML != null && o?.awayML != null) {
    const h = breakEven(o.homeML);
    const a = breakEven(o.awayML);
    homeEdge = (h / (h + a) - 0.5) * 2.0; // ~1 goal of margin per 25 points of win probability
  } else if (o?.homeSpread?.line != null) homeEdge = -o.homeSpread.line;
  if (homeEdge == null) return {};
  return { [g.home.abbr]: total / 2 + homeEdge / 2, [g.away.abbr]: total / 2 - homeEdge / 2 };
}

const OUT_STATUSES = ['O', 'OUT', 'IR', 'NA', 'SUSP', 'PUP', 'NFI'];
const SAMPLE: Record<Sport, number> = { nba: 10, nfl: 8, nhl: 10 };
const clamp = (x: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, x));
const mean = (a: number[]) => a.reduce((s, x) => s + x, 0) / a.length;
const sd = (a: number[]) => {
  const m = mean(a);
  return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / Math.max(1, a.length - 1));
};

/**
 * Projects every player on a slate. Projection = recent form (last games, site scoring) blended 60/40 with the
 * site's season average, scaled by the team's implied total vs. the slate average; for NBA/NHL, 70% weight goes
 * to the prop market when the player has lines, since the market already prices matchup and role.
 */
export async function projectSlate(slate: Slate, onProgress: (msg: string) => void): Promise<DfsPlayer[]> {
  const sport = slate.sport;
  const league = sport as LeagueKey;
  const site = slate.site;
  const day = slate.start?.slice(0, 10) ?? todayYMD();

  onProgress('Loading games and betting lines…');
  const [today, tomorrow, injuries] = await Promise.all([
    fetchScoreboard(league, day).catch(() => [] as Game[]),
    fetchScoreboard(league, shiftYMD(day, 1)).catch(() => [] as Game[]),
    fetchInjuries(league).catch(() => ({} as Record<string, Injury[]>)),
  ]);
  const slateTeams = new Set(slate.players.map((p) => toEspn(sport, p.team)));
  const games = [...today, ...tomorrow].filter((g) => slateTeams.has(g.home.abbr) || slateTeams.has(g.away.abbr));
  const implied: Record<string, number> = Object.assign({}, ...games.map(impliedTotals));
  const impliedVals = Object.values(implied);
  const slateAvg = impliedVals.length ? mean(impliedVals) : 0;
  const injuryList = Object.values(injuries).flat();

  onProgress('Matching players to rosters…');
  const rosters = new Map<string, (RosterPlayer & { team: string })[]>();
  await pool(
    games.flatMap((g) => [g.home, g.away]),
    8,
    async (t) => {
      if (!rosters.has(t.abbr)) rosters.set(t.abbr, (await fetchRoster(league, t.id).catch(() => [])).map((p) => ({ ...p, team: t.abbr })));
    }
  );
  const everyone = [...rosters.values()].flat();
  const espnOf = (p: SlatePlayer) =>
    (rosters.get(toEspn(sport, p.team)) ?? []).find((r) => sameName(r.name, p.name)) ?? everyone.find((r) => sameName(r.name, p.name));

  // Prop-market projections (site points), keyed by ESPN athlete id.
  const market = new Map<string, number>();
  const marketGames = new Set<string>();
  const nhlMarket = new Map<string, Partial<{ g: number; a: number; sog: number }>>();
  if (sport === 'nba' || sport === 'nhl') {
    let i = 0;
    const pre = games.filter((g) => g.state === 'pre');
    for (const g of pre) {
      onProgress(`Reading player props… game ${++i} of ${pre.length}`);
      if (sport === 'nba') {
        const proj = await projectGame(g).catch(() => []);
        for (const p of proj) {
          if (p.hasMarket) {
            market.set(p.athleteId, projectPoints(p, site === 'dk' ? 'dk-nba' : 'fd-nba'));
            marketGames.add(g.id);
          }
        }
      } else {
        const items = await fetchPropBets('nhl', g.id).catch(() => []);
        if (items.length) marketGames.add(g.id);
        const lines = totalLines('nhl', items);
        const rungs = milestoneRungs('nhl', items);
        const ids = new Set(rungs.map((r) => r.athleteId));
        for (const id of ids) {
          const stat = (k: string) => {
            const line = lines.get(`${id}|${k}`);
            if (line != null) return line;
            const lad = rungs.filter((r) => r.athleteId === id && r.def.stat === k);
            if (lad.length === 1 && lad[0].target === 1) return -Math.log(1 - Math.pow(breakEven(lad[0].odds), 1.2)); // Poisson from "1+"
            return lad.length ? ladderMean(lad) : undefined;
          };
          const g2 = stat('g');
          const pts = stat('pts');
          const a = stat('a') ?? (pts != null && g2 != null ? Math.max(0, pts - g2) : undefined);
          nhlMarket.set(id, { g: g2, a, sog: stat('sog') });
        }
      }
    }
  }

  // Game logs for everyone with a meaningful role.
  const isTeamDefense = (p: SlatePlayer) => sport === 'nfl' && p.pos.some((x) => x === 'DST' || x === 'D' || x === 'DEF');
  const matched = slate.players.map((p) => ({ p, espn: isTeamDefense(p) ? undefined : espnOf(p) }));
  const wanted = matched.filter(({ p, espn }) => espn && !OUT_STATUSES.includes(p.status.toUpperCase()) && (p.avg >= 1.5 || market.has(espn.id) || nhlMarket.has(espn.id)));
  const logs = new Map<string, GameRow[]>();
  let done = 0;
  await pool(wanted, 8, async ({ espn }) => {
    logs.set(espn!.id, (await fetchGamelog(league, espn!.id, SAMPLE[sport]).catch(() => [] as GameRow[])).slice(0, SAMPLE[sport]));
    if (++done % 5 === 0 || done === wanted.length) onProgress(`Reading recent games… ${done} of ${wanted.length} players`);
  });

  // NHL: the goalie with the most starts in the last two weeks is the probable starter.
  const starters = new Set<string>();
  if (sport === 'nhl') {
    const cutoff = new Date(Date.now() - 14 * 86400_000).toISOString();
    const byTeam = new Map<string, { id: string; starts: number; salary: number }[]>();
    for (const { p, espn } of matched) {
      if (!p.pos.includes('G') || !espn) continue;
      const starts = (logs.get(espn.id) ?? []).filter((r) => r.date >= cutoff && r.vals.gameStarted).length;
      byTeam.set(p.team, [...(byTeam.get(p.team) ?? []), { id: p.id, starts, salary: p.salary }]);
    }
    for (const list of byTeam.values()) {
      const best = list.sort((a, b) => b.starts - a.starts || b.salary - a.salary)[0];
      if (best) starters.add(best.id);
    }
  }

  onProgress('Building projections…');
  return matched
    .map(({ p, espn }) => {
      const status = p.status.toUpperCase();
      const injury = espn ? injuryList.find((i) => sameName(i.player, espn.name)) : undefined;
      const out = OUT_STATUSES.includes(status) || injury?.severity === 'out';
      const goalie = sport === 'nhl' && p.pos.includes('G');
      const isDst = isTeamDefense(p);
      const rows = espn ? logs.get(espn.id) ?? [] : [];
      const recent = rows.map((r) => rowPoints(sport, site, r.vals, goalie, p.pos.includes('D')));
      const form = recent.length >= 3 ? mean(recent) : null;
      const season = p.avg > 0 ? p.avg : null;
      let base = form != null && season != null ? 0.6 * form + 0.4 * season : form ?? season ?? 0;

      // Matchup: the team's implied points vs. the slate average. Defenses and goalies want the opponent's to be low.
      const team = toEspn(sport, p.team);
      const opp = toEspn(sport, p.opp);
      const own = implied[espn?.team ?? team] ?? implied[team];
      const theirs = implied[opp];
      let factor = 1;
      if (slateAvg) {
        if ((isDst || goalie) && theirs) factor = clamp(1 + 0.5 * (slateAvg / theirs - 1), 0.8, 1.25);
        else if (own) factor = clamp(1 + 0.5 * (own / slateAvg - 1), 0.85, 1.15);
      }
      base *= factor;

      let marketPts: number | undefined;
      if (espn && market.has(espn.id)) marketPts = market.get(espn.id);
      if (espn && nhlMarket.has(espn.id) && !goalie) {
        const m = nhlMarket.get(espn.id)!;
        const avgOf = (k: string) => (rows.length ? mean(rows.map((r) => r.vals[k] ?? 0)) : 0);
        marketPts = nhlMeanPoints(site, { g: m.g ?? avgOf('goals'), a: m.a ?? avgOf('assists'), sog: m.sog ?? avgOf('shotsTotal') }, p.pos.includes('D'));
      }
      let proj = marketPts != null ? 0.7 * marketPts + 0.3 * base : base;
      const source = marketPts != null ? 'prop market + form' : form != null ? 'recent form' : season != null ? 'season average' : 'no data';

      const risks: Risk[] = [];
      if (status === 'Q' || status === 'DTD' || status === 'GTD' || injury?.severity === 'q') risks.push('gtd');
      if (status === 'D') risks.push('doubtful');
      if (goalie && !starters.has(p.id)) {
        proj *= 0.1;
        risks.push('backup-goalie');
      }
      if (sport === 'nba') {
        const mins = rows.slice(0, 5).map((r) => r.vals.minutes ?? 0);
        if (mins.length && mean(mins) < 18) risks.push('low-minutes');
        if (mins.length >= 3 && Math.min(...mins) < 10) risks.push('volatile');
        const g = games.find((x) => x.home.abbr === (espn?.team ?? team) || x.away.abbr === (espn?.team ?? team));
        if (g && marketGames.has(g.id) && marketPts == null) risks.push('no-market');
      }
      const spread = recent.length >= 3 ? sd(recent) : proj * (sport === 'nfl' ? 0.45 : 0.35);
      return {
        ...p,
        key: p.id,
        proj: Math.round(proj * 10) / 10,
        ceiling: Math.round((proj + 1.28 * spread) * 10) / 10,
        source,
        risks,
        out,
        implied: isDst || goalie ? theirs : own,
        recent,
      };
    })
    .sort((a, b) => b.proj - a.proj);
}
