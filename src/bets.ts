import type { Game, GameSummary, LeagueKey } from './espn';
import { propStat, statValue } from './stats';

export type Market = 'ml' | 'spread' | 'total' | 'parlay' | 'prop' | 'other';
export type BetSide = 'home' | 'away' | 'over' | 'under';
export type BetStatus = 'pending' | 'won' | 'lost' | 'push' | 'void';

/** One priced outcome: a straight bet, or a leg of a parlay. */
export interface Selection {
  date: string; // YYYY-MM-DD the game is played
  selection: string;
  market: Market;
  odds: number; // American
  // Present when created from a game; enables auto-grading.
  league?: LeagueKey;
  eventId?: string;
  matchup?: string;
  side?: BetSide;
  line?: number;
  player?: string; // props
  stat?: string; // props: key into PROP_STATS
  finalScore?: string;
  /** How far the result landed from the line, in the stat's units; positive means it cleared. */
  margin?: number;
  /** DraftKings' closing price and line for this side, for closing line value. */
  closeOdds?: number;
  closeLine?: number;
  closeChecked?: boolean;
}

export interface Leg extends Selection {
  status: BetStatus;
}

export interface Bet extends Selection {
  id: string;
  createdAt: string;
  stake: number; // units
  status: BetStatus;
  book?: string;
  notes?: string;
  legs?: Leg[];
  /** Payout price after push/void legs drop out of a parlay. */
  settledOdds?: number;
}

export const MARKET_LABEL: Record<Market, string> = {
  ml: 'Moneyline',
  spread: 'Spread',
  total: 'Total',
  parlay: 'Parlay',
  prop: 'Player prop',
  other: 'Other',
};

export const toDecimal = (a: number) => (a > 0 ? 1 + a / 100 : 1 + 100 / Math.abs(a));
export const toAmerican = (d: number) => (d >= 2 ? Math.round((d - 1) * 100) : Math.round(-100 / (d - 1)));
export const breakEven = (a: number) => 1 / toDecimal(a);
export const fmtAmerican = (a?: number) => (a == null ? '—' : a > 0 ? `+${a}` : `${a}`);
export const fmtLine = (n?: number) => (n == null ? '' : n > 0 ? `+${n}` : `${n}`);
export const fmtPct = (p: number) => `${(p * 100).toFixed(1)}%`;
export const fmtUnits = (u: number) => `${u > 0 ? '+' : ''}${u.toFixed(2)}u`;
export const fmtMoney = (n: number, sign = false) =>
  `${sign && n > 0 ? '+' : n < 0 ? '−' : ''}$${Math.abs(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export const parlayOdds = (legs: Pick<Leg, 'odds'>[]) => toAmerican(legs.reduce((p, l) => p * toDecimal(l.odds), 1));

export function profit(b: Bet): number {
  if (b.status === 'won') return b.stake * (toDecimal(b.settledOdds ?? b.odds) - 1);
  if (b.status === 'lost') return -b.stake;
  return 0;
}

export function newId() {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

export function propLabel(s: Pick<Selection, 'league' | 'player' | 'stat' | 'side' | 'line'>) {
  const st = s.league && s.stat ? propStat(s.league, s.stat) : undefined;
  const line = s.line != null && Number.isFinite(s.line) ? s.line : '';
  return `${s.player || 'Player'} ${s.side === 'under' ? 'Under' : 'Over'} ${line} ${st?.label ?? ''}`.replace(/\s+/g, ' ').trim();
}

/** Can the app settle this on its own from ESPN data? */
export function isGradable(s: Selection) {
  if (!s.eventId || !s.league) return false;
  if (s.market === 'prop') return !!(s.player && s.stat && s.line != null && s.side);
  return s.market === 'ml' || s.market === 'spread' || s.market === 'total';
}

/** Settled status once the linked game is final, or null if it can't be graded yet. Props need the box score. */
export function gradeSelection(s: Selection, g: Game, summary?: GameSummary): Pick<Leg, 'status' | 'finalScore' | 'margin'> | null {
  if (!g.completed || g.away.score == null || g.home.score == null) return null;
  const a = g.away.score;
  const h = g.home.score;
  let margin: number;
  let finalScore = `${g.away.abbr} ${a} – ${g.home.abbr} ${h}`;
  switch (s.market) {
    case 'ml':
      margin = s.side === 'home' ? h - a : a - h;
      break;
    case 'spread':
      if (s.line == null) return null;
      margin = (s.side === 'home' ? h - a : a - h) + s.line;
      break;
    case 'total':
      if (s.line == null) return null;
      margin = s.side === 'over' ? a + h - s.line : s.line - (a + h);
      break;
    case 'prop': {
      const st = s.league && s.stat ? propStat(s.league, s.stat) : undefined;
      if (!summary || !st || !s.player || s.line == null) return null;
      const v = statValue(summary, s.player, st);
      // Not in the box score or didn't play: books void these.
      if (v == null) return { status: 'void', finalScore: `${s.player} did not play`, margin: undefined };
      finalScore = `${s.player}: ${v} ${st.label.toLowerCase()}`;
      margin = s.side === 'under' ? s.line - v : v - s.line;
      break;
    }
    default:
      return null;
  }
  return { status: margin > 0 ? 'won' : margin < 0 ? 'lost' : 'push', finalScore, margin: Math.round(margin * 10) / 10 };
}

/**
 * Closing line value for one side. With the same line it's the change in break-even probability
 * (positive = you got a better price than the close); with a moved line it's the points gained.
 */
export function clv(s: Selection): { beat: boolean; prob?: number; points?: number } | null {
  if (s.closeOdds == null || s.closeOdds === 0) return null;
  const sameLine = s.line == null || s.closeLine == null || s.closeLine === s.line;
  if (sameLine) {
    const prob = breakEven(s.closeOdds) - breakEven(s.odds);
    return { beat: prob > 0, prob };
  }
  // Spread lines are quoted for your side (+6.5 beats +5.5); for totals, a lower over / higher under is better.
  const points =
    s.market === 'total' || s.market === 'prop'
      ? s.side === 'under'
        ? s.line! - s.closeLine!
        : s.closeLine! - s.line!
      : s.line! - s.closeLine!;
  return { beat: points > 0, points };
}

/** A parlay loses on any losing leg; otherwise it settles when every leg is in, dropping pushes and voids. */
export function settleParlay(b: Bet, legs: Leg[]): Pick<Bet, 'status' | 'settledOdds'> | null {
  if (legs.some((l) => l.status === 'lost')) return { status: 'lost' };
  if (legs.some((l) => l.status === 'pending')) return null;
  const winners = legs.filter((l) => l.status === 'won');
  if (!winners.length) return { status: 'push' };
  // Keep the book's price (which may include an SGP adjustment) unless legs dropped out.
  return { status: 'won', settledOdds: winners.length === legs.length ? undefined : parlayOdds(winners) };
}

export interface Summary {
  won: number;
  lost: number;
  push: number;
  pending: number;
  staked: number;
  profit: number;
  yield: number;
}

export function summarize(bets: Bet[]): Summary {
  const s: Summary = { won: 0, lost: 0, push: 0, pending: 0, staked: 0, profit: 0, yield: 0 };
  for (const b of bets) {
    if (b.status === 'pending') s.pending++;
    else if (b.status === 'void') continue;
    else {
      s[b.status]++;
      if (b.status !== 'push') s.staked += b.stake;
      s.profit += profit(b);
    }
  }
  s.yield = s.staked ? s.profit / s.staked : 0;
  return s;
}
