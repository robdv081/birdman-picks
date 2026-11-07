// Saved projection snapshots, so the report card can grade them after the games and late swap can reuse them.
import { fetchScoreboard, fetchSummary, type Game, type GameSummary, type LeagueKey } from './espn';
import { toEspn, type DfsPlayer, type Site, type Slate, type Sport } from './dfs';
import { fantasyPoints } from './stats';
import { load, save, shiftYMD } from './store';

export interface SnapPlayer {
  id: string;
  name: string;
  team: string;
  opp?: string;
  pos: string[];
  slots: string[];
  salary: number;
  proj: number;
  ceiling: number;
}

export interface Snapshot {
  slateId: string;
  label: string;
  sport: Sport;
  site: Site;
  templateId: string;
  cap: number;
  slots: string[];
  date: string; // slate day, YYYY-MM-DD
  savedAt: string;
  players: SnapPlayer[];
}

const KEY = 'bp.projections';
const KEEP = 30;

export const loadSnapshots = (): Snapshot[] => load<Snapshot[]>(KEY, []);

/** Saves (or replaces) the snapshot for a slate. Keeps only players with a projection, to stay small. */
export function saveSnapshot(slate: Slate, templateId: string, players: DfsPlayer[]) {
  const snap: Snapshot = {
    slateId: slate.id,
    label: slate.label,
    sport: slate.sport,
    site: slate.site,
    templateId,
    cap: slate.cap,
    slots: slate.slots,
    date: slate.start?.slice(0, 10) ?? new Date().toISOString().slice(0, 10),
    savedAt: new Date().toISOString(),
    players: players
      .filter((p) => !p.out && p.proj > 0)
      .map((p) => ({ id: p.id, name: p.name, team: p.team, opp: p.opp, pos: p.pos, slots: p.slots, salary: p.salary, proj: p.proj, ceiling: p.ceiling })),
  };
  // A pasted FanDuel list has no slate id of its own; key it by day and sport.
  if (slate.id.endsWith('-paste')) snap.slateId = `${slate.id}-${slate.sport}-${snap.date}`;
  const rest = loadSnapshots().filter((s) => s.slateId !== snap.slateId);
  save(KEY, [snap, ...rest].slice(0, KEEP));
  return snap.slateId;
}

export interface Graded {
  name: string;
  team: string;
  pos: string;
  salary: number;
  proj: number;
  actual: number;
}

export interface ReportCard {
  finals: number;
  games: number;
  graded: Graded[];
  mae: number;
  bias: number; // mean of projection minus actual: positive = projections ran high
  corr: number;
  byPos: { pos: string; n: number; mae: number; bias: number }[];
  topHit: number; // of the 10 highest projections, how many beat their projection
}

const mean = (a: number[]) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);

function pearson(x: number[], y: number[]) {
  const mx = mean(x);
  const my = mean(y);
  let num = 0;
  let dx = 0;
  let dy = 0;
  x.forEach((xi, i) => {
    num += (xi - mx) * (y[i] - my);
    dx += (xi - mx) ** 2;
    dy += (y[i] - my) ** 2;
  });
  return dx && dy ? num / Math.sqrt(dx * dy) : 0;
}

/** Box scores for the slate's day; NFL also takes the next day, for Sunday–Monday slates. */
export async function slateSummaries(snap: Snapshot): Promise<{ summaries: GameSummary[]; games: Game[] }> {
  const league = snap.sport as LeagueKey;
  const teams = new Set(snap.players.map((p) => toEspn(snap.sport, p.team)));
  // Other sports play daily, so the next day would score back-to-back games as if they were this slate's.
  const days = snap.sport === 'nfl' ? [snap.date, shiftYMD(snap.date, 1)] : [snap.date];
  const games = (await Promise.all(days.map((d) => fetchScoreboard(league, d).catch(() => [] as Game[]))))
    .flat()
    .filter((g) => teams.has(g.home.abbr) || teams.has(g.away.abbr));
  const finals = games.filter((g) => g.completed);
  const summaries = await Promise.all(finals.map((g) => fetchSummary(league, g.id).catch(() => null)));
  return { summaries: summaries.filter((s): s is GameSummary => !!s), games };
}

/** Grades a snapshot's projections against what happened. Team defenses aren't scored from box scores, so they're left out. */
export async function gradeSnapshot(snap: Snapshot): Promise<ReportCard> {
  const { summaries, games } = await slateSummaries(snap);
  const graded: Graded[] = [];
  for (const p of snap.players) {
    const actual = fantasyPoints(summaries, p.name, snap.templateId);
    if (actual == null) continue;
    graded.push({ name: p.name, team: p.team, pos: p.pos[0], salary: p.salary, proj: p.proj, actual });
  }
  const err = graded.map((g) => g.proj - g.actual);
  const positions = [...new Set(graded.map((g) => g.pos))];
  const top10 = [...graded].sort((a, b) => b.proj - a.proj).slice(0, 10);
  return {
    finals: games.filter((g) => g.completed).length,
    games: games.length,
    graded,
    mae: mean(err.map(Math.abs)),
    bias: mean(err),
    corr: pearson(graded.map((g) => g.proj), graded.map((g) => g.actual)),
    byPos: positions
      .map((pos) => {
        const e = graded.filter((g) => g.pos === pos).map((g) => g.proj - g.actual);
        return { pos, n: e.length, mae: mean(e.map(Math.abs)), bias: mean(e) };
      })
      .sort((a, b) => b.n - a.n),
    topHit: top10.filter((g) => g.actual >= g.proj).length,
  };
}
