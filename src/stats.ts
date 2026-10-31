// Reading player stats out of ESPN box scores: prop grading and DFS scoring.
import type { GameSummary, LeagueKey, StatGroup, StatRow } from './espn';

/** Points at one box-score column. `group` matches the group name; `groupHas` a label the group must contain. */
interface StatRef {
  label: string;
  group?: string;
  groupHas?: string;
  made?: boolean; // "made-attempted" cells like 3PT "4-9" → 4
}

export interface PropStat {
  key: string;
  label: string;
  parts: StatRef[];
}

const nbaPts = { label: 'PTS' };
const nbaReb = { label: 'REB' };
const nbaAst = { label: 'AST' };
const fb = (group: string, label: string): StatRef => ({ group, label });
const footballProps: PropStat[] = [
  { key: 'passYds', label: 'Passing yards', parts: [fb('passing', 'YDS')] },
  { key: 'passTD', label: 'Passing TDs', parts: [fb('passing', 'TD')] },
  { key: 'rushYds', label: 'Rushing yards', parts: [fb('rushing', 'YDS')] },
  { key: 'recYds', label: 'Receiving yards', parts: [fb('receiving', 'YDS')] },
  { key: 'rec', label: 'Receptions', parts: [fb('receiving', 'REC')] },
  { key: 'rushRecYds', label: 'Rush + rec yards', parts: [fb('rushing', 'YDS'), fb('receiving', 'YDS')] },
  { key: 'tds', label: 'Rush + rec TDs', parts: [fb('rushing', 'TD'), fb('receiving', 'TD')] },
];

export const PROP_STATS: Record<LeagueKey, PropStat[]> = {
  nba: [
    { key: 'pts', label: 'Points', parts: [nbaPts] },
    { key: 'reb', label: 'Rebounds', parts: [nbaReb] },
    { key: 'ast', label: 'Assists', parts: [nbaAst] },
    { key: '3pm', label: 'Threes made', parts: [{ label: '3PT', made: true }] },
    { key: 'pra', label: 'Pts + Reb + Ast', parts: [nbaPts, nbaReb, nbaAst] },
    { key: 'pr', label: 'Pts + Reb', parts: [nbaPts, nbaReb] },
    { key: 'pa', label: 'Pts + Ast', parts: [nbaPts, nbaAst] },
    { key: 'ra', label: 'Reb + Ast', parts: [nbaReb, nbaAst] },
    { key: 'stl', label: 'Steals', parts: [{ label: 'STL' }] },
    { key: 'blk', label: 'Blocks', parts: [{ label: 'BLK' }] },
  ],
  nfl: footballProps,
  cfb: footballProps,
  nhl: [
    { key: 'g', label: 'Goals', parts: [{ label: 'G', groupHas: 'SOG' }] },
    { key: 'a', label: 'Assists', parts: [{ label: 'A', groupHas: 'SOG' }] },
    { key: 'pts', label: 'Points', parts: [{ label: 'G', groupHas: 'SOG' }, { label: 'A', groupHas: 'SOG' }] },
    // ESPN's "SOG" column is shootout goals; shots on goal are "S".
    { key: 'sog', label: 'Shots on goal', parts: [{ label: 'S', groupHas: 'SM' }] },
    { key: 'sv', label: 'Saves', parts: [{ label: 'SV', groupHas: 'SV%' }] },
  ],
  mlb: [
    { key: 'h', label: 'Hits', parts: [{ label: 'H', groupHas: 'AB' }] },
    { key: 'hr', label: 'Home runs', parts: [{ label: 'HR', groupHas: 'AB' }] },
    { key: 'rbi', label: 'RBIs', parts: [{ label: 'RBI', groupHas: 'AB' }] },
    { key: 'hrr', label: 'Hits + Runs + RBIs', parts: [{ label: 'H', groupHas: 'AB' }, { label: 'R', groupHas: 'AB' }, { label: 'RBI', groupHas: 'AB' }] },
    { key: 'k', label: 'Pitcher strikeouts', parts: [{ label: 'K', groupHas: 'IP' }] },
  ],
};

export const propStat = (league: LeagueKey, key: string) => PROP_STATS[league].find((p) => p.key === key);

export function normName(s: string) {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[.'’]/g, '')
    .replace(/-/g, ' ')
    .replace(/\b(jr|sr|ii|iii|iv)\b/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** "B. Carlson" matches "Ben Carlson"; full names must match exactly after normalising. */
export function sameName(a: string, b: string) {
  const x = normName(a);
  const y = normName(b);
  if (x === y) return true;
  const [xf, ...xr] = x.split(' ');
  const [yf, ...yr] = y.split(' ');
  if (xr.join(' ') !== yr.join(' ') || !xr.length) return false;
  return (xf.length === 1 && yf.startsWith(xf)) || (yf.length === 1 && xf.startsWith(yf));
}

function groupMatches(g: StatGroup, ref: StatRef) {
  if (ref.group && g.name !== ref.group) return false;
  if (ref.groupHas && !g.labels.includes(ref.groupHas)) return false;
  return g.labels.includes(ref.label);
}

function cell(row: StatRow, g: StatGroup, ref: StatRef): number {
  const raw = row.stats[g.labels.indexOf(ref.label)] ?? '';
  const n = parseFloat(ref.made ? raw.split('-')[0] : raw);
  return Number.isFinite(n) ? n : 0;
}

function allGroups(s: GameSummary) {
  return s.box.flatMap((t) => t.groups);
}

export function findPlayer(s: GameSummary, player: string): StatRow | undefined {
  for (const g of allGroups(s)) {
    const r = g.rows.find((r) => sameName(r.name, player));
    if (r) return r;
  }
  return undefined;
}

/** Sum of the stat's parts, or null when the player isn't in the box score or didn't play. */
export function statValue(s: GameSummary, player: string, stat: PropStat): number | null {
  const p = findPlayer(s, player);
  if (!p || p.dnp) return null;
  let total = 0;
  for (const ref of stat.parts) {
    // First matching group only: NHL repeats skaters across forwards/defenses/skaters groups.
    for (const g of allGroups(s)) {
      if (!groupMatches(g, ref)) continue;
      const row = g.rows.find((r) => r.id === p.id);
      if (row) {
        total += cell(row, g, ref);
        break;
      }
    }
  }
  return total;
}

// ---- DFS scoring --------------------------------------------------------

interface ScoreContext {
  won: boolean; // player's team won
  starter: boolean;
  goalie: boolean;
}

type Scorer = (get: (ref: StatRef) => number, ctx: ScoreContext) => number;

const nbaFD: Scorer = (get) =>
  get(nbaPts) + 1.2 * get(nbaReb) + 1.5 * get(nbaAst) + 3 * get({ label: 'STL' }) + 3 * get({ label: 'BLK' }) - get({ label: 'TO' });

const nbaDK: Scorer = (get) => {
  const cats = [get(nbaPts), get(nbaReb), get(nbaAst), get({ label: 'STL' }), get({ label: 'BLK' })];
  const doubles = cats.filter((c) => c >= 10).length;
  return (
    cats[0] + 0.5 * get({ label: '3PT', made: true }) + 1.25 * cats[1] + 1.5 * cats[2] + 2 * cats[3] + 2 * cats[4] -
    0.5 * get({ label: 'TO' }) + (doubles >= 2 ? 1.5 : 0) + (doubles >= 3 ? 3 : 0)
  );
};

const nflOffense = (ppr: number, fumble: number, bonuses: boolean): Scorer => (get) => {
  const passYds = get(fb('passing', 'YDS'));
  const rushYds = get(fb('rushing', 'YDS'));
  const recYds = get(fb('receiving', 'YDS'));
  let pts =
    0.04 * passYds + 4 * get(fb('passing', 'TD')) - get(fb('passing', 'INT')) +
    0.1 * rushYds + 6 * get(fb('rushing', 'TD')) +
    ppr * get(fb('receiving', 'REC')) + 0.1 * recYds + 6 * get(fb('receiving', 'TD')) -
    fumble * get(fb('fumbles', 'LOST')) +
    6 * (get(fb('kickReturns', 'TD')) + get(fb('puntReturns', 'TD')));
  if (bonuses) pts += (passYds >= 300 ? 3 : 0) + (rushYds >= 100 ? 3 : 0) + (recYds >= 100 ? 3 : 0);
  return pts;
};

// NHL: skater columns live in the forwards/defenses groups (they carry SM), goalie columns in the group with SV%.
// Shots on goal are ESPN's "S" column ("SOG" there means shootout goals).
const sk = (label: string): StatRef => ({ label, groupHas: 'SM' });
const gl = (label: string): StatRef => ({ label, groupHas: 'SV%' });

// Power-play and short-handed points aren't in ESPN's box score, so those small bonuses are left out.
const nhlFD: Scorer = (get, ctx) =>
  ctx.goalie
    ? (ctx.won && ctx.starter ? 12 : 0) - 4 * get(gl('GA')) + 0.8 * get(gl('SV')) + (ctx.starter && get(gl('GA')) === 0 ? 8 : 0)
    : 12 * get(sk('G')) + 8 * get(sk('A')) + 1.6 * get(sk('S')) + 1.6 * get(sk('BS'));

const nhlDK: Scorer = (get, ctx) => {
  if (ctx.goalie) {
    const sv = get(gl('SV'));
    const ga = get(gl('GA'));
    return (ctx.won && ctx.starter ? 6 : 0) + 0.7 * sv - 3.5 * ga + (ctx.starter && ga === 0 ? 4 : 0) + (sv >= 35 ? 3 : 0);
  }
  const g = get(sk('G'));
  const a = get(sk('A'));
  const sog = get(sk('S'));
  const blk = get(sk('BS'));
  return (
    8.5 * g + 5 * a + 1.5 * sog + 1.3 * blk +
    (g >= 3 ? 3 : 0) + (sog >= 5 ? 3 : 0) + (blk >= 3 ? 3 : 0) + (g + a >= 3 ? 3 : 0)
  );
};

const SCORERS: Record<string, Scorer> = {
  'fd-nba': nbaFD,
  'fd-nba-classic': nbaFD,
  'dk-nba': nbaDK,
  'fd-nfl': nflOffense(0.5, -2, false),
  'dk-nfl': nflOffense(1, -1, true),
  'fd-cfb': nflOffense(0.5, -2, false),
  'dk-cfb': nflOffense(1, -1, true),
  'fd-nhl': nhlFD,
  'dk-nhl': nhlDK,
};

export const canScore = (templateId: string) => templateId in SCORERS;

/** DFS points for a player across a set of box scores, or null if not found. Team defenses aren't scored. */
export function fantasyPoints(summaries: GameSummary[], player: string, templateId: string): number | null {
  const scorer = SCORERS[templateId];
  if (!scorer) return null;
  for (const s of summaries) {
    const p = findPlayer(s, player);
    if (!p) continue;
    if (p.dnp) return 0;
    const groups = allGroups(s);
    const team = s.box.find((t) => t.groups.some((g) => g.rows.some((r) => r.id === p.id)));
    const goalies = team?.groups.find((g) => g.labels.includes('SV%') && g.rows.some((r) => r.id === p.id));
    // ESPN doesn't flag NHL starters; the goalie who faced the most shots gets the decision.
    const sa = (r: StatRow) => (goalies ? Number(r.stats[goalies.labels.indexOf('SA')]) || 0 : 0);
    const busiest = goalies?.rows.reduce((best, r) => (sa(r) > sa(best) ? r : best));
    const ctx: ScoreContext = {
      won: !!team?.won,
      starter: goalies ? busiest?.id === p.id : p.starter,
      goalie: !!goalies,
    };
    const get = (ref: StatRef) => {
      for (const g of groups) {
        if (!groupMatches(g, ref)) continue;
        const row = g.rows.find((r) => r.id === p.id);
        if (row) return cell(row, g, ref);
      }
      return 0;
    };
    return Math.round(scorer(get, ctx) * 100) / 100;
  }
  return null;
}
