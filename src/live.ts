// In-game status for tracked selections: how close each leg is, and whether it's already decided.
import { fetchScoreboard, fetchSummary, type Game, type GameSummary, type LeagueKey } from './espn';
import { gradeSelection, isGradable, type Bet, type Selection } from './bets';
import { propStat, statValue } from './stats';

export type LiveState = 'upcoming' | 'live' | 'won' | 'lost' | 'push' | 'void';

export interface LegLive {
  sel: Selection;
  state: LiveState;
  text: string;
  progress?: number; // 0..1 toward cashing
  clock?: string;
  soon?: boolean; // upcoming and starting within the next 18 hours
}

const PERIODS: Partial<Record<LeagueKey, { n: number; mins: number }>> = {
  nba: { n: 4, mins: 12 },
  nhl: { n: 3, mins: 20 },
  nfl: { n: 4, mins: 15 },
  cfb: { n: 4, mins: 15 },
};

/** Share of regulation played, or null where the clock doesn't apply (MLB) or isn't known. */
export function elapsed(g: Game): number | null {
  const p = PERIODS[g.league];
  if (!p || !g.period || !g.clock) return null;
  const [m, s] = g.clock.split(':').map(Number);
  const left = (m || 0) + (s || 0) / 60;
  const done = (Math.min(g.period, p.n) - 1) * p.mins + (p.mins - left);
  return Math.max(0.02, Math.min(1, done / (p.n * p.mins)));
}

const clamp = (x: number) => Math.max(0, Math.min(1, x));
const fmt = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(1));

export function legLive(sel: Selection, g?: Game, summary?: GameSummary): LegLive {
  if (!g) return { sel, state: 'upcoming', text: 'Waiting for game data' };
  if (g.state === 'pre') {
    const start = new Date(g.start);
    const soon = start.getTime() - Date.now() < 18 * 3600_000;
    const when = soon
      ? start.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
      : start.toLocaleDateString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' });
    return { sel, state: 'upcoming', text: `Starts ${when}`, soon };
  }
  if (g.completed) {
    const r = gradeSelection(sel, g, summary);
    return r ? { sel, state: r.status as LiveState, text: r.finalScore ?? 'Final', progress: r.status === 'won' ? 1 : 0 } : { sel, state: 'live', text: 'Final, grading…' };
  }
  const clock = g.detail;
  const a = g.away.score ?? 0;
  const h = g.home.score ?? 0;
  const frac = elapsed(g);

  switch (sel.market) {
    case 'ml':
    case 'spread': {
      const margin = sel.side === 'home' ? h - a : a - h;
      const cover = margin + (sel.market === 'spread' ? sel.line ?? 0 : 0);
      const text =
        sel.market === 'ml'
          ? margin > 0 ? `Up ${margin}` : margin < 0 ? `Down ${-margin}` : 'Tied'
          : cover > 0 ? `Covering by ${fmt(cover)}` : cover < 0 ? `Need ${fmt(-cover)} more` : 'On the number';
      return { sel, state: 'live', text, progress: clamp(0.5 + cover / 20), clock };
    }
    case 'total': {
      const line = sel.line ?? 0;
      const total = a + h;
      const pace = frac ? total / frac : null;
      const paceText = pace ? ` · on pace for ${Math.round(pace)}` : '';
      // Bar sits at the middle when the pace is right on the line; ~8% either way fills or empties it.
      const lean = pace != null ? (pace - line) / Math.max(1, line * 0.16) : 0;
      if (sel.side === 'over') {
        if (total > line) return { sel, state: 'won', text: `Over cleared at ${total}`, progress: 1, clock };
        return { sel, state: 'live', text: `${total} now, need ${fmt(line - total + 0.5)} more${paceText}`, progress: clamp(0.5 + lean), clock };
      }
      if (total > line) return { sel, state: 'lost', text: `Went over at ${total}`, progress: 0, clock };
      return { sel, state: 'live', text: `${fmt(line - total)} to spare${paceText}`, progress: clamp(0.5 - lean), clock };
    }
    case 'prop': {
      const st = sel.league && sel.stat ? propStat(sel.league, sel.stat) : undefined;
      if (!st || sel.line == null) return { sel, state: 'live', text: 'In progress', clock };
      const v = summary ? statValue(summary, sel.player ?? '', st) ?? 0 : 0;
      const need = Math.floor(sel.line) + 1;
      const pace = frac ? v / frac : null;
      const paceText = pace != null && frac! < 0.95 ? ` · on pace for ${fmt(Math.round(pace * 10) / 10)}` : '';
      if (sel.side === 'under') {
        if (v > sel.line) return { sel, state: 'lost', text: `${v} ${st.label.toLowerCase()}, over the line`, progress: 0, clock };
        return { sel, state: 'live', text: `${v} so far, ${fmt(sel.line - v)} to spare${paceText}`, progress: clamp(1 - v / sel.line), clock };
      }
      if (v > sel.line) return { sel, state: 'won', text: `Hit: ${v} ${st.label.toLowerCase()}`, progress: 1, clock };
      return { sel, state: 'live', text: `${v} / ${need} ${st.label.toLowerCase()}${paceText}`, progress: clamp(v / need), clock };
    }
    default:
      return { sel, state: 'live', text: 'In progress', clock };
  }
}

export interface BetLive {
  bet: Bet;
  legs: LegLive[];
  won: number;
  lost: number;
  live: number;
  upcoming: number;
}

/** Live view of every pending bet that has a linked game today or in progress. */
export async function sweatBets(bets: Bet[]): Promise<BetLive[]> {
  const pending = bets.filter((b) => b.status === 'pending' && (b.legs ? b.legs.some(isGradable) : isGradable(b)));
  const sels = pending.flatMap((b) => b.legs ?? [b]).filter(isGradable);
  const games = new Map<string, Game>();
  await Promise.all(
    [...new Set(sels.map((s) => `${s.league}|${s.date}`))].map(async (k) => {
      const [league, date] = k.split('|') as [LeagueKey, string];
      try {
        for (const g of await fetchScoreboard(league, date)) games.set(g.id, g);
      } catch {
        /* show as waiting */
      }
    })
  );
  const summaries = new Map<string, GameSummary>();
  const propGames = new Set(sels.filter((s) => s.market === 'prop' && games.get(s.eventId!)?.state !== 'pre').map((s) => s.eventId!));
  await Promise.all(
    [...propGames].map(async (id) => {
      const g = games.get(id);
      if (!g) return;
      try {
        summaries.set(id, await fetchSummary(g.league, id));
      } catch {
        /* show without stats */
      }
    })
  );

  return pending
    .map((bet) => {
      const legs = (bet.legs ?? [bet]).map((s) =>
        'status' in s && s !== bet && s.status !== 'pending'
          ? { sel: s, state: s.status as LiveState, text: s.finalScore ?? s.status, progress: s.status === 'won' ? 1 : 0 }
          : isGradable(s)
            ? legLive(s, games.get(s.eventId!), summaries.get(s.eventId!))
            : { sel: s, state: 'upcoming' as LiveState, text: 'Grade by hand' }
      );
      const count = (st: LiveState[]) => legs.filter((l) => st.includes(l.state)).length;
      return { bet, legs, won: count(['won']), lost: count(['lost']), live: count(['live']), upcoming: count(['upcoming']) };
    })
    // Something is happening tonight: a leg is live or decided, or a game starts soon.
    .filter((b) => b.legs.some((l) => l.state !== 'upcoming' || l.soon))
    .sort((a, b) => (a.lost ? 1 : 0) - (b.lost ? 1 : 0) || b.live - a.live || a.legs.length - a.won - (b.legs.length - b.won));
}
