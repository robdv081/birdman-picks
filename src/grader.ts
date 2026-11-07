import { fetchScoreboard, fetchSummary, type Game, type GameSummary, type LeagueKey } from './espn';
import { gradeSelection, isGradable, settleParlay, type Bet, type Leg, type Selection } from './bets';
import { fetchCloseOdds, fetchPropBets, fetchRoster, milestoneRungs, type CloseOdds, type Rung } from './market';
import { sameName } from './stats';

const needsClose = (s: Selection) => isGradable(s) && !s.closeChecked && (s.market !== 'prop' || s.side === 'over');
const CLOSE_WINDOW_DAYS = 30;

/** Bets with selections still missing a closing line. */
export function closeKey(bets: Bet[]) {
  const cutoff = new Date(Date.now() - CLOSE_WINDOW_DAYS * 86400_000).toISOString().slice(0, 10);
  return bets
    .filter((b) => b.date >= cutoff && (b.legs ?? [b]).some(needsClose))
    .map((b) => b.id)
    .join(',');
}

/**
 * Records DraftKings' closing price for each linked selection whose game has started. Game lines come from
 * ESPN's odds history; "N+" props from the milestone ladder (overs only: the ladder has no under side).
 */
export async function captureCloses(bets: Bet[]): Promise<Map<string, Partial<Bet>>> {
  const cutoff = new Date(Date.now() - CLOSE_WINDOW_DAYS * 86400_000).toISOString().slice(0, 10);
  const targets = bets.filter((b) => b.date >= cutoff && (b.legs ?? [b]).some(needsClose));
  const sels = targets.flatMap((b) => (b.legs ?? [b]).filter(needsClose));

  const games = new Map<string, Game>();
  await Promise.all(
    [...new Set(sels.map((s) => `${s.league}|${s.date}`))].map(async (k) => {
      const [league, date] = k.split('|') as [LeagueKey, string];
      try {
        for (const g of await fetchScoreboard(league, date)) games.set(g.id, g);
      } catch {
        /* retry later */
      }
    })
  );

  const started = (s: Selection) => {
    const g = games.get(s.eventId!);
    return g && g.state !== 'pre';
  };
  const gameLines = new Map<string, CloseOdds | null>();
  const props = new Map<string, { rungs: Rung[]; ids: Map<string, string> } | null>();
  await Promise.all(
    [...new Set(sels.filter(started).map((s) => `${s.market === 'prop' ? 'p' : 'g'}|${s.eventId}`))].map(async (k) => {
      const [kind, id] = k.split('|');
      const g = games.get(id)!;
      try {
        if (kind === 'g') gameLines.set(id, await fetchCloseOdds(g.league, id));
        else {
          const [items, away, home] = await Promise.all([fetchPropBets(g.league, id), fetchRoster(g.league, g.away.id), fetchRoster(g.league, g.home.id)]);
          props.set(id, { rungs: milestoneRungs(g.league, items), ids: new Map([...away, ...home].map((p) => [p.name, p.id])) });
        }
      } catch {
        if (kind === 'g') gameLines.set(id, null);
        else props.set(id, null);
      }
    })
  );

  const closeFor = (s: Selection): Partial<Selection> | null => {
    if (!started(s)) return null;
    const id = s.eventId!;
    if (s.market === 'prop') {
      const p = props.get(id);
      if (p === undefined) return null;
      const athleteId = p && [...p.ids].find(([name]) => sameName(name, s.player ?? ''))?.[1];
      const rung = p && athleteId && p.rungs.find((r) => r.athleteId === athleteId && r.def.stat === s.stat && r.target === Math.floor(s.line!) + 1);
      return rung ? { closeOdds: rung.odds, closeLine: s.line, closeChecked: true } : { closeChecked: true };
    }
    const c = gameLines.get(id);
    if (c === undefined) return null;
    if (!c) return { closeChecked: true };
    const side =
      s.market === 'ml'
        ? { odds: s.side === 'home' ? c.homeML : s.side === 'away' ? c.awayML : undefined, line: undefined }
        : s.market === 'spread'
          ? s.side === 'home' ? c.homeSpread : c.awaySpread
          : s.side === 'over' ? c.over : c.under;
    return side?.odds != null ? { closeOdds: side.odds, closeLine: side.line, closeChecked: true } : { closeChecked: true };
  };

  const updates = new Map<string, Partial<Bet>>();
  for (const b of targets) {
    if (b.legs) {
      let changed = false;
      const legs = b.legs.map((l) => {
        const c = needsClose(l) ? closeFor(l) : null;
        if (!c) return l;
        changed = true;
        return { ...l, ...c };
      });
      if (changed) updates.set(b.id, { legs });
    } else {
      const c = closeFor(b);
      if (c) updates.set(b.id, c);
    }
  }
  return updates;
}

/** Bets with at least one leg (or themselves) that ESPN data can settle. */
export function gradableKey(bets: Bet[]) {
  return bets
    .filter((b) => b.status === 'pending')
    .flatMap((b) => (b.legs ? b.legs.filter((l) => l.status === 'pending' && isGradable(l)).map((_, i) => `${b.id}.${i}`) : isGradable(b) ? [b.id] : []))
    .join(',');
}

/** Fetches results for every pending, linked selection and returns the patches to apply, keyed by bet id. */
export async function gradePending(bets: Bet[]): Promise<Map<string, Partial<Bet>>> {
  const pending = bets.filter((b) => b.status === 'pending');
  const selections: Selection[] = pending.flatMap((b) =>
    b.legs ? b.legs.filter((l) => l.status === 'pending' && isGradable(l)) : isGradable(b) ? [b] : []
  );

  const games = new Map<string, Game>();
  const days = new Set(selections.map((s) => `${s.league}|${s.date}`));
  await Promise.all(
    [...days].map(async (k) => {
      const [league, date] = k.split('|') as [LeagueKey, string];
      try {
        for (const g of await fetchScoreboard(league, date)) games.set(g.id, g);
      } catch {
        /* retry next tick */
      }
    })
  );

  const summaries = new Map<string, GameSummary>();
  const propGames = new Set(selections.filter((s) => s.market === 'prop' && games.get(s.eventId!)?.completed).map((s) => s.eventId!));
  await Promise.all(
    [...propGames].map(async (id) => {
      const g = games.get(id)!;
      try {
        summaries.set(id, await fetchSummary(g.league, id));
      } catch {
        /* retry next tick */
      }
    })
  );

  const grade = (s: Selection) => {
    const g = s.eventId ? games.get(s.eventId) : undefined;
    return g ? gradeSelection(s, g, summaries.get(g.id)) : null;
  };

  const updates = new Map<string, Partial<Bet>>();
  for (const b of pending) {
    if (b.legs) {
      let changed = false;
      const legs: Leg[] = b.legs.map((l) => {
        if (l.status !== 'pending' || !isGradable(l)) return l;
        const r = grade(l);
        if (!r) return l;
        changed = true;
        return { ...l, ...r };
      });
      if (changed) updates.set(b.id, { legs, ...(settleParlay(b, legs) ?? {}) });
    } else if (isGradable(b)) {
      const r = grade(b);
      if (r) updates.set(b.id, r);
    }
  }
  return updates;
}
