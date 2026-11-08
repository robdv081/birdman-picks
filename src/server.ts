// Talking to the Birdman Picks server (the Cloudflare Worker in /server).
import type { LeagueKey } from './espn';
import { GENESIS, pickHash, type LockedPick } from './recordhash';
import { load, save } from './store';

/**
 * The server's address. Set VITE_SERVER_URL as a GitHub Actions variable, or paste it here.
 * While it's empty, the Record and Pick'em tabs explain that they're coming soon.
 */
export const SERVER_URL: string = (import.meta.env.VITE_SERVER_URL as string | undefined)?.replace(/\/+$/, '') ?? '';
export const serverReady = () => !!SERVER_URL;

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export async function api<T>(path: string, opts: { method?: string; body?: unknown; headers?: Record<string, string> } = {}): Promise<T> {
  if (!SERVER_URL) throw new ApiError(0, "The Birdman server isn't connected yet.");
  let res: Response;
  try {
    res = await fetch(SERVER_URL + path, {
      method: opts.method ?? 'GET',
      headers: { ...(opts.body ? { 'Content-Type': 'application/json' } : {}), ...opts.headers },
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
  } catch {
    throw new ApiError(0, "Couldn't reach the server. Check your connection.");
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, (data as { error?: string }).error || `Server error ${res.status}`);
  return data as T;
}

/** True once a Scout research publisher is connected on the server. Until then the Scout tab stays hidden. */
export async function scoutEnabled(): Promise<boolean> {
  if (!SERVER_URL) return false;
  try {
    return (await api<{ enabled: boolean }>('/api/scout/enabled')).enabled === true;
  } catch {
    return false;
  }
}

// ---------- the verified record ----------

export interface RecordPick {
  seq: number;
  id: string;
  createdAt: number;
  startAt: number;
  league: LeagueKey;
  eventId: string;
  date: string;
  matchup: string;
  market: 'ml' | 'spread' | 'total' | 'prop';
  side: string;
  line: number | null;
  odds: number;
  selection: string;
  player: string | null;
  stat: string | null;
  units: number;
  reason: string;
  /** 'owner' (posted by hand) or 'model' (posted by the pick agent). */
  author: string;
  /** Before its game starts, a pick is sealed for non-members: only that it's locked, for which sport and when. */
  sealed?: boolean;
  prevHash: string;
  hash: string;
  status: 'pending' | 'won' | 'lost' | 'push' | 'void';
  finalScore: string | null;
  margin: number | null;
  closeOdds: number | null;
  closeLine: number | null;
}

export interface RecordSummary {
  won: number;
  lost: number;
  push: number;
  pending: number;
  units: number;
  roi: number;
  clvMeasured: number;
  clvBeat: number;
}

/** Pro members (and the owner) get picks before their games start; everyone else sees them sealed until then. */
export const fetchRecord = (bearer = '') =>
  api<{ picks: RecordPick[]; summary: RecordSummary; sealed?: boolean }>('/api/record', bearer ? { headers: { Authorization: `Bearer ${bearer}` } } : {});

const locked = (p: RecordPick): LockedPick => ({
  seq: p.seq,
  id: p.id,
  created_at: p.createdAt,
  start_at: p.startAt,
  league: p.league,
  event_id: p.eventId,
  date: p.date,
  matchup: p.matchup,
  market: p.market,
  side: p.side,
  line: p.line,
  odds: p.odds,
  selection: p.selection,
  player: p.player,
  stat: p.stat,
  units: p.units,
  reason: p.reason,
  author: p.author,
});

/**
 * Re-checks the whole chain on this phone. A sealed pick can't be re-hashed until it's revealed, but it still has
 * to link to the pick before it, and the next pick has to link to it.
 */
export async function verifyChain(picks: RecordPick[]): Promise<{ ok: boolean; brokenAt?: number; sealed: number }> {
  const inOrder = [...picks].sort((a, b) => a.seq - b.seq);
  let prev = GENESIS;
  let sealed = 0;
  for (let i = 0; i < inOrder.length; i++) {
    const p = inOrder[i];
    if (p.seq !== i + 1 || p.prevHash !== prev) return { ok: false, brokenAt: p.seq, sealed };
    if (p.sealed) sealed++;
    else if ((await pickHash(prev, locked(p))) !== p.hash) return { ok: false, brokenAt: p.seq, sealed };
    prev = p.hash;
  }
  return { ok: true, sealed };
}

const OWNER_KEY = 'bp.ownerKey';
export const ownerKey = () => load<string>(OWNER_KEY, '');
export const setOwnerKey = (k: string) => save(OWNER_KEY, k);
export const checkOwnerKey = (k: string) => api<{ owner: boolean }>('/api/record/owner', { headers: { Authorization: `Bearer ${k}` } });

export interface NewPick {
  league: LeagueKey;
  eventId: string;
  date: string;
  market: string;
  side: string;
  line?: number;
  odds: number;
  units: number;
  reason: string;
  player?: string;
  stat?: string;
}

export const postRecordPick = (p: NewPick) =>
  api<{ pick: RecordPick }>('/api/record/picks', { method: 'POST', body: p, headers: { Authorization: `Bearer ${ownerKey()}` } });

// ---------- pick'em ----------

export interface PoolLink {
  code: string;
  token: string;
  name?: string;
  league?: LeagueKey;
}

const POOLS_KEY = 'bp.pools';
export const myPools = () => load<PoolLink[]>(POOLS_KEY, []);
export function rememberPool(p: PoolLink) {
  save(POOLS_KEY, [p, ...myPools().filter((x) => x.code !== p.code)]);
}
export function forgetPool(code: string) {
  save(POOLS_KEY, myPools().filter((x) => x.code !== code));
}

export interface Standing {
  name: string;
  me: boolean;
  week: { right: number; wrong: number };
  all: { right: number; wrong: number };
}

export interface PoolView {
  pool: { code: string; name: string; league: LeagueKey };
  me: string;
  date: string;
  weekStart: string;
  standings: Standing[];
  mine: Record<string, { side: string; result: string | null }>;
  revealed: Record<string, { name: string; side: string; label: string; result: string | null }[]>;
}

export const createPool = (name: string, league: LeagueKey, player: string) =>
  api<{ code: string; token: string }>('/api/pools', { method: 'POST', body: { name, league, player } });
export const joinPool = (code: string, player: string) => api<{ code: string; token: string }>('/api/pools/join', { method: 'POST', body: { code, player } });
export const getPool = (p: PoolLink, date: string) => api<PoolView>(`/api/pools/${p.code}?date=${date}`, { headers: { 'X-Pool-Token': p.token } });
export const savePoolPick = (p: PoolLink, eventId: string, date: string, side: string) =>
  api<{ saved: boolean }>(`/api/pools/${p.code}/picks`, { method: 'PUT', body: { eventId, date, side }, headers: { 'X-Pool-Token': p.token } });
