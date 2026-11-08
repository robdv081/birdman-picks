// Tilt detector: notices the patterns that usually mean someone is chasing, and offers a break. Everything stays
// on this phone. It never blocks a bet; a break is the bettor's own choice and they can end it.
import { useEffect, useState } from 'react';
import { profit, type Bet } from './bets';
import { load, save } from './store';

export interface TiltSignal {
  key: 'stake' | 'chase' | 'late' | 'volume' | 'parlay';
  text: string;
}

const DAY = 86400_000;
const localDay = (ms: number) => new Date(ms).toDateString();
const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : 0;
};

export function tiltSignals(bets: Bet[], now = Date.now()): TiltSignal[] {
  const list = bets.filter((b) => b.status !== 'void').map((b) => ({ b, t: Date.parse(b.createdAt) })).filter((x) => Number.isFinite(x.t) && x.t <= now + 60_000);
  list.sort((a, b) => b.t - a.t);
  const out: TiltSignal[] = [];
  const today = list.filter((x) => localDay(x.t) === localDay(now));
  const yesterday = list.filter((x) => localDay(x.t) === localDay(now - DAY));
  const net = (xs: typeof list) => xs.reduce((n, x) => n + profit(x.b), 0);
  const lostToday = today.filter((x) => x.b.status === 'lost').length;

  // A much bigger bet than usual, tracked in the last day.
  const latest = list[0];
  const history = list.slice(1, 21).map((x) => x.b.stake);
  if (latest && now - latest.t < DAY && history.length >= 5) {
    const m = median(history);
    if (m > 0 && latest.b.stake >= 2 * m) out.push({ key: 'stake', text: `Your latest bet is ${(latest.b.stake / m).toFixed(1)}× your usual stake.` });
  }
  // Betting fast on a losing day.
  const lastTwoHours = list.filter((x) => now - x.t < 2 * 3600_000).length;
  if (lostToday >= 2 && net(today) < 0 && lastTwoHours >= 3) out.push({ key: 'chase', text: `${lostToday} losses today and ${lastTwoHours} new bets in the last two hours. That's the classic chase.` });
  // Late nights.
  const late = list.filter((x) => now - x.t < DAY && new Date(x.t).getHours() < 5).length;
  if (late >= 2) out.push({ key: 'late', text: `${late} bets placed between midnight and 5 AM.` });
  // Way more bets than usual today.
  const days = new Set(list.filter((x) => now - x.t < 30 * DAY).map((x) => localDay(x.t)));
  const avg = days.size ? list.filter((x) => now - x.t < 30 * DAY).length / days.size : 0;
  if (today.length >= 6 && today.length >= 2 * avg) out.push({ key: 'volume', text: `${today.length} bets today, about ${(today.length / Math.max(avg, 1)).toFixed(1)}× your usual day.` });
  // A parlay to win it back.
  const parlayToday = today.some((x) => x.b.market === 'parlay');
  if (parlayToday && (net(yesterday) < 0 || (lostToday >= 1 && net(today) < 0)))
    out.push({ key: 'parlay', text: 'A parlay right after a losing stretch is often a try to win it all back at once.' });
  return out;
}

const SNOOZE = 'bp.tilt.snooze';
const BREAK = 'bp.break';

export function useTilt(bets: Bet[]) {
  const [snoozed, setSnoozed] = useState(() => load<number>(SNOOZE, 0) > Date.now());
  const [breakUntil, setBreakUntil] = useState(() => load<number>(BREAK, 0));
  useEffect(() => {
    const t = setInterval(() => setSnoozed(load<number>(SNOOZE, 0) > Date.now()), 60_000);
    return () => clearInterval(t);
  }, []);
  const signals = tiltSignals(bets);
  return {
    signals: snoozed ? [] : signals,
    onBreak: breakUntil > Date.now(),
    breakUntil,
    snooze: () => {
      save(SNOOZE, Date.now() + 12 * 3600_000);
      setSnoozed(true);
    },
    takeBreak: (hours: number) => {
      const until = Date.now() + hours * 3600_000;
      save(BREAK, until);
      setBreakUntil(until);
    },
    endBreak: () => {
      save(BREAK, 0);
      setBreakUntil(0);
    },
  };
}

export const onBreakUntil = () => {
  const u = load<number>(BREAK, 0);
  return u > Date.now() ? u : 0;
};
