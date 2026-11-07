// The public record's hash chain, shared by the server (which writes it) and the app (which re-checks it).
// Each pick's hash covers everything fixed when it was posted plus the hash before it, so changing or
// removing any earlier pick breaks every hash after it.

export const GENESIS = '0'.repeat(64);

export interface LockedPick {
  seq: number;
  id: string;
  created_at: number;
  start_at: number;
  league: string;
  event_id: string;
  date: string;
  matchup: string;
  market: string;
  side: string;
  line: number | null;
  odds: number;
  selection: string;
  player: string | null;
  stat: string | null;
  units: number;
  reason: string;
  /** 'owner' when posted by hand, 'model' when posted by the pick agent. */
  author: string;
}

export function lockedFields(p: LockedPick) {
  return JSON.stringify([
    p.seq, p.id, p.created_at, p.start_at, p.league, p.event_id, p.date, p.matchup, p.market, p.side,
    p.line, p.odds, p.selection, p.player, p.stat, p.units, p.reason, p.author,
  ]);
}

export async function sha256Hex(text: string) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export const pickHash = (prev: string, p: LockedPick) => sha256Hex(prev + lockedFields(p));
