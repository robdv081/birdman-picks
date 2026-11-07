// Bankroll guardrails: a weekly limit on how much you put in play, with a warning before you go over.
import type { Bet } from './bets';
import { load } from './store';
import type { Settings } from './components/Bets';

/** Monday 00:00 of the current week, local time. */
export function weekStartDate(now = new Date()) {
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return d;
}

/** Units put in play since Monday (by when the bet was tracked), not counting voided bets. */
export function stakedThisWeek(bets: Bet[], now = new Date(), skipId?: string) {
  const from = weekStartDate(now).getTime();
  return bets
    .filter((b) => b.id !== skipId && b.status !== 'void' && Date.parse(b.createdAt) >= from)
    .reduce((sum, b) => sum + b.stake, 0);
}

export const weeklyLimit = () => load<Settings>('bp.settings', { unitSize: 0 }).weeklyLimit ?? 0;

export interface GuardCheck {
  limit: number;
  before: number;
  after: number;
  over: boolean;
}

/** Where a new stake would leave you against your weekly limit; null when no limit is set. */
export function checkStake(bets: Bet[], stake: number, skipId?: string, limit = weeklyLimit()): GuardCheck | null {
  if (!limit || !(stake > 0)) return null;
  const before = stakedThisWeek(bets, new Date(), skipId);
  const after = before + stake;
  return { limit, before, after, over: after > limit + 1e-9 };
}

export const HELPLINE = '1-800-GAMBLER';
