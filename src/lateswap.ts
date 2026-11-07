// Late swap: for a saved generated lineup, find players ruled out whose games haven't started and suggest
// the best replacement still available at that slot within the remaining salary.
import { fetchInjuries, fetchScoreboard, type Game, type Injury, type LeagueKey } from './espn';
import { loadDkSlates, toEspn } from './dfs';
import type { Lineup } from './fantasy';
import { loadSnapshots, type SnapPlayer } from './snapshots';
import { sameName } from './stats';
import { shiftYMD } from './store';

export type SwapState = 'ok' | 'locked' | 'out' | 'questionable' | 'unknown';

export interface SwapCheck {
  index: number;
  slot: string;
  player: string;
  state: SwapState;
  reason?: string;
  suggestion?: SnapPlayer;
}

const OUT = ['O', 'OUT', 'IR', 'NA', 'SUSP'];
const QUESTIONABLE = ['Q', 'D', 'DTD', 'GTD'];

export async function checkLateSwap(l: Lineup): Promise<{ checks: SwapCheck[]; note?: string }> {
  const snap = loadSnapshots().find((s) => s.slateId === l.slateId);
  if (!snap) return { checks: [], note: 'Late swap works on lineups saved from the generator, which keeps their projections.' };
  const league = snap.sport as LeagueKey;

  const [games, injuries, dk] = await Promise.all([
    Promise.all((snap.sport === 'nfl' ? [snap.date, shiftYMD(snap.date, 1)] : [snap.date]).map((d) => fetchScoreboard(league, d).catch(() => [] as Game[]))).then((x) => x.flat()),
    fetchInjuries(league).catch(() => ({} as Record<string, Injury[]>)),
    snap.site === 'dk' ? loadDkSlates() : Promise.resolve({ slates: [] }),
  ]);
  const gameOf = (team: string) => {
    const t = toEspn(snap.sport, team);
    return games.find((g) => g.home.abbr === t || g.away.abbr === t);
  };
  const started = (team: string) => {
    const g = gameOf(team);
    return !!g && g.state !== 'pre';
  };
  const dkSlate = dk.slates.find((s) => s.id === snap.slateId);
  const injuryList = Object.values(injuries).flat();
  // The freshest word on each player: DraftKings' status (refreshed every 30 minutes) or ESPN's injury report.
  const statusOf = (name: string): { state: 'out' | 'questionable' | null; why?: string } => {
    const dkStatus = dkSlate?.players.find((p) => sameName(p.name, name))?.status?.toUpperCase();
    if (dkStatus && OUT.includes(dkStatus)) return { state: 'out', why: `DraftKings lists him ${dkStatus}` };
    const inj = injuryList.find((i) => sameName(i.player, name));
    if (inj?.severity === 'out') return { state: 'out', why: `ESPN: ${inj.status}${inj.detail ? ` (${inj.detail})` : ''}` };
    if (dkStatus && QUESTIONABLE.includes(dkStatus)) return { state: 'questionable', why: `DraftKings lists him ${dkStatus}` };
    if (inj) return { state: 'questionable', why: `ESPN: ${inj.status}` };
    return { state: null };
  };

  const inLineup = new Set(l.slots.map((s) => s.player).filter(Boolean));
  const spent = l.slots.reduce((s, x) => s + (x.salary ?? 0), 0);
  const replacement = (slot: string, freed: number) =>
    snap.players
      .filter(
        (p) =>
          p.slots.includes(slot) &&
          ![...inLineup].some((n) => sameName(n, p.name)) &&
          !started(p.team) &&
          statusOf(p.name).state !== 'out' &&
          p.salary <= snap.cap - spent + freed
      )
      .sort((a, b) => b.proj - a.proj)[0];

  const checks: SwapCheck[] = l.slots.map((s, index) => {
    const base = { index, slot: s.slot, player: s.player };
    if (!s.player) return { ...base, state: 'unknown' as const, reason: 'Empty slot' };
    const p = snap.players.find((x) => sameName(x.name, s.player));
    const team = p?.team ?? s.team.split(' ')[0];
    if (team && started(team)) return { ...base, state: 'locked' as const, reason: 'Game has started' };
    const st = statusOf(s.player);
    if (st.state === 'out') return { ...base, state: 'out' as const, reason: st.why, suggestion: replacement(s.slot, s.salary ?? 0) };
    if (st.state === 'questionable') return { ...base, state: 'questionable' as const, reason: st.why, suggestion: replacement(s.slot, s.salary ?? 0) };
    return { ...base, state: p ? ('ok' as const) : ('unknown' as const), reason: p ? undefined : 'Not in the saved projections' };
  });
  return { checks };
}
