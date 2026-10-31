// Injury ripple: how teammates have produced in games the injured player missed, vs. games he played.
import { fetchGamelog, fetchPropBets, fetchRoster, ladderMean, milestoneRungs, NBA_STAT_COLS, pool, totalLines, type GameRow } from './market';
import { sameName } from './stats';

const STATS = ['pts', 'reb', 'ast', 'min'] as const;
type Stat = (typeof STATS)[number];
const MIN_GAMES = 3;

export interface RippleRow {
  athleteId: string;
  name: string;
  withN: number;
  withoutN: number;
  with: Record<Stat, number>;
  without: Record<Stat, number>;
  deltaFp: number; // FanDuel points per game, without minus with
  marketPts?: number; // tonight's points projection from the prop market
}

export interface Ripple {
  injured: string;
  missed: number;
  played: number;
  rows: RippleRow[];
  note?: string;
}

const avg = (rows: GameRow[], stat: Stat) => (rows.length ? rows.reduce((s, r) => s + (r.vals[NBA_STAT_COLS[stat]] ?? 0), 0) / rows.length : 0);
const fdPerGame = (rows: GameRow[]) => {
  const v = (k: string) => (rows.length ? rows.reduce((s, r) => s + (r.vals[NBA_STAT_COLS[k]] ?? 0), 0) / rows.length : 0);
  return v('pts') + 1.2 * v('reb') + 1.5 * v('ast') + 3 * v('stl') + 3 * v('blk') - v('to');
};

/** NBA only. Uses this season and last, limited to games since the injured player joined the team. */
export async function injuryRipple(teamId: string, injuredName: string, gameId?: string): Promise<Ripple> {
  const roster = await fetchRoster('nba', teamId);
  const injured = roster.find((p) => sameName(p.name, injuredName));
  if (!injured) return { injured: injuredName, missed: 0, played: 0, rows: [], note: `${injuredName} isn't on the current roster.` };

  const hisGames = (await fetchGamelog('nba', injured.id, Infinity)).filter((r) => r.teamId === teamId);
  if (!hisGames.length)
    return { injured: injured.name, missed: 0, played: 0, rows: [], note: `${injured.name} hasn't played for this team yet, so there's nothing to compare.` };
  const played = new Set(hisGames.map((r) => r.id));
  const since = hisGames[hisGames.length - 1].date;

  const items = gameId ? await fetchPropBets('nba', gameId).catch(() => []) : [];
  const lines = totalLines('nba', items);
  const rungs = milestoneRungs('nba', items);
  const marketPts = (id: string) => {
    const line = lines.get(`${id}|pts`);
    if (line != null) return line;
    const ladder = rungs.filter((r) => r.athleteId === id && r.def.stat === 'pts');
    return ladder.length >= 2 ? ladderMean(ladder) : undefined;
  };

  const rows: RippleRow[] = [];
  let missed = 0;
  await pool(
    roster.filter((p) => p.id !== injured.id),
    6,
    async (p) => {
      const games = (await fetchGamelog('nba', p.id, Infinity).catch(() => [] as GameRow[])).filter((r) => r.teamId === teamId && r.date >= since);
      const withHim = games.filter((r) => played.has(r.id));
      const without = games.filter((r) => !played.has(r.id));
      missed = Math.max(missed, without.length);
      if (withHim.length < MIN_GAMES || without.length < MIN_GAMES) return;
      const pick = (list: GameRow[]) => Object.fromEntries(STATS.map((s) => [s, avg(list, s)])) as Record<Stat, number>;
      rows.push({
        athleteId: p.id,
        name: p.name,
        withN: withHim.length,
        withoutN: without.length,
        with: pick(withHim),
        without: pick(without),
        deltaFp: fdPerGame(without) - fdPerGame(withHim),
        marketPts: marketPts(p.id),
      });
    }
  );

  rows.sort((a, b) => b.deltaFp - a.deltaFp);
  return {
    injured: injured.name,
    missed,
    played: hisGames.length,
    rows: rows.slice(0, 6),
    note: rows.length ? undefined : `Not enough games without ${injured.name} to compare yet.`,
  };
}
