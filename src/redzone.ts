// Red Zone alerts: a heads-up when a football game you care about gets inside the 20.
// "Care about" = a pending bet or parlay leg on the game, or a game starred on the Scores tab.
import { useEffect, useRef, useState } from 'react';
import { fetchScoreboard, type Game, type LeagueKey } from './espn';
import type { Bet } from './bets';
import { notify } from './alerts';
import { load, save } from './store';

const FOOTBALL: LeagueKey[] = ['nfl', 'cfb'];
const STAR_KEY = 'bp.starred';
const ON_KEY = 'bp.redzone';
const POLL_MS = 30_000;

export interface Starred {
  id: string;
  league: LeagueKey;
  date: string;
}

export const loadStars = () => load<Starred[]>(STAR_KEY, []);

/** Starred football games, shared by every card that shows a star. */
export function useStars() {
  const [stars, setStars] = useState<Starred[]>(loadStars);
  useEffect(() => {
    const sync = () => setStars(loadStars());
    window.addEventListener('bp-stars', sync);
    return () => window.removeEventListener('bp-stars', sync);
  }, []);
  const toggle = (s: Starred) => {
    const now = loadStars();
    const next = now.some((x) => x.id === s.id) ? now.filter((x) => x.id !== s.id) : [...now, s];
    // Keep the list small: drop stars older than a week.
    const cutoff = new Date(Date.now() - 7 * 86400_000).toISOString().slice(0, 10);
    save(STAR_KEY, next.filter((x) => x.date >= cutoff));
    window.dispatchEvent(new Event('bp-stars'));
  };
  return { isStarred: (id: string) => stars.some((s) => s.id === id), toggle };
}

export const redZoneOn = () => load(ON_KEY, true);
export const setRedZoneOn = (on: boolean) => save(ON_KEY, on);

/** Football games to watch: pending bets and legs on NFL/CFB games, plus stars. */
export function watchList(bets: Bet[], stars: Starred[]): Starred[] {
  const out = new Map<string, Starred>();
  for (const b of bets) {
    if (b.status !== 'pending') continue;
    for (const s of b.legs ?? [b]) {
      if ('status' in s && s.status !== 'pending') continue;
      if (s.eventId && s.league && FOOTBALL.includes(s.league)) out.set(s.eventId, { id: s.eventId, league: s.league, date: s.date });
    }
  }
  for (const s of stars) out.set(s.id, s);
  return [...out.values()];
}

/** The alert text for a game that just got inside the 20. */
export function redZoneMessage(g: Game) {
  const sit = g.situation!;
  const team = sit.possession ?? 'Offense';
  const score = `${g.away.abbr} ${g.away.score ?? 0} – ${g.home.abbr} ${g.home.score ?? 0}`;
  return {
    title: `🚨 Red Zone: ${team} ball`,
    body: [sit.text, score, g.detail].filter(Boolean).join(' · '),
  };
}

type Seen = Map<string, string>; // game id → drive key while in the red zone

/**
 * Compares this look with the last one. A new alert fires when a team enters the red zone,
 * or when the other team takes the ball inside the 20 (a turnover in the red zone).
 */
export function redZoneChanges(prev: Seen, games: Game[]): { next: Seen; entered: Game[] } {
  const next: Seen = new Map();
  const entered: Game[] = [];
  for (const g of games) {
    const sit = g.situation;
    if (g.state !== 'in' || !sit?.redZone) continue;
    const drive = `${sit.possession ?? '?'}|${g.period ?? ''}`;
    next.set(g.id, drive);
    const before = prev.get(g.id);
    if (before?.split('|')[0] !== drive.split('|')[0]) entered.push(g);
  }
  return { next, entered };
}

/** Polls watched football games while the app is open and alerts on red-zone trips. */
export function useRedZone(bets: Bet[]) {
  const [stars, setStars] = useState<Starred[]>(loadStars);
  const seen = useRef<Seen | null>(null);
  const [live, setLive] = useState<Game[]>([]);

  useEffect(() => {
    const sync = () => setStars(loadStars());
    window.addEventListener('bp-stars', sync);
    return () => window.removeEventListener('bp-stars', sync);
  }, []);

  const watch = watchList(bets, stars);
  const key = watch.map((w) => w.id).sort().join(',');

  useEffect(() => {
    if (!key) {
      setLive([]);
      return;
    }
    const ids = new Set(key.split(','));
    const boards = [...new Set(watch.map((w) => `${w.league}|${w.date}`))];
    let cancelled = false;
    async function run() {
      if (document.hidden) return;
      const lists = await Promise.all(
        boards.map((b) => {
          const [lg, date] = b.split('|') as [LeagueKey, string];
          return fetchScoreboard(lg, date).catch(() => [] as Game[]);
        })
      );
      if (cancelled) return;
      const games = lists.flat().filter((g) => ids.has(g.id));
      setLive(games.filter((g) => g.state === 'in'));
      const { next, entered } = redZoneChanges(seen.current ?? new Map(), games);
      // First look after opening the app: remember, don't alert on a drive already underway.
      if (seen.current && redZoneOn()) {
        for (const g of entered) {
          const m = redZoneMessage(g);
          notify(m.title, m.body, `rz-${g.id}-${next.get(g.id)}`);
        }
      }
      seen.current = next;
    }
    run();
    const t = setInterval(run, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps

  return live;
}
