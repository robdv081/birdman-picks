// The bettor report card: closing line value, parlay autopsy and betting tendencies.
import { LEAGUES } from './espn';
import { clv, MARKET_LABEL, profit, summarize, type Bet, type Leg, type Selection } from './bets';
import { propStat } from './stats';

export interface ClvReport {
  measured: number;
  beat: number;
  avgProb: number | null; // mean price CLV on same-line bets
  avgPoints: number | null; // mean points gained where the line moved
}

export function clvReport(bets: Bet[]): ClvReport {
  const sels = bets.filter((b) => b.status !== 'void').flatMap((b) => (b.legs ?? [b]) as Selection[]);
  const results = sels.map(clv).filter((x): x is NonNullable<ReturnType<typeof clv>> => !!x);
  const probs = results.filter((r) => r.prob != null).map((r) => r.prob!);
  const pts = results.filter((r) => r.points != null).map((r) => r.points!);
  const avg = (a: number[]) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
  return { measured: results.length, beat: results.filter((r) => r.beat).length, avgProb: avg(probs), avgPoints: avg(pts) };
}

/** What kind of leg this is, in words: "Rebounds props", "Spreads", "NHL totals". */
function legType(s: Selection): string {
  if (s.market === 'prop' && s.league && s.stat) return `${propStat(s.league, s.stat)?.label ?? 'Player'} props`;
  return { ml: 'Moneylines', spread: 'Spreads', total: 'Totals' }[s.market as 'ml'] ?? MARKET_LABEL[s.market];
}

export interface Autopsy {
  parlaysSettled: number;
  parlaysLost: number;
  oneLegAway: number; // lost with exactly one losing leg
  legTypes: { label: string; hit: number; total: number }[]; // worst hit rate first
  nearMisses: { label: string; margin: number; date: string }[];
}

// "Close" by market: a point on a spread or total, one unit on most props, a bit more for yardage.
const NEAR: Record<string, number> = { spread: 1.5, total: 1.5, ml: 1, prop: 1 };
const nearFor = (s: Selection) => (s.market === 'prop' && /Yds/.test(s.stat ?? '') ? 5 : NEAR[s.market] ?? 1);

export function autopsy(bets: Bet[]): Autopsy {
  const parlays = bets.filter((b) => b.legs && b.status !== 'pending');
  const lost = parlays.filter((b) => b.status === 'lost');
  const oneLegAway = lost.filter((b) => b.legs!.filter((l) => l.status === 'lost').length === 1).length;

  const legs: Leg[] = parlays.flatMap((b) => b.legs!).filter((l) => l.status === 'won' || l.status === 'lost');
  const types = new Map<string, { hit: number; total: number }>();
  for (const l of legs) {
    const t = types.get(legType(l)) ?? { hit: 0, total: 0 };
    t.total++;
    if (l.status === 'won') t.hit++;
    types.set(legType(l), t);
  }

  const settled: (Selection & { status: string })[] = [
    ...bets.filter((b) => !b.legs && (b.status === 'lost' || b.status === 'won')),
    ...legs,
  ];
  const nearMisses = settled
    .filter((s) => s.status === 'lost' && s.margin != null && -s.margin <= nearFor(s))
    .sort((a, b) => b.date.localeCompare(a.date))
    .slice(0, 5)
    .map((s) => ({ label: s.selection, margin: -s.margin!, date: s.date }));

  return {
    parlaysSettled: parlays.filter((b) => b.status !== 'void').length,
    parlaysLost: lost.length,
    oneLegAway,
    legTypes: [...types.entries()]
      .filter(([, t]) => t.total >= 2)
      .map(([label, t]) => ({ label, ...t }))
      .sort((a, b) => a.hit / a.total - b.hit / b.total),
    nearMisses,
  };
}

export interface Tendency {
  label: string;
  won: number;
  lost: number;
  profit: number;
  yield: number;
}

const MIN_SAMPLE = 3;

/** Groups of settled bets that stand out, best first, then worst. */
export function tendencies(bets: Bet[]): { best: Tendency[]; worst: Tendency[] } {
  const settled = bets.filter((b) => b.status === 'won' || b.status === 'lost' || b.status === 'push');
  const groups = new Map<string, Bet[]>();
  const add = (label: string, b: Bet) => groups.set(label, [...(groups.get(label) ?? []), b]);
  for (const b of settled) {
    if (b.side === 'over') add('Overs', b);
    if (b.side === 'under') add('Unders', b);
    if (!b.legs) add(b.odds < 0 ? 'Favorites' : 'Underdogs', b);
    add(b.legs ? `${b.legs.length >= 4 ? '4+' : b.legs.length}-leg parlays` : legType(b), b);
    const leagues = new Set((b.legs ?? [b]).map((s) => s.league).filter(Boolean));
    if (leagues.size === 1) add(`${LEAGUES[[...leagues][0]!].label} bets`, b);
    if (b.odds >= 300) add('Longshots (+300 or more)', b);
    else if (b.odds <= -200) add('Heavy favorites (-200 or shorter)', b);
  }
  const rows: Tendency[] = [...groups.entries()]
    .filter(([, list]) => list.filter((b) => b.status !== 'push').length >= MIN_SAMPLE)
    .map(([label, list]) => {
      const s = summarize(list);
      return { label, won: s.won, lost: s.lost, profit: list.reduce((p, b) => p + profit(b), 0), yield: s.yield };
    });
  return {
    best: rows.filter((r) => r.profit > 0).sort((a, b) => b.profit - a.profit).slice(0, 3),
    worst: rows.filter((r) => r.profit < 0).sort((a, b) => a.profit - b.profit).slice(0, 3),
  };
}
