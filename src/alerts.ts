// In-app alerts through the browser's notifications. They fire while the app is open (or was just open);
// alerts with the app fully closed would need a push server, which a static site doesn't have.
import type { BetLive } from './live';
import { load, save } from './store';

const KEY = 'bp.alerts';

export type AlertSupport = 'on' | 'off' | 'blocked' | 'unsupported';

export function alertStatus(): AlertSupport {
  if (!('Notification' in window)) return 'unsupported';
  if (Notification.permission === 'denied') return 'blocked';
  return load(KEY, false) && Notification.permission === 'granted' ? 'on' : 'off';
}

/** Asks for permission (must run from a tap). */
export async function enableAlerts(): Promise<AlertSupport> {
  if (!('Notification' in window)) return 'unsupported';
  const p = await Notification.requestPermission();
  save(KEY, p === 'granted');
  return p === 'granted' ? 'on' : p === 'denied' ? 'blocked' : 'off';
}

export function disableAlerts() {
  save(KEY, false);
}

export async function notify(title: string, body: string, tag: string) {
  if (alertStatus() !== 'on') return;
  try {
    const reg = await navigator.serviceWorker?.getRegistration();
    if (reg) await reg.showNotification(title, { body, tag, icon: 'icon.svg' });
    else new Notification(title, { body, tag, icon: 'icon.svg' });
  } catch {
    /* some browsers refuse page notifications; nothing else to do */
  }
}

type Seen = Map<string, { won: Set<number>; lost: boolean; oneAway: boolean; cashed: boolean }>;

/** Compares this refresh of the sweat board with the last one and alerts on what changed. */
export function alertOnChanges(prev: Seen | null, rows: BetLive[]): Seen {
  const next: Seen = new Map();
  for (const r of rows) {
    const won = new Set(r.legs.map((l, i) => (l.state === 'won' ? i : -1)).filter((i) => i >= 0));
    const total = r.legs.length;
    const state = { won, lost: r.lost > 0, oneAway: !r.lost && total > 1 && total - r.won === 1, cashed: !r.lost && r.won === total };
    next.set(r.bet.id, state);
    const before = prev?.get(r.bet.id);
    if (!prev || !before) continue; // first look: just remember
    const name = r.bet.selection;
    if (state.lost && !before.lost) notify('Busted', `${name}: ${r.legs.find((l) => l.state === 'lost')?.sel.selection ?? 'a leg'} missed.`, `${r.bet.id}-lost`);
    else if (state.cashed && !before.cashed) notify('All legs hit', `${name} is a winner.`, `${r.bet.id}-cashed`);
    else {
      for (const i of won) if (!before.won.has(i)) notify('Leg hit', `${r.legs[i].sel.selection} (${name})`, `${r.bet.id}-leg-${i}`);
      if (state.oneAway && !before.oneAway) {
        const left = r.legs.find((l) => l.state !== 'won');
        notify('One leg away', `${name}: waiting on ${left?.sel.selection ?? 'the last leg'}.`, `${r.bet.id}-oneaway`);
      }
    }
  }
  return next;
}
