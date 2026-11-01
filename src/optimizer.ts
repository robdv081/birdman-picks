// DFS building blocks: salary-list parsing, market-built NBA projections, risk flags, and a salary-cap optimizer.
import type { PlayerProjection } from './market';

export interface SalaryRow {
  name: string;
  pos: string[];
  salary: number;
  team?: string;
  out?: boolean; // site marks the player O / OUT
  id?: string;
  avg?: number; // the site's season average (FanDuel FPPG, DraftKings AvgPointsPerGame)
  game?: string;
  opp?: string;
  status?: string;
  roster?: string[]; // roster slots the site lists for the player
}

function splitCsv(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (quoted && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else quoted = !quoted;
    } else if (ch === ',' && !quoted) {
      out.push(cur.trim());
      cur = '';
    } else cur += ch;
  }
  out.push(cur.trim());
  return out;
}

/**
 * Reads a FanDuel or DraftKings player-list CSV export, or plain "Name, POS, Salary[, Team]" lines.
 * FanDuel: Nickname / Position / Salary / Team / Injury Indicator. DraftKings: Name / Position / Salary / TeamAbbrev.
 */
export function parseSalaries(text: string): SalaryRow[] {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (!lines.length) return [];
  const header = splitCsv(lines[0]).map((h) => h.toLowerCase());
  const col = (...names: string[]) => names.map((n) => header.indexOf(n)).find((i) => i >= 0) ?? -1;
  const iSalary = col('salary');
  const iPos = col('position', 'pos');
  const hasHeader = iSalary >= 0 && iPos >= 0;
  const iName = hasHeader ? col('nickname', 'name', 'player') : 0;
  const iFirst = col('first name');
  const iLast = col('last name');
  const iTeam = col('team', 'teamabbrev');
  const iInj = col('injury indicator', 'status');
  const iId = col('id');
  const iAvg = col('fppg', 'avgpointspergame');
  const iGame = col('game', 'game info');
  const iOpp = col('opponent');
  const iRoster = col('roster position');

  const rows: SalaryRow[] = [];
  for (const line of hasHeader ? lines.slice(1) : lines) {
    const c = splitCsv(line);
    const name = hasHeader
      ? (iName >= 0 ? c[iName] : `${c[iFirst] ?? ''} ${c[iLast] ?? ''}`).trim()
      : c[0];
    const salary = Number(String(hasHeader ? c[iSalary] : c[2]).replace(/[$,]/g, ''));
    const pos = String(hasHeader ? c[iPos] : c[1] ?? '')
      .toUpperCase()
      .split('/')
      .map((p) => p.trim())
      .filter(Boolean);
    if (!name || !Number.isFinite(salary) || salary <= 0 || !pos.length) continue;
    const team = hasHeader ? (iTeam >= 0 ? c[iTeam] : undefined) : c[3];
    const inj = iInj >= 0 ? (c[iInj] ?? '').toUpperCase() : '';
    const at = (i: number) => (hasHeader && i >= 0 ? c[i] || undefined : undefined);
    const game = at(iGame)?.split(' ')[0];
    const [away, home] = game?.split('@') ?? [];
    rows.push({
      name,
      pos,
      salary,
      team: team || undefined,
      out: inj === 'O' || inj === 'OUT' || inj === 'IR',
      id: at(iId),
      avg: Number(at(iAvg)) || undefined,
      game,
      opp: at(iOpp) ?? (team && away && home ? (team === away ? home : away) : undefined),
      status: inj || undefined,
      roster: at(iRoster)?.split('/').map((r) => r.trim().toUpperCase()),
    });
  }
  return rows;
}

const ELIGIBLE: Record<string, string[]> = {
  G: ['PG', 'SG'],
  F: ['SF', 'PF'],
  'G/F': ['PG', 'SG', 'SF'],
  'F/C': ['SF', 'PF', 'C'],
  UTIL: ['PG', 'SG', 'SF', 'PF', 'C'],
};

export const canFill = (slot: string, pos: string[]) => (ELIGIBLE[slot] ?? [slot]).some((p) => pos.includes(p));

/** Projected DFS points from projected stats. DraftKings' double-double bonus uses the book's double-double price. */
export function projectPoints(p: Pick<PlayerProjection, 'mean' | 'ddProb'>, templateId: string): number {
  const m = p.mean;
  const v = (k: string) => m[k] ?? 0;
  if (templateId === 'dk-nba')
    return v('pts') + 0.5 * v('3pm') + 1.25 * v('reb') + 1.5 * v('ast') + 2 * v('stl') + 2 * v('blk') - 0.5 * v('to') + 1.5 * p.ddProb;
  return v('pts') + 1.2 * v('reb') + 1.5 * v('ast') + 3 * v('stl') + 3 * v('blk') - v('to');
}

export type Risk = 'no-market' | 'low-minutes' | 'volatile' | 'gtd' | 'doubtful' | 'backup-goalie';

export const RISK_LABEL: Record<Risk, string> = {
  'no-market': 'No props posted',
  'low-minutes': 'Low minutes',
  volatile: 'Minutes swing',
  gtd: 'Questionable',
  doubtful: 'Doubtful',
  'backup-goalie': 'Likely backup goalie',
};

export interface PoolPlayer {
  key: string;
  name: string;
  team: string;
  pos: string[];
  salary: number;
  proj: number;
  risks: Risk[];
  slots?: string[]; // roster slots the player can fill; falls back to canFill(pos)
  opp?: string;
  game?: string;
}

/** Lineup rules beyond slots and cap. `partial` prunes while building; `valid` judges a full lineup. */
export interface Rules {
  partial?: (picks: PoolPlayer[]) => boolean;
  valid?: (picks: PoolPlayer[]) => boolean;
}

const fitsSlot = (p: PoolPlayer, slot: string) => (p.slots ? p.slots.includes(slot) : canFill(slot, p.pos));

export interface Optimized {
  slots: { slot: string; player: PoolPlayer }[];
  salary: number;
  proj: number;
}

/**
 * Best lineup found under the cap: randomized greedy starts, each polished by single and paired swaps.
 * Locked players are placed first. Heuristic, not a proof of optimality; against exhaustive search on three
 * real ~38-player DraftKings pools it found the exact best lineup in 15 of 15 runs.
 */
export function optimize(
  pool: PoolPlayer[],
  slotNames: string[],
  cap: number,
  locked: Set<string>,
  restarts = 400,
  rules: Rules = {}
): Optimized | null {
  const n = slotNames.length;
  const eligible = slotNames.map((s) => pool.filter((p) => fitsSlot(p, s)).sort((a, b) => b.proj - a.proj));
  const partialOk = (picks: (PoolPlayer | null)[]) => !rules.partial || rules.partial(picks.filter((p): p is PoolPlayer => !!p));
  const validOk = (picks: PoolPlayer[]) => !rules.valid || rules.valid(picks);
  if (eligible.some((e) => !e.length)) return null;
  // Cheapest player each slot could take: what must stay in the budget for slots not yet filled.
  const slotMin = eligible.map((e) => Math.min(...e.map((p) => p.salary)));
  const order = slotNames.map((_, i) => i).sort((a, b) => eligible[a].length - eligible[b].length);

  const score = (picks: (PoolPlayer | null)[]) => picks.reduce((s, p) => s + (p?.proj ?? 0), 0);
  const cost = (picks: (PoolPlayer | null)[]) => picks.reduce((s, p) => s + (p?.salary ?? 0), 0);

  /** A starting lineup: best projection per slot (or, with `cheap`, lowest salary) while leaving room for the rest. */
  function seed(noise: number, cheap = false): (PoolPlayer | null)[] | null {
    const picks: (PoolPlayer | null)[] = Array(n).fill(null);
    const used = new Set<string>();
    // Locked players go to the tightest slot that takes them.
    for (const key of locked) {
      const p = pool.find((x) => x.key === key);
      const i = p && order.find((j) => !picks[j] && fitsSlot(p, slotNames[j]));
      if (!p || i == null) return null;
      picks[i] = p;
      used.add(key);
    }
    for (const i of order) {
      if (picks[i]) continue;
      const reserve = picks.reduce((s, p, j) => s + (!p && j !== i ? slotMin[j] : 0), 0);
      const budget = cap - cost(picks) - reserve;
      let best: PoolPlayer | null = null;
      let bestScore = -Infinity;
      for (const p of eligible[i]) {
        if (used.has(p.key) || p.salary > budget) continue;
        if (rules.partial) {
          picks[i] = p;
          const ok = partialOk(picks);
          picks[i] = null;
          if (!ok) continue;
        }
        const s = (cheap ? -p.salary : p.proj) * (1 + (Math.random() * 2 - 1) * noise);
        if (s > bestScore) {
          bestScore = s;
          best = p;
        }
      }
      if (!best) return null;
      picks[i] = best;
      used.add(best.key);
    }
    return picks;
  }

  function polish(picks: PoolPlayer[]) {
    let improved = true;
    while (improved) {
      improved = false;
      const used = new Set(picks.map((p) => p.key));
      const spend = cost(picks);
      // Single swaps
      for (let i = 0; i < n; i++) {
        if (locked.has(picks[i].key)) continue;
        for (const p of eligible[i]) {
          if (p.proj <= picks[i].proj) break; // sorted by projection
          if (used.has(p.key) || spend - picks[i].salary + p.salary > cap) continue;
          const prev = picks[i];
          picks[i] = p;
          if (!validOk(picks)) {
            picks[i] = prev;
            continue;
          }
          used.delete(prev.key);
          used.add(p.key);
          improved = true;
          break;
        }
        if (improved) break;
      }
      if (improved) continue;
      // Paired swaps: downgrade one slot to afford an upgrade in another.
      outer: for (let i = 0; i < n; i++) {
        for (let j = i + 1; j < n; j++) {
          if (locked.has(picks[i].key) || locked.has(picks[j].key)) continue;
          const base = picks[i].proj + picks[j].proj;
          const room = cap - spend + picks[i].salary + picks[j].salary;
          for (const a of eligible[i].slice(0, 40)) {
            if (used.has(a.key) && a !== picks[i]) continue;
            for (const b of eligible[j].slice(0, 40)) {
              if (b === a || (used.has(b.key) && b !== picks[j])) continue;
              if (a.salary + b.salary <= room && a.proj + b.proj > base + 1e-9) {
                const [pa, pb] = [picks[i], picks[j]];
                picks[i] = a;
                picks[j] = b;
                if (!validOk(picks)) {
                  picks[i] = pa;
                  picks[j] = pb;
                  continue;
                }
                improved = true;
                break outer;
              }
            }
          }
        }
      }
    }
    return picks;
  }

  let best: PoolPlayer[] | null = null;
  for (let r = 0; r < restarts; r++) {
    // If the greedy start paints itself into a corner, start from a cheap legal lineup and let polish upgrade it.
    const noise = r === 0 ? 0 : 0.25;
    const s = seed(noise) ?? seed(noise, true);
    if (!s) continue;
    const p = polish(s as PoolPlayer[]);
    if (!validOk(p)) continue;
    if (!best || score(p) > score(best)) best = [...p];
  }
  if (!best) return null;
  return { slots: best.map((player, i) => ({ slot: slotNames[i], player })), salary: cost(best), proj: score(best) };
}
