// Multi-lineup DFS generator: contest style, stacking and conflict rules, uniqueness and exposure caps,
// on top of the salary-cap optimizer.
import type { DfsPlayer, Site, Sport } from './dfs';
import { optimize, type PoolPlayer, type Risk, type Rules } from './optimizer';

export type ContestStyle = 'cash' | 'gpp';

export interface GenOptions {
  sport: Sport;
  site: Site;
  slots: string[];
  cap: number;
  style: ContestStyle;
  count: number;
  maxExposure: number; // 0–1 share of lineups any one player may appear in
  locked: Set<string>;
  excluded: Set<string>;
  avoidRisk: boolean; // skip rotation risks (NBA minutes, NHL backup goalies, doubtful players)
  stack: boolean; // NFL: QB + pass catcher; NHL: two skaters from one team
  bringBack: boolean; // NFL: one player from the QB's opponent
  noOpposingDefense: boolean; // NFL: no offense vs. own DST; NHL: no skaters vs. own goalie
}

export interface GenLineup {
  slots: { slot: string; player: DfsPlayer }[];
  proj: number;
  ceiling: number;
  salary: number;
}

const ROTATION_RISKS: Risk[] = ['low-minutes', 'volatile', 'no-market', 'backup-goalie', 'doubtful'];
const MIN_DIFFERENT = 2; // players that must differ between any two lineups
const PRUNE_TOP = 28; // per slot, by score
const PRUNE_VALUE = 14; // per slot, by points per dollar

const isDst = (p: PoolPlayer, sport: Sport) => sport === 'nfl' && p.pos.some((x) => x === 'DST' || x === 'D' || x === 'DEF');
const isGoalie = (p: PoolPlayer, sport: Sport) => sport === 'nhl' && p.pos.includes('G');
const isPassCatcher = (p: PoolPlayer) => p.pos.includes('WR') || p.pos.includes('TE');

/** Gaussian noise (Box–Muller), for varied but sensible alternate lineups. */
const gauss = () => Math.sqrt(-2 * Math.log(1 - Math.random())) * Math.cos(2 * Math.PI * Math.random());

function rulesFor(o: GenOptions, previous: Set<string>[]): Rules {
  const maxTeam = o.site === 'fd' ? 4 : Infinity; // FanDuel caps players per team at 4
  const conflicts = (picks: PoolPlayer[]) => {
    if (!o.noOpposingDefense) return false;
    const guards = picks.filter((p) => isDst(p, o.sport) || isGoalie(p, o.sport));
    return guards.some((g) => picks.some((p) => p !== g && !isDst(p, o.sport) && !isGoalie(p, o.sport) && p.team === g.opp));
  };
  const perTeamOk = (picks: PoolPlayer[]) => {
    if (maxTeam === Infinity) return true;
    const c = new Map<string, number>();
    for (const p of picks) c.set(p.team, (c.get(p.team) ?? 0) + 1);
    return [...c.values()].every((n) => n <= maxTeam);
  };
  return {
    partial: (picks) => perTeamOk(picks) && !conflicts(picks),
    valid: (picks) => {
      if (!perTeamOk(picks) || conflicts(picks)) return false;
      // Both sites require players from at least two different games.
      const games = new Set(picks.map((p) => p.game).filter(Boolean));
      if (games.size && games.size < 2) return false;
      const keys = picks.map((p) => p.key);
      return previous.every((prev) => keys.filter((k) => !prev.has(k)).length >= MIN_DIFFERENT);
    },
  };
}

/** Builds up to `count` distinct lineups. Yields to the browser between lineups so progress can paint. */
export async function generate(players: DfsPlayer[], o: GenOptions, onProgress: (msg: string) => void): Promise<GenLineup[]> {
  const byKey = new Map(players.map((p) => [p.key, p]));
  const usable = players.filter(
    (p) =>
      o.locked.has(p.key) ||
      (!p.out && !o.excluded.has(p.key) && p.proj > 0 && !(o.avoidRisk && p.risks.some((r) => ROTATION_RISKS.includes(r))))
  );
  // Tournaments chase upside: lean on the ceiling as well as the median.
  const score = (p: DfsPlayer) => (o.style === 'gpp' ? p.proj + 0.35 * (p.ceiling - p.proj) : p.proj);

  // Keep the realistic options per slot so each optimizer pass stays fast.
  const keep = new Set(o.locked);
  for (const slot of new Set(o.slots)) {
    const fit = usable.filter((p) => p.slots.includes(slot));
    [...fit].sort((a, b) => score(b) - score(a)).slice(0, PRUNE_TOP).forEach((p) => keep.add(p.key));
    [...fit].sort((a, b) => score(b) / b.salary - score(a) / a.salary).slice(0, PRUNE_VALUE).forEach((p) => keep.add(p.key));
  }
  const base = usable.filter((p) => keep.has(p.key));

  const lineups: GenLineup[] = [];
  const previous: Set<string>[] = [];
  const uses = new Map<string, number>();
  const cap = Math.max(1, Math.floor(o.maxExposure * o.count + 1e-9));
  const noise = o.style === 'gpp' ? 0.12 : 0.04;

  for (let k = 0; k < o.count; k++) {
    onProgress(`Building lineup ${k + 1} of ${o.count}…`);
    await new Promise((r) => setTimeout(r, 0));
    let found: GenLineup | null = null;
    for (let attempt = 0; attempt < 6 && !found; attempt++) {
      const jitter = k === 0 && attempt === 0 ? 0 : noise * (1 + attempt * 0.5);
      const pool: PoolPlayer[] = base
        .filter((p) => o.locked.has(p.key) || (uses.get(p.key) ?? 0) < cap)
        .map((p) => ({
          key: p.key,
          name: p.name,
          team: p.team,
          pos: p.pos,
          salary: p.salary,
          slots: p.slots,
          opp: p.opp,
          game: p.game,
          risks: p.risks,
          proj: Math.max(0.1, score(p) * (1 + gauss() * jitter)),
        }));
      const rules = rulesFor(o, previous);
      const result = pickBest(pool, o, rules);
      if (!result) continue;
      const picks = result.slots.map((s) => ({ slot: s.slot, player: byKey.get(s.player.key)! }));
      found = {
        slots: picks,
        proj: picks.reduce((s, x) => s + x.player.proj, 0),
        ceiling: picks.reduce((s, x) => s + x.player.ceiling, 0),
        salary: picks.reduce((s, x) => s + x.player.salary, 0),
      };
    }
    if (!found) break;
    lineups.push(found);
    previous.push(new Set(found.slots.map((s) => s.player.key)));
    for (const s of found.slots) uses.set(s.player.key, (uses.get(s.player.key) ?? 0) + 1);
  }
  return lineups;
}

/** One optimized lineup, trying stack combinations where the rules call for them. */
function pickBest(pool: PoolPlayer[], o: GenOptions, rules: Rules) {
  const run = (locks: Set<string>, restarts: number, extra?: Rules['valid']) =>
    optimize(pool, o.slots, o.cap, locks, restarts, extra ? { partial: rules.partial, valid: (p) => rules.valid!(p) && extra(p) } : rules);

  if (!o.stack || (o.sport !== 'nfl' && o.sport !== 'nhl')) return run(o.locked, 200);

  // Try the best few stack anchors with forced partners, keep the best lineup found.
  const combos: string[][] = [];
  if (o.sport === 'nfl') {
    const qbs = pool.filter((p) => p.pos.includes('QB')).sort((a, b) => b.proj - a.proj).slice(0, 6);
    for (const qb of qbs) {
      const mates = pool.filter((p) => p.team === qb.team && isPassCatcher(p)).sort((a, b) => b.proj - a.proj).slice(0, 3);
      for (const m of mates) combos.push([qb.key, m.key]);
    }
  } else {
    const teams = [...new Set(pool.filter((p) => !isGoalie(p, o.sport)).map((p) => p.team))];
    for (const t of teams) {
      const sk = pool.filter((p) => p.team === t && !isGoalie(p, o.sport)).sort((a, b) => b.proj - a.proj).slice(0, 2);
      if (sk.length === 2) combos.push(sk.map((p) => p.key));
    }
    combos.sort((a, b) => sumProj(pool, b) - sumProj(pool, a)).splice(8);
  }

  const bringBack =
    o.sport === 'nfl' && o.bringBack
      ? (picks: PoolPlayer[]) => {
          const qb = picks.find((p) => p.pos.includes('QB'));
          return !qb || picks.some((p) => p.team === qb.opp && !isDst(p, o.sport));
        }
      : undefined;

  let best: ReturnType<typeof optimize> = null;
  for (const c of combos) {
    const r = run(new Set([...o.locked, ...c]), 50, bringBack);
    if (r && (!best || r.proj > best.proj)) best = r;
  }
  return best ?? run(o.locked, 200, bringBack);
}

const sumProj = (pool: PoolPlayer[], keys: string[]) => keys.reduce((s, k) => s + (pool.find((p) => p.key === k)?.proj ?? 0), 0);

/** DraftKings bulk-upload CSV: one header row of slot names, then one row of player IDs per lineup. */
export function dkUploadCsv(slots: string[], lineups: GenLineup[]): string {
  return [slots.join(','), ...lineups.map((l) => l.slots.map((s) => s.player.id).join(','))].join('\n');
}
